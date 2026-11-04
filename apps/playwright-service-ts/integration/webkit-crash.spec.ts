import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { listen, closeServer, scrape, startService } from "./support";

const enabled = process.env.TEST_WEBKIT === "true";
for (const headless of ["true", "false"])
  test(
    `a confirmed renderer crash is typed, closes its page and leaves the owner usable (headless=${headless})`,
    { skip: !enabled, timeout: 30000 },
    async (t) => {
      assert.ok(
        existsSync("/.dockerenv"),
        "fault injection requires a dedicated Docker PID namespace",
      );
      let received!: () => void;
      const requested = new Promise<void>((resolve) => {
        received = resolve;
      });
      const fixture = http.createServer((req, res) => {
        res.setHeader("content-type", "text/html");
        if (req.url === "/crash") {
          res.write("<main>Owned renderer fault fixture</main>");
          received();
          // Keep navigation pending until the owned renderer is terminated.
        } else res.end("<main>Fresh renderer recovered content 42</main>");
      });
      const port = await listen(fixture);
      let service: Awaited<ReturnType<typeof startService>> | undefined;
      let pending: ReturnType<typeof scrape> | undefined;
      try {
        service = await startService({
          BROWSER_ENGINE: "webkit",
          BROWSER_CHANNEL: "",
          BROWSER_HEADLESS: headless,
          MAX_CONCURRENT_PAGES: "1",
        });
        const url = `http://webkit-fixture.test:${port}`;
        pending = scrape(service.baseUrl, url + "/crash", {
          timeout: 10000,
          wait_after_load: 0,
          max_attempts: 1,
        });
        void pending.catch(() => {});
        let waitTimer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            requested,
            new Promise((_, reject) => {
              waitTimer = setTimeout(
                () => reject(new Error("Owned fixture was not requested")),
                5000,
              );
            }),
          ]);
        } finally {
          clearTimeout(waitTimer);
        }
        let renderers: { pid: number; status: string }[] = [];
        for (let i = 0; i < 30 && !renderers.length; i++) {
          renderers = readdirSync("/proc")
            .filter((p) => /^[0-9]+$/.test(p))
            .flatMap((p) => {
              try {
                const status = readFileSync("/proc/" + p + "/status", "utf8");
                return /^Name:\s*(?:WPEWebProcess|WebKitWebProces)/m.test(
                  status,
                )
                  ? [{ pid: Number(p), status }]
                  : [];
              } catch {
                return [];
              }
            });
          if (!renderers.length)
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const inventory = readdirSync("/proc")
          .filter((p) => /^[0-9]+$/.test(p))
          .flatMap((p) => {
            try {
              const status = readFileSync("/proc/" + p + "/status", "utf8");
              return /^Uid:\s*1000\s/m.test(status)
                ? [
                    {
                      pid: Number(p),
                      name: status.match(/^Name:\s*(.+)$/m)?.[1],
                      command: readFileSync(
                        "/proc/" + p + "/cmdline",
                        "utf8",
                      ).replace(/\0/g, " "),
                    },
                  ]
                : [];
            } catch {
              return [];
            }
          });
        assert.equal(
          renderers.length,
          1,
          "only the owned single-page renderer may be terminated: " +
            JSON.stringify(inventory),
        );
        assert.match(
          renderers[0].status,
          /^Uid:\s*1000\s+1000\s+1000\s+1000$/m,
        );
        assert.match(renderers[0].status, /^CapEff:\s*0+$/m);
        process.kill(renderers[0].pid, "SIGKILL");
        const result = await pending;
        t.diagnostic(
          JSON.stringify({
            event: "ownedRendererFault",
            signal: "SIGKILL",
            pid: renderers[0].pid,
            result: result.body,
          }),
        );
        assert.equal(result.status, 500);
        assert.equal(result.body.errorCode, "PAGE_CRASHED");
        assert.equal(result.body.networkErrorCode, undefined);
        assert.equal(result.body.diagnostics.attempts.length, 1);
        assert.equal(
          result.body.diagnostics.attempts[0].document.rendererCrashed,
          true,
        );
        assert.equal(result.body.diagnostics.attempts[0].pageClosed, true);
        const next = await scrape(service.baseUrl, url + "/healthy", {
          timeout: 5000,
          wait_after_load: 0,
        });
        assert.equal(next.status, 200);
        assert.match(
          next.body.renderedText,
          /Fresh renderer recovered content 42/,
        );
        const health = await (await fetch(service.baseUrl + "/health")).json();
        assert.equal(health.activePages, 0);
        assert.equal(health.browserSessions, 0);
      } finally {
        await service?.stop();
        await pending?.catch(() => {});
        await closeServer(fixture);
      }
    },
  );
