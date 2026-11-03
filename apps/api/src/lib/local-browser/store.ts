import { Pool } from "pg";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { config } from "../../config";

export class LocalBrowserError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
export type LocalSession = {
  id: string;
  team_id: string;
  origin: string;
  state: string;
  owner_url: string;
  owner_boot: string;
  revision: number;
  expires_at: string;
  private_data: string;
  active_operation: string | null;
  handoff_hash: string | null;
  handoff_until: string | null;
};
export const localBrowserSchema = `
CREATE TABLE IF NOT EXISTS firecrawl_local_browser_sessions (
 id uuid PRIMARY KEY, team_id text NOT NULL, origin text NOT NULL,
 state text NOT NULL, owner_url text NOT NULL, owner_boot text NOT NULL,
 revision integer NOT NULL DEFAULT 1, expires_at timestamptz NOT NULL,
 private_data text NOT NULL, active_operation text, handoff_hash text, handoff_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS firecrawl_local_browser_expiry ON firecrawl_local_browser_sessions(expires_at);
CREATE TABLE IF NOT EXISTS firecrawl_local_browser_operations (
 session_id uuid REFERENCES firecrawl_local_browser_sessions(id) ON DELETE CASCADE,
 operation_id text NOT NULL, request_hash text NOT NULL, state text NOT NULL,
 result text, PRIMARY KEY(session_id, operation_id)
);`;
let pool: Pool | undefined;
let initialized: Promise<void> | undefined;
export const localPool = () => {
  if (!config.LOCAL_BROWSER_SESSION_SECRET)
    throw new LocalBrowserError(
      "LOCAL_BROWSER_NOT_CONFIGURED",
      "LOCAL_BROWSER_SESSION_SECRET is required",
      503,
    );
  const connectionString =
    config.LOCAL_BROWSER_DATABASE_URL ?? config.NUQ_DATABASE_URL;
  if (!connectionString)
    throw new LocalBrowserError(
      "LOCAL_BROWSER_NOT_CONFIGURED",
      "A local browser session database is required",
      503,
    );
  return (pool ??= new Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    allowExitOnIdle: true,
  }));
};
export const initializeLocalStore = async () => {
  initialized ??= (async () => {
    const client = await localPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('firecrawl-local-browser-schema-v1'))",
      );
      await client.query(localBrowserSchema);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  })().catch(error => {
    initialized = undefined;
    throw error;
  });
  await initialized;
};
export const seal = (value: unknown) => {
  const key = createHash("sha256")
    .update(config.LOCAL_BROWSER_SESSION_SECRET!)
    .digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
};
export const unseal = <T = any>(value: string): T => {
  const data = Buffer.from(value, "base64");
  const key = createHash("sha256")
    .update(config.LOCAL_BROWSER_SESSION_SECRET!)
    .digest();
  const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      cipher.update(data.subarray(28)),
      cipher.final(),
    ]).toString(),
  );
};
export const hash = (value: unknown) =>
  createHash("sha256")
    .update(
      typeof value === "string"
        ? value
        : JSON.stringify(value, (_key, item) =>
            item && typeof item === "object" && !Array.isArray(item)
              ? Object.fromEntries(
                  Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
                )
              : item,
          ),
    )
    .digest("hex");
export const getLocalSession = async (team: string, id: string) => {
  await initializeLocalStore();
  const { rows } = await localPool().query<LocalSession>(
    "SELECT * FROM firecrawl_local_browser_sessions WHERE id=$1 AND team_id=$2",
    [id, team],
  );
  if (!rows[0])
    throw new LocalBrowserError(
      "SESSION_UNKNOWN",
      "Browser session not found",
      404,
    );
  return rows[0];
};

export const reserveLocalSession = async (
  team: string,
  origin: string,
  ownerUrl: string,
  ownerBoot: string,
  ttl: number,
  options: unknown,
  reservedId?: string,
) => {
  await initializeLocalStore();
  const client = await localPool().connect();
  const id = reservedId ?? randomUUID();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `local-browser-capacity:${team}`,
    ]);
    if (
      (
        await client.query(
          "SELECT id FROM firecrawl_local_browser_sessions WHERE id=$1",
          [id],
        )
      ).rowCount
    )
      throw new LocalBrowserError(
        "SESSION_ALREADY_RESERVED",
        "Session creation was already reserved",
      );
    const { rows } = await client.query(
      "SELECT count(*)::int AS count FROM firecrawl_local_browser_sessions WHERE team_id=$1 AND state IN ('CREATING','READY','BUSY','WAITING_HUMAN','CLOSING') AND expires_at>clock_timestamp()",
      [team],
    );
    if (rows[0].count >= 8)
      throw new LocalBrowserError(
        "SESSION_LIMIT",
        "Browser session capacity reached",
        429,
      );
    await client.query(
      "INSERT INTO firecrawl_local_browser_sessions(id,team_id,origin,state,owner_url,owner_boot,expires_at,private_data) VALUES($1,$2,$3,'CREATING',$4,$5,clock_timestamp()+($6::int*interval '1 millisecond'),$7)",
      [id, team, origin, ownerUrl, ownerBoot, ttl, seal(options)],
    );
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// A short transaction guards dispatch. The browser I/O always happens after
// COMMIT. An unacknowledged external action is terminal/unknown, never replayed.
export const localOperation = async <T>(
  team: string,
  id: string,
  operationId: string,
  request: unknown,
  kind: "scrape" | "resume" | "snapshot" | "input",
  run: (row: LocalSession, revision: number) => Promise<T>,
): Promise<T> => {
  await initializeLocalStore();
  const client = await localPool().connect();
  let row: LocalSession;
  const requestHash = hash(request);
  let priorState: string;
  try {
    await client.query("BEGIN");
    const session = await client.query<LocalSession>(
      "SELECT *, expires_at<=clock_timestamp() AS expired FROM firecrawl_local_browser_sessions WHERE id=$1 AND team_id=$2 FOR UPDATE",
      [id, team],
    );
    row = session.rows[0];
    if (!row)
      throw new LocalBrowserError(
        "SESSION_UNKNOWN",
        "Browser session not found",
        404,
      );
    if (
      (row as any).expired ||
      ["CLOSED", "CLOSING", "LOST", "EXPIRED", "CREATING"].includes(row.state)
    )
      throw new LocalBrowserError(
        "SESSION_LOST",
        "Session is unavailable; create a new workflow",
        410,
      );
    const previous = await client.query(
      "SELECT * FROM firecrawl_local_browser_operations WHERE session_id=$1 AND operation_id=$2",
      [id, operationId],
    );
    if (previous.rows[0]) {
      const prior = previous.rows[0];
      if (prior.state === "completed_no_result")
        throw new LocalBrowserError(
          "OPERATION_RESULT_UNAVAILABLE",
          "Operation completed; its large result was not retained and will not be replayed",
        );
      if (prior.request_hash !== requestHash)
        throw new LocalBrowserError(
          "OPERATION_MISMATCH",
          "Operation identifier was reused for different input",
        );
      if (prior.state !== "completed")
        throw new LocalBrowserError(
          "OPERATION_UNCERTAIN",
          "Operation is running or its outcome is unknown",
        );
      await client.query("COMMIT");
      return unseal<T>(prior.result);
    }
    if (row.state === "BUSY")
      throw new LocalBrowserError(
        "SESSION_BUSY",
        "Browser session already has an active operation",
      );
    if (
      (kind === "input" && row.state !== "WAITING_HUMAN") ||
      (kind === "scrape" && row.state === "WAITING_HUMAN")
    )
      throw new LocalBrowserError(
        "SESSION_NEEDS_RESUME",
        "Use the handoff and explicit resume endpoints",
      );
    const count = await client.query(
      "SELECT count(*)::int AS count FROM firecrawl_local_browser_operations WHERE session_id=$1",
      [id],
    );
    if (count.rows[0].count >= 1000)
      throw new LocalBrowserError(
        "SESSION_LIMIT",
        "Session operation limit reached",
        429,
      );
    priorState = row.state;
    row.revision++;
    await client.query(
      "INSERT INTO firecrawl_local_browser_operations(session_id,operation_id,request_hash,state) VALUES($1,$2,$3,'running')",
      [id, operationId, requestHash],
    );
    await client.query(
      "UPDATE firecrawl_local_browser_sessions SET state='BUSY',revision=$2,active_operation=$3,handoff_hash=CASE WHEN $4='resume' THEN NULL ELSE handoff_hash END,updated_at=clock_timestamp() WHERE id=$1",
      [id, row.revision, operationId, kind],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  try {
    const result = await run(row!, row!.revision);
    const interaction = (result as any)?.interaction?.state;
    const state = [
      "HUMAN_REQUIRED",
      "VERIFICATION_REQUIRED",
      "AUTH_REQUIRED",
    ].includes(interaction)
      ? "WAITING_HUMAN"
      : kind === "input" || kind === "snapshot"
        ? priorState!
        : "READY";
    const completion = await localPool().connect();
    try {
      await completion.query("BEGIN");
      const update = await completion.query(
        "UPDATE firecrawl_local_browser_sessions SET state=$4,active_operation=NULL,updated_at=clock_timestamp() WHERE id=$1 AND revision=$2 AND active_operation=$3 AND state='BUSY' RETURNING id",
        [id, row!.revision, operationId, state],
      );
      if (!update.rowCount)
        throw new LocalBrowserError(
          "SESSION_STALE",
          "Session closed or ownership changed during the operation",
        );
      // Screenshots are live views, not durable artifacts. Their server-generated
      // operation IDs are never reused. Other results are encrypted for replay.
      const encrypted = seal(kind === "snapshot" ? { snapshot: true } : result);
      const used = await completion.query(
        "SELECT COALESCE(sum(octet_length(result)),0)::bigint AS bytes FROM firecrawl_local_browser_operations WHERE session_id=$1",
        [id],
      );
      const retain =
        encrypted.length <= 5 * 1024 * 1024 &&
        Number(used.rows[0].bytes) + encrypted.length <= 20 * 1024 * 1024;
      await completion.query(
        "UPDATE firecrawl_local_browser_operations SET state=$4,result=$3 WHERE session_id=$1 AND operation_id=$2",
        [
          id,
          operationId,
          retain ? encrypted : null,
          retain ? "completed" : "completed_no_result",
        ],
      );
      await completion.query("COMMIT");
    } catch (error) {
      await completion.query("ROLLBACK");
      throw error;
    } finally {
      completion.release();
    }
    return result;
  } catch (error) {
    await localPool().query(
      "UPDATE firecrawl_local_browser_sessions SET state='LOST',active_operation=NULL,updated_at=clock_timestamp() WHERE id=$1 AND revision=$2 AND state='BUSY'",
      [id, row!.revision],
    );
    await localPool().query(
      "UPDATE firecrawl_local_browser_operations SET state='outcome_unknown' WHERE session_id=$1 AND operation_id=$2 AND state='running'",
      [id, operationId],
    );
    throw error;
  }
};

export const closeLocalStore = async () => {
  await pool?.end();
  pool = undefined;
  initialized = undefined;
};
