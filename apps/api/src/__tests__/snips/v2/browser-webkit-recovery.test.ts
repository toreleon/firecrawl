import http from "node:http";
import http2 from "node:http2";
import tls from "node:tls";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../../../config";
import { scrapeTimeout } from "./lib";
import { itIf, TEST_API_URL, TEST_SELF_HOST } from "../lib";

const enabled =
  TEST_SELF_HOST && process.env.TEST_WEBKIT_RECOVERY_API === "true";
describe("Full API WebKit resources and confirmed navigation termination", () => {
  const httpPort = Number(process.env.TEST_WEBKIT_FIXTURE_PORT ?? 33391);
  const tlsPort = Number(process.env.TEST_WEBKIT_TLS_FIXTURE_PORT ?? 33392);
  const prematurePort = Number(process.env.TEST_WEBKIT_PREMATURE_PORT ?? 33394);
  const origin = `http://host.docker.internal:${httpPort}`;
  const tlsOrigin = `https://host.docker.internal:${tlsPort}`;
  const calls = { blob: 0, webkit: 0, firefox: 0 };
  const sockets = new Set<tls.TLSSocket>();
  const byPort = new Map<number, tls.TLSSocket>();
  const prematureSockets = new Set<net.Socket>();
  let directory: string | undefined,
    ordinary: http.Server | undefined,
    secure: http2.Http2SecureServer | undefined,
    premature: net.Server | undefined;
  beforeAll(async () => {
    if (!enabled) return;
    const token = config.BROWSER_SERVICE_AUTH_TOKEN;
    const headers = token ? { authorization: `Bearer ${token}` } : undefined;
    for (const [urls, engine] of [
      [config.LOCAL_BROWSER_OWNER_URLS, "webkit"],
      [config.LOCAL_BROWSER_FALLBACK_OWNER_URLS, "camoufox"],
    ]) {
      const list = urls!.split(",");
      expect(list).toHaveLength(1);
      const health = await (
        await fetch(list[0] + "/health", { headers })
      ).json();
      expect(health.browserEngine).toBe(engine);
    }
    directory = mkdtempSync(
      path.join(tmpdir(), "firecrawl-webkit-api-fixture-"),
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=host.docker.internal",
        "-keyout",
        path.join(directory, "key.pem"),
        "-out",
        path.join(directory, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    ordinary = http.createServer((req, res) => {
      if (req.url === "/blob-data") {
        calls.blob++;
        return res.end("Owned blob API content 42");
      }
      const worker = `fetch(${JSON.stringify(origin + "/blob-data")}).then(r=>r.text()).then(text=>postMessage(text))`;
      res.setHeader("content-type", "text/html");
      res.end(
        `<main id="record">Loading...</main><script>const worker=new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker)}],{type:'text/javascript'})));worker.onmessage=event=>{document.querySelector('#record').textContent=event.data;worker.terminate()};</script>`,
      );
    });
    secure = http2.createSecureServer({
      allowHTTP1: true,
      key: readFileSync(path.join(directory, "key.pem")),
      cert: readFileSync(path.join(directory, "cert.pem")),
    });
    secure.on("secureConnection", socket => {
      const port = socket.remotePort!;
      sockets.add(socket);
      byPort.set(port, socket);
      socket.on("error", () => {});
      socket.once("close", () => {
        sockets.delete(socket);
        byPort.delete(port);
      });
    });
    secure.on("tlsClientError", () => {});
    secure.on("sessionError", () => {});
    secure.on("request", (req, res) => {
      if (/Firefox\//.test(req.headers["user-agent"] ?? "")) {
        calls.firefox++;
        res.setHeader("content-type", "text/html");
        return res.end("<main>Owned alternate API content 42</main>");
      }
      calls.webkit++;
      // End TLS cleanly before sending HTTP response headers. No synthetic
      // browser error, invalid certificate override or captured-content hint.
      const socket =
        req.httpVersionMajor === 1
          ? req.socket
          : byPort.get(req.socket.remotePort!)!;
      socket.end();
    });
    secure.on("stream", stream => stream.on("error", () => {}));
    premature = net.createServer(socket => {
      prematureSockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => prematureSockets.delete(socket));
      // Close after ClientHello, before any certificate or HTTP response.
      socket.once("data", () => socket.end());
    });
    await Promise.all([
      new Promise<void>(resolve =>
        ordinary!.listen(httpPort, "0.0.0.0", resolve),
      ),
      new Promise<void>(resolve => secure!.listen(tlsPort, "0.0.0.0", resolve)),
      new Promise<void>(resolve =>
        premature!.listen(prematurePort, "0.0.0.0", resolve),
      ),
    ]);
  });
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    for (const socket of prematureSockets) socket.destroy();
    if (ordinary)
      await new Promise<void>(resolve => {
        ordinary!.close(() => resolve());
        ordinary!.closeAllConnections();
      });
    if (secure)
      await new Promise<void>(resolve => secure!.close(() => resolve()));
    if (premature)
      await new Promise<void>(resolve => premature!.close(() => resolve()));
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const request = async (url: string, extra: Record<string, unknown> = {}) => {
    const response = await fetch(TEST_API_URL + "/v2/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        formats: ["rawHtml", "markdown"],
        timeout: 30000,
        browserControls: { workflow: "auto", navigationTimeout: 8000 },
        ...extra,
      }),
      signal: AbortSignal.timeout(scrapeTimeout),
    });
    return { status: response.status, body: await response.json() };
  };
  itIf(enabled)(
    "renders a blob-backed worker through the full scrape API",
    async () => {
      const result = await request(origin + "/blob-worker", {
        browserControls: {
          workflow: "auto",
          readiness: { text: "Owned blob API content 42", timeoutMs: 2000 },
        },
      });
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect(result.body.data.markdown).toContain("Owned blob API content 42");
      expect(result.body.data.metadata.browser.interaction.state).toBe(
        "CONTENT_READY",
      );
      expect(
        result.body.data.metadata.browser.diagnostics.blockedRequests.private,
      ).toBe(0);
      expect(calls.blob).toBe(1);
      expect(
        result.body.data.metadata.browser.diagnostics.attempts[0],
      ).toMatchObject({ pageClosed: true, contextClosed: true });
    },
  );
  itIf(enabled)(
    "recovers an actual closed WebKit navigation EOF on Firefox exactly once",
    async () => {
      const before = { ...calls };
      const result = await request(tlsOrigin, {
        skipTlsVerification: true,
        browserControls: { workflow: "auto", engineFallback: true },
      });
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect(result.body.data.markdown).toContain(
        "Owned alternate API content 42",
      );
      const fallback =
        result.body.data.metadata.browser.diagnostics.engineFallback;
      expect(fallback.recovered).toBe(true);
      expect(fallback.attempts).toHaveLength(2);
      expect(fallback.attempts[0].engine).toBe("webkit");
      expect(fallback.attempts[0].errorCode).toBe("NETWORK_ERROR");
      expect(fallback.attempts[0].pageClosed).toBe(true);
      expect(
        fallback.attempts.every(
          (attempt: any) => attempt.contextClosed === true,
        ),
      ).toBe(true);
      expect(fallback.attempts[1].engine).toBe("camoufox");
      expect(calls.webkit - before.webkit).toBe(1);
      expect(calls.firefox - before.firefox).toBe(1);
    },
  );
  itIf(enabled)(
    "types premature TLS termination and dispatches only one opted-in alternate without a TLS exception",
    async () => {
      const url = `https://host.docker.internal:${prematurePort}`;
      const optout = await request(url, { skipTlsVerification: false });
      expect(optout.status).toBe(500);
      expect(optout.body.code).toBe("NETWORK_ERROR");
      expect(optout.body.diagnostics.attempts).toHaveLength(1);
      expect(optout.body.diagnostics.attempts[0]).toMatchObject({
        engine: "webkit",
        networkErrorCode: "WEBKIT_TLS_HANDSHAKE_TERMINATED",
        pageClosed: true,
        contextClosed: true,
      });
      const opted = await request(url, {
        skipTlsVerification: false,
        browserControls: { workflow: "auto", engineFallback: true },
      });
      expect(opted.status).toBeGreaterThanOrEqual(400);
      expect(opted.body.success).toBe(false);
      const fallback = opted.body.diagnostics.engineFallback;
      expect(fallback.attempted).toBe(true);
      expect(fallback.recovered).toBe(false);
      expect(fallback.attempts).toHaveLength(2);
      expect(fallback.attempts[0]).toMatchObject({
        engine: "webkit",
        networkErrorCode: "WEBKIT_TLS_HANDSHAKE_TERMINATED",
        pageClosed: true,
        contextClosed: true,
      });
      expect(fallback.attempts[1]).toMatchObject({
        engine: "camoufox",
        pageClosed: true,
        contextClosed: true,
      });
    },
  );
  itIf(enabled)(
    "does not recover EOF without opt-in or bypass certificate rejection",
    async () => {
      let before = { ...calls };
      const optout = await request(tlsOrigin, { skipTlsVerification: true });
      expect(optout.status).toBeGreaterThanOrEqual(400);
      expect(optout.body.success).toBe(false);
      expect(optout.body.diagnostics.attempts[0]).toMatchObject({
        pageClosed: true,
        contextClosed: true,
      });
      expect(calls.webkit - before.webkit).toBe(1);
      expect(calls.firefox).toBe(before.firefox);
      before = { ...calls };
      const certificate = await request(tlsOrigin, {
        skipTlsVerification: false,
        browserControls: { workflow: "auto", engineFallback: true },
      });
      expect(certificate.status).toBeGreaterThanOrEqual(400);
      expect(certificate.body.success).toBe(false);
      expect(calls.webkit).toBe(before.webkit);
      expect(calls.firefox).toBe(before.firefox);
      const invalid = await request("blob:" + origin + "/owned");
      expect(invalid.status).toBe(400);
      expect(invalid.body.success).toBe(false);
    },
  );
});
