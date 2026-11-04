import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "../../config";
import { closeLocalBrowser, createLocalBrowser } from "./client";
import {
  closeLocalStore,
  getLocalSession,
  initializeLocalStore,
  localOperation,
  localPool,
  reserveLocalSession,
  seal,
  unseal,
} from "./store";

describe.skipIf(
  !config.LOCAL_BROWSER_SESSION_SECRET || !config.LOCAL_BROWSER_DATABASE_URL,
)("Local browser ownership with real PostgreSQL", () => {
  const team = `browser-test-${randomUUID()}`;
  const make = async () => {
    const id = await reserveLocalSession(
      team,
      "https://example.com",
      "http://owner.test",
      "boot-one",
      300000,
      { token: "private-capability" },
    );
    await localPool().query(
      "UPDATE firecrawl_local_browser_sessions SET state='READY' WHERE id=$1",
      [id],
    );
    return id;
  };
  beforeAll(initializeLocalStore);
  afterAll(async () => {
    await localPool().query(
      "DELETE FROM firecrawl_local_browser_sessions WHERE team_id=$1",
      [team],
    );
    await closeLocalStore();
  });
  it("excludes a second process and returns a completed operation without redispatch", async () => {
    const id = await make();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const active = localOperation(
      team,
      id,
      "first",
      { action: "click" },
      "scrape",
      async () => {
        entered();
        await gate;
        return { result: 42 };
      },
    );
    await started;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `const s=require('./src/lib/local-browser/store.ts');s.localOperation(process.env.BROWSER_TEST_TEAM,process.env.BROWSER_TEST_ID,'other',{},'scrape',async()=>{throw Error('duplicate dispatch')}).then(()=>process.stdout.write('WRONG')).catch(e=>process.stdout.write(e.code)).finally(()=>s.closeLocalStore())`,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, BROWSER_TEST_TEAM: team, BROWSER_TEST_ID: id },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", chunk => (output += chunk));
    child.stderr.on("data", chunk => (output += chunk));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", code =>
          code === 0 ? resolve() : reject(Error(output)),
        );
      });
      expect(output).toContain("SESSION_BUSY");
    } finally {
      release();
    }
    expect(await active).toEqual({ result: 42 });
    expect(
      await localOperation(
        team,
        id,
        "first",
        { action: "click" },
        "scrape",
        async () => {
          throw Error("replayed");
        },
      ),
    ).toEqual({ result: 42 });
    await expect(
      localOperation(
        team,
        id,
        "first",
        { action: "different" },
        "scrape",
        async () => ({}),
      ),
    ).rejects.toMatchObject({ code: "OPERATION_MISMATCH" });
  });
  it("binds tenants and treats uncertain external effects as terminal", async () => {
    const id = await make();
    await expect(getLocalSession("other-team", id)).rejects.toMatchObject({
      code: "SESSION_UNKNOWN",
    });
    await expect(
      localOperation(team, id, "uncertain", {}, "scrape", async () => {
        throw Error("response lost after click");
      }),
    ).rejects.toThrow("response lost");
    expect((await getLocalSession(team, id)).state).toBe("LOST");
    await expect(
      localOperation(team, id, "new", {}, "scrape", async () => ({})),
    ).rejects.toMatchObject({ code: "SESSION_LOST" });
  });
  it("does not publish completion after a concurrent close, and rejects expiry", async () => {
    const id = await make();
    await expect(
      localOperation(team, id, "closed", {}, "scrape", async () => {
        await localPool().query(
          "UPDATE firecrawl_local_browser_sessions SET state='CLOSING' WHERE id=$1",
          [id],
        );
        return { content: "late" };
      }),
    ).rejects.toMatchObject({ code: "SESSION_STALE" });
    expect((await getLocalSession(team, id)).state).toBe("CLOSING");
    const expired = await make();
    await localPool().query(
      "UPDATE firecrawl_local_browser_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [expired],
    );
    await expect(
      localOperation(team, expired, "expired", {}, "scrape", async () => ({})),
    ).rejects.toMatchObject({ code: "SESSION_LOST" });
    const encrypted = seal({ token: "private-secret" });
    expect(encrypted).not.toContain("private-secret");
    expect(unseal(encrypted)).toEqual({ token: "private-secret" });
  });
  it("lets close win an in-flight creation and disposes a late capability", async () => {
    const originalOwners = config.LOCAL_BROWSER_OWNER_URLS;
    config.LOCAL_BROWSER_OWNER_URLS = "http://creation-race-owner.test";
    const disposed: string[] = [];
    let closedId = "";
    let loseResponse = false;
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === "/health")
          return Response.json({
            status: "healthy",
            ownerBootId: "creation-race-owner",
            capabilities: { version: 1, actions: [] },
          });
        if (init?.method === "DELETE") {
          disposed.push(path);
          return new Response(null, { status: 204 });
        }
        expect(path).toBe("/scrape");
        const pending = await localPool().query(
          "SELECT id FROM firecrawl_local_browser_sessions WHERE team_id=$1 AND state='CREATING'",
          [team],
        );
        expect(pending.rowCount).toBe(1);
        closedId = pending.rows[0].id;
        await closeLocalBrowser(team, closedId);
        if (loseResponse) throw Error("creation response lost after close");
        return Response.json({
          content: "late document",
          pageStatusCode: 200,
          sessionId: "a".repeat(64),
          sessionExpiresAt: Date.now() + 60000,
        });
      });
    try {
      await expect(
        createLocalBrowser(team, { url: "https://example.com" }),
      ).rejects.toMatchObject({ code: "SESSION_STALE" });
      expect(disposed).toEqual([`/sessions/${"a".repeat(64)}`]);
      expect((await getLocalSession(team, closedId)).state).toBe("CLOSED");
      expect(
        unseal((await getLocalSession(team, closedId)).private_data),
      ).toEqual({});
      loseResponse = true;
      await expect(
        createLocalBrowser(team, { url: "https://example.com" }),
      ).rejects.toMatchObject({ code: "BROWSER_OUTCOME_UNKNOWN" });
      expect((await getLocalSession(team, closedId)).state).toBe("CLOSED");
    } finally {
      fetch.mockRestore();
      config.LOCAL_BROWSER_OWNER_URLS = originalOwners;
    }
  });
});
