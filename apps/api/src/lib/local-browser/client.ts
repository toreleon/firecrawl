import { randomInt, randomUUID } from "node:crypto";
import { config } from "../../config";
import type { BrowserControls } from "./controls";
import {
  getLocalSession,
  hash,
  initializeLocalStore,
  LocalBrowserError,
  LocalSession,
  localOperation,
  localPool,
  reserveLocalSession,
  seal,
  unseal,
} from "./store";

type Owner = {
  base: string;
  boot: string;
  engine?: string;
  capabilities: { version: number; actions: string[] };
};
type CompletedReceipt = {
  engine: string;
  ownerBootId: string;
  pageClosed: true;
  pageStatusCode?: number;
  errorCode?: string;
};
const completedErrors = new WeakMap<LocalBrowserError, CompletedReceipt>();
const completedErrorCodes = [
  "NETWORK_ERROR",
  "SCRAPE_TIMEOUT",
  "WORKFLOW_NAVIGATION_MISMATCH",
];
const amazonProduct = (value: unknown): string | undefined => {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !["amazon.com", "www.amazon.com"].includes(url.host) ||
      url.username ||
      url.password
    )
      return;
    return url.pathname
      .match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]
      .toUpperCase();
  } catch {
    return;
  }
};
const completedReceipt = (
  result: any,
  boot?: string,
  engine = "unknown",
): CompletedReceipt | undefined => {
  const attempts = result?.diagnostics?.attempts;
  if (
    !boot ||
    result?.diagnostics?.ownerBootId !== boot ||
    result.sessionId !== undefined ||
    !Array.isArray(attempts) ||
    attempts.length !== 1 ||
    attempts[0]?.pageClosed !== true
  )
    return;
  return {
    engine,
    ownerBootId: boot,
    pageClosed: true,
    ...(Number.isInteger(result.pageStatusCode) && {
      pageStatusCode: result.pageStatusCode,
    }),
    ...([...completedErrorCodes, "CONTENT_NOT_READY"].includes(
      result.errorCode,
    ) && { errorCode: result.errorCode }),
  };
};
const fallbackOwners = () =>
  (config.LOCAL_BROWSER_FALLBACK_OWNER_URLS ?? "")
    .split(",")
    .map(value =>
      value
        .trim()
        .replace(/\/scrape\/?$/, "")
        .replace(/\/$/, ""),
    )
    .filter(Boolean);
const owners = () => {
  const list = config.LOCAL_BROWSER_OWNER_URLS?.split(",") ?? [
    config.PLAYWRIGHT_MICROSERVICE_URL ?? "",
  ];
  const values = list
    .map(value =>
      value
        .trim()
        .replace(/\/scrape\/?$/, "")
        .replace(/\/$/, ""),
    )
    .filter(Boolean);
  if (!values.length)
    throw new LocalBrowserError(
      "LOCAL_BROWSER_NOT_CONFIGURED",
      "Local browser service is not configured",
      503,
    );
  return values;
};
export const browserRpc = async (
  base: string,
  path: string,
  body: unknown,
  options: {
    boot?: string;
    revision?: number;
    timeout?: number;
    signal?: AbortSignal;
    method?: string;
  } = {},
): Promise<any> => {
  try {
    const response = await fetch(base + path, {
      method: options.method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        "content-type": "application/json",
        ...(config.BROWSER_SERVICE_AUTH_TOKEN
          ? { authorization: `Bearer ${config.BROWSER_SERVICE_AUTH_TOKEN}` }
          : {}),
        ...(options.boot ? { "x-browser-owner": options.boot } : {}),
        ...(options.revision
          ? { "x-operation-revision": String(options.revision) }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: options.signal
        ? AbortSignal.any([
            options.signal,
            AbortSignal.timeout(options.timeout ?? 10000),
          ])
        : AbortSignal.timeout(options.timeout ?? 10000),
    });
    if (response.status === 204) return {};
    const result: any = await response.json();
    if (!response.ok) {
      const error = new LocalBrowserError(
        typeof result.errorCode === "string"
          ? result.errorCode
          : "BROWSER_OPERATION_FAILED",
        "Local browser operation failed",
        response.status,
      );
      const proof = completedReceipt(result, options.boot);
      if (proof && completedErrorCodes.includes(error.code))
        completedErrors.set(error, { ...proof, errorCode: error.code });
      throw error;
    }
    return result;
  } catch (error) {
    if (error instanceof LocalBrowserError) throw error;
    throw new LocalBrowserError(
      "BROWSER_OUTCOME_UNKNOWN",
      "Browser response was lost; the operation will not be replayed",
      502,
    );
  }
};
const health = new Map<string, { until: number; promise: Promise<Owner> }>();
export const inspectBrowserOwner = async (base: string): Promise<Owner> => {
  const previous = health.get(base);
  if (previous && previous.until > Date.now()) return previous.promise;
  const promise = browserRpc(base, "/health", undefined, {
    timeout: 10000,
  }).then(result => {
    if (
      result.status !== "healthy" ||
      !result.ownerBootId ||
      result.capabilities?.version !== 1
    )
      throw new LocalBrowserError(
        "BROWSER_CAPABILITY_MISSING",
        "Upgrade the browser service to use local browser controls",
        503,
      );
    return {
      base,
      boot: result.ownerBootId,
      ...(typeof result.browserEngine === "string" &&
      /^[a-z0-9_.-]{1,64}$/i.test(result.browserEngine)
        ? { engine: result.browserEngine }
        : {}),
      capabilities: result.capabilities,
    };
  });
  // Deduplicate probes while pending; the freshness window starts on success.
  const entry = { until: Infinity, promise };
  health.set(base, entry);
  try {
    const result = await promise;
    if (health.get(base) === entry) entry.until = Date.now() + 2000;
    return result;
  } catch (error) {
    if (health.get(base) === entry) health.delete(base);
    throw error;
  }
};

let statelessOwnerCursor = randomInt(1_000_000);
const discoveryError = (cancelled: boolean) =>
  new LocalBrowserError(
    cancelled ? "SCRAPE_CANCELLED" : "SCRAPE_TIMEOUT",
    cancelled
      ? "Browser request cancelled"
      : "Browser discovery deadline exceeded",
    cancelled ? 499 : 408,
  );
const inspectWithinDeadline = (
  base: string,
  until: number,
  signal?: AbortSignal,
): Promise<Owner> => {
  if (signal?.aborted) return Promise.reject(discoveryError(true));
  if (until <= Date.now()) return Promise.reject(discoveryError(false));
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown, owner?: Owner) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve(owner!);
    };
    const aborted = () => finish(discoveryError(true));
    const timer = setTimeout(
      () => finish(discoveryError(false)),
      until - Date.now(),
    );
    signal?.addEventListener("abort", aborted, { once: true });
    // A caller's cancellation must not cancel a probe shared by other requests.
    inspectBrowserOwner(base).then(owner => finish(undefined, owner), finish);
  });
};
const selectStatelessOwner = async (until: number, signal?: AbortSignal) => {
  const candidates = owners();
  const first = statelessOwnerCursor++ % candidates.length;
  for (let offset = 0; offset < candidates.length; offset++) {
    try {
      return await inspectWithinDeadline(
        candidates[(first + offset) % candidates.length],
        until,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw discoveryError(true);
      if (Date.now() >= until) throw discoveryError(false);
      if (offset === candidates.length - 1) throw error;
    }
  }
  throw new LocalBrowserError(
    "BROWSER_UNAVAILABLE",
    "No browser owner is available",
    503,
  );
};
export const mapBrowserControls = (controls: BrowserControls | undefined) => ({
  ...(controls?.waitUntil ? { wait_until: controls.waitUntil } : {}),
  ...(controls?.readiness?.selector
    ? { check_selector: controls.readiness.selector }
    : {}),
  ...(controls?.readiness?.text
    ? { wait_for_text: controls.readiness.text }
    : {}),
  ...(controls?.readiness?.scope
    ? { readiness_scope: controls.readiness.scope }
    : {}),
  ...(controls?.readiness?.timeoutMs
    ? { readiness_timeout: controls.readiness.timeoutMs }
    : {}),
  ...(controls?.consent ? { consent: controls.consent } : {}),
  ...(controls?.workflow ? { workflow: controls.workflow } : {}),
  ...(controls?.maxAttempts ? { max_attempts: controls.maxAttempts } : {}),
});
type SessionPrivate = {
  token?: string;
  controls: BrowserControls;
  headers?: Record<string, string>;
  blockAds: boolean;
  skipTlsVerification: boolean;
  url: string;
};
const validateResponse = (response: any) => {
  if (
    typeof response?.content !== "string" ||
    !(
      response.pageStatusCode === null ||
      typeof response.pageStatusCode === "number"
    )
  )
    throw new LocalBrowserError(
      "BROWSER_INVALID_RESPONSE",
      "Invalid browser service response",
      502,
    );
  return response;
};

export const createLocalBrowser = async (
  team: string,
  input: {
    url: string;
    controls?: BrowserControls;
    headers?: Record<string, string>;
    blockAds?: boolean;
    skipTlsVerification?: boolean;
    timeout?: number;
    creationId?: string;
  },
) => {
  if (input.controls?.engineFallback)
    throw new LocalBrowserError(
      "BROWSER_FALLBACK_UNSUPPORTED",
      "Retained session creation cannot use engine fallback",
      400,
    );
  const privateData: SessionPrivate = {
    url: input.url,
    controls: input.controls ?? {},
    headers: input.headers,
    blockAds: input.blockAds ?? true,
    skipTlsVerification: input.skipTlsVerification ?? false,
  };
  const digest = input.creationId ? hash([team, input.creationId]) : undefined;
  const reservedId = digest
    ? `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
    : undefined;
  const existingCreation = async () => {
    const row = await getLocalSession(team, reservedId!);
    const { token, ...prior } = unseal<SessionPrivate>(row.private_data);
    if (hash(prior) !== hash(privateData))
      throw new LocalBrowserError(
        "OPERATION_MISMATCH",
        "Creation identifier was reused with different options",
      );
    if (
      !["READY", "WAITING_HUMAN"].includes(row.state) ||
      new Date(row.expires_at).getTime() <= Date.now()
    )
      throw new LocalBrowserError(
        "SESSION_LOST",
        "Previous creation is pending or unavailable; it will not be recreated",
      );
    return { id: row.id, state: row.state, expiresAt: row.expires_at };
  };
  if (reservedId)
    try {
      return await existingCreation();
    } catch (error) {
      if (
        !(error instanceof LocalBrowserError) ||
        error.code !== "SESSION_UNKNOWN"
      )
        throw error;
    }
  const candidates = owners();
  const owner = await inspectBrowserOwner(
    candidates[randomInt(candidates.length)],
  );
  let id: string;
  try {
    id = await reserveLocalSession(
      team,
      new URL(input.url).origin,
      owner.base,
      owner.boot,
      300000,
      privateData,
      reservedId,
    );
  } catch (error) {
    if (
      reservedId &&
      error instanceof LocalBrowserError &&
      error.code === "SESSION_ALREADY_RESERVED"
    )
      return existingCreation();
    throw error;
  }
  try {
    const timeout = Math.min(120000, Math.max(1000, input.timeout ?? 30000));
    const result = validateResponse(
      await browserRpc(
        owner.base,
        "/scrape",
        {
          url: input.url,
          timeout,
          create_session: true,
          session_mode: "workflow",
          operation_revision: 1,
          headers: input.headers,
          block_ads: privateData.blockAds,
          skip_tls_verification: privateData.skipTlsVerification,
          ...mapBrowserControls(input.controls),
        },
        { boot: owner.boot, timeout: timeout + 2000 },
      ),
    );
    if (!/^[a-f0-9]{64}$/.test(result.sessionId ?? ""))
      throw new LocalBrowserError(
        "BROWSER_CAPABILITY_MISSING",
        "Browser service did not create a retained session",
        502,
      );
    privateData.token = result.sessionId;
    const state = [
      "HUMAN_REQUIRED",
      "VERIFICATION_REQUIRED",
      "AUTH_REQUIRED",
    ].includes(result.interaction?.state)
      ? "WAITING_HUMAN"
      : "READY";
    const activated = await localPool().query<{ expires_at: string }>(
      "UPDATE firecrawl_local_browser_sessions SET state=$2,private_data=$3,expires_at=LEAST(expires_at,to_timestamp($4::double precision/1000)),updated_at=clock_timestamp() WHERE id=$1 AND state='CREATING' AND expires_at>clock_timestamp() RETURNING expires_at",
      [id, state, seal(privateData), result.sessionExpiresAt],
    );
    if (!activated.rowCount) {
      // A close/expiry may win while initial navigation is in flight. The newly
      // returned capability was never published, so dispose it directly without
      // reviving or overwriting the directory record that won the race.
      await browserRpc(
        owner.base,
        `/sessions/${privateData.token}`,
        undefined,
        {
          boot: owner.boot,
          method: "DELETE",
          timeout: 5000,
        },
      ).catch(() => {});
      throw new LocalBrowserError(
        "SESSION_STALE",
        "Session closed or expired during creation",
      );
    }
    return {
      id,
      state,
      expiresAt: activated.rows[0].expires_at,
      interaction: result.interaction,
    };
  } catch (error) {
    await localPool().query(
      "UPDATE firecrawl_local_browser_sessions SET state='LOST',updated_at=clock_timestamp() WHERE id=$1 AND state='CREATING'",
      [id],
    );
    throw error;
  }
};

export const scrapeLocalBrowser = async (
  team: string | null | undefined,
  requestId: string,
  input: {
    url: string;
    timeout: number;
    waitFor?: number;
    controls: BrowserControls;
    headers?: Record<string, string>;
    blockAds?: boolean;
    skipTlsVerification?: boolean;
    actions?: unknown[];
    signal?: AbortSignal;
  },
) => {
  const fallbackEnabled = input.controls.engineFallback === true;
  const expectedAmazon =
    input.controls.workflow === "auto" ? amazonProduct(input.url) : undefined;
  if (
    fallbackEnabled &&
    (input.controls.sessionId ||
      input.actions?.length ||
      (input.controls.maxAttempts ?? 1) !== 1)
  )
    throw new LocalBrowserError(
      "BROWSER_FALLBACK_UNSUPPORTED",
      "Engine fallback requires a stateless scrape without interactive actions or retries",
      400,
    );
  if (fallbackEnabled && !fallbackOwners().length)
    throw new LocalBrowserError(
      "BROWSER_FALLBACK_NOT_CONFIGURED",
      "Configure alternate browser owners before requesting engine fallback",
      503,
    );
  const body = {
    url: input.url,
    timeout: Math.min(120000, Math.max(100, input.timeout - 500)),
    wait_after_load: input.waitFor ?? 0,
    headers: input.headers,
    block_ads: input.blockAds ?? true,
    skip_tls_verification: input.skipTlsVerification ?? false,
    actions: input.actions,
    ...mapBrowserControls(input.controls),
  };
  if (!input.controls.sessionId) {
    const until = Date.now() + input.timeout;
    const owner = await selectStatelessOwner(until, input.signal);
    for (const action of input.actions ?? [])
      if (!owner.capabilities.actions.includes((action as any).type))
        throw new LocalBrowserError(
          "BROWSER_ACTION_UNSUPPORTED",
          "Browser action is unsupported",
          400,
        );
    if (input.signal?.aborted) throw discoveryError(true);
    const remaining = until - Date.now();
    if (remaining < 100) throw discoveryError(false);
    body.timeout = Math.min(120000, Math.max(100, remaining - 500));
    const dispatch = async (selected: Owner) => {
      if (input.signal?.aborted) throw discoveryError(true);
      const left = until - Date.now();
      if (left < 100) throw discoveryError(false);
      const result = validateResponse(
        await browserRpc(
          selected.base,
          "/scrape",
          {
            ...body,
            timeout: Math.min(120000, Math.max(100, left - 500)),
            ...(fallbackEnabled ? { max_attempts: 1 } : {}),
          },
          {
            boot: selected.boot,
            timeout: left,
            signal: input.signal,
          },
        ),
      );
      // Older owners may return a ready document from another product. Guard
      // the landed URL here too, before either primary or alternate promotion.
      if (
        expectedAmazon &&
        result.pageStatusCode >= 200 &&
        result.pageStatusCode < 300 &&
        !result.botDetection &&
        !result.pageError &&
        !result.errorCode &&
        result.readiness?.satisfied !== false &&
        amazonProduct(result.url) !== expectedAmazon
      ) {
        const error = new LocalBrowserError(
          "WORKFLOW_NAVIGATION_MISMATCH",
          "Browser did not capture the original Amazon product",
          500,
        );
        const receipt = completedReceipt(
          result,
          selected.boot,
          selected.engine,
        );
        if (receipt)
          completedErrors.set(error, { ...receipt, errorCode: error.code });
        throw error;
      }
      return result;
    };
    if (!fallbackEnabled) return dispatch(owner);
    let primary: any;
    let failure: LocalBrowserError | undefined;
    let proof: CompletedReceipt | undefined;
    try {
      primary = await dispatch(owner);
      proof = completedReceipt(primary, owner.boot, owner.engine);
    } catch (error) {
      if (!(error instanceof LocalBrowserError) || !completedErrors.has(error))
        throw error;
      if (error.code === "WORKFLOW_NAVIGATION_MISMATCH" && !expectedAmazon)
        throw error;
      failure = error;
      proof = {
        ...completedErrors.get(error)!,
        engine: owner.engine ?? "unknown",
      };
    }
    const annotate = (response: any, details: Record<string, unknown>) => ({
      ...response,
      diagnostics: { ...response.diagnostics, engineFallback: details },
    });
    const stop = (skipped: string) => {
      if (failure) throw failure;
      return annotate(primary, {
        attempted: false,
        usedSecondary: false,
        skipped,
        attempts: proof ? [proof] : [],
      });
    };
    const eligible =
      proof &&
      (failure ||
        primary.botDetection ||
        primary.errorCode === "CONTENT_NOT_READY" ||
        // proxy-chain surfaces a reset of an HTTP target as its own 595
        // response. It remains a failed status with confirmed page cleanup.
        [403, 406, 417, 429, 502, 503, 504, 595].includes(
          primary.pageStatusCode,
        ));
    if (!eligible) return stop(proof ? "not_needed" : "completion_unconfirmed");
    const minimum = Math.max(
      1000,
      (input.waitFor ?? 0) +
        (input.controls.readiness?.timeoutMs ??
          (input.controls.workflow === "auto" ? 5000 : 0)) +
        750,
    );
    if (until - Date.now() < minimum) return stop("insufficient_budget");
    let alternate: Owner | undefined;
    for (const base of fallbackOwners()) {
      if (base === owner.base) continue;
      try {
        const candidate = await inspectWithinDeadline(
          base,
          until,
          input.signal,
        );
        if (
          candidate.boot !== owner.boot &&
          candidate.engine &&
          owner.engine &&
          candidate.engine !== owner.engine
        ) {
          alternate = candidate;
          break;
        }
      } catch {
        if (input.signal?.aborted) throw discoveryError(true);
        if (Date.now() >= until) throw discoveryError(false);
      }
    }
    if (!alternate) return stop("no_distinct_healthy_backend");
    if (until - Date.now() < minimum) return stop("insufficient_budget");
    let secondary: any;
    let secondaryProof: CompletedReceipt;
    try {
      secondary = await dispatch(alternate);
      const receipt = completedReceipt(
        secondary,
        alternate.boot,
        alternate.engine,
      );
      if (!receipt)
        throw new LocalBrowserError(
          "BROWSER_INVALID_RESPONSE",
          "Alternate browser completion was not confirmed",
          502,
        );
      secondaryProof = receipt;
    } catch (error) {
      if (!(error instanceof LocalBrowserError) || !completedErrors.has(error))
        throw error;
      if (!primary) throw error;
      secondaryProof = {
        ...completedErrors.get(error)!,
        engine: alternate.engine ?? "unknown",
      };
    }
    const useSecondary =
      !!secondary &&
      secondary.content.trim().length > 0 &&
      (secondary.renderedText === undefined ||
        secondary.renderedText.trim().length > 0) &&
      secondary.pageStatusCode >= 200 &&
      secondary.pageStatusCode < 300 &&
      !secondary.botDetection &&
      !secondary.pageError &&
      !secondary.errorCode &&
      secondary.readiness?.satisfied !== false;
    const selected = useSecondary || !primary ? secondary : primary;
    return annotate(selected, {
      attempted: true,
      usedSecondary: selected === secondary,
      recovered: useSecondary,
      attempts: [proof, secondaryProof],
    });
  }
  if (!team)
    throw new LocalBrowserError(
      "SESSION_FORBIDDEN",
      "Authenticated session owner required",
      403,
    );
  const id = input.controls.sessionId;
  const record = await getLocalSession(team, id);
  if (new URL(input.url).origin !== record.origin)
    throw new LocalBrowserError("SESSION_MISMATCH", "Session origin differs");
  const saved = unseal<SessionPrivate>(record.private_data);
  const sessionBody = {
    ...body,
    ...mapBrowserControls({ ...saved.controls, ...input.controls }),
    headers: input.headers ?? saved.headers,
    block_ads: input.blockAds ?? saved.blockAds,
    skip_tls_verification:
      input.skipTlsVerification ?? saved.skipTlsVerification,
    session_id: saved.token,
    session_mode: "workflow",
    continue_session: input.controls.continueSession ?? false,
  };
  const result = await localOperation(
    team,
    id,
    requestId,
    { ...sessionBody, timeout: undefined, session_id: undefined },
    "scrape",
    async (row, revision) =>
      validateResponse(
        await browserRpc(
          row.owner_url,
          "/scrape",
          { ...sessionBody, operation_revision: revision },
          {
            boot: row.owner_boot,
            timeout: input.timeout,
            signal: input.signal,
          },
        ),
      ),
  );
  const { sessionId: _token, sessionExpiresAt: _expires, ...safe } = result;
  return { ...safe, publicSessionId: id };
};

export const localBrowserPageOperation = async (
  team: string,
  id: string,
  operationId: string,
  kind: "snapshot" | "input" | "resume",
  input?: unknown,
) => {
  const record = await getLocalSession(team, id);
  return localOperation(
    team,
    id,
    operationId,
    { kind, input },
    kind,
    async (row, revision) => {
      const saved = unseal<SessionPrivate>(row.private_data);
      if (kind === "resume") {
        const result = validateResponse(
          await browserRpc(
            row.owner_url,
            "/scrape",
            {
              url: saved.url,
              timeout: 15000,
              ...mapBrowserControls(saved.controls),
              headers: saved.headers,
              block_ads: saved.blockAds,
              skip_tls_verification: saved.skipTlsVerification,
              session_id: saved.token,
              session_mode: "workflow",
              continue_session: true,
              operation_revision: revision,
            },
            { boot: row.owner_boot, timeout: 17000 },
          ),
        );
        const { sessionId, sessionExpiresAt, ...safe } = result;
        return { ...safe, publicSessionId: id };
      }
      return browserRpc(
        row.owner_url,
        `/sessions/${saved.token}/${kind}`,
        input,
        { boot: row.owner_boot, revision, timeout: 7000 },
      );
    },
  );
};

export const closeLocalBrowser = async (team: string, id: string) => {
  const row = await getLocalSession(team, id);
  await localPool().query(
    "UPDATE firecrawl_local_browser_sessions SET state='CLOSING',handoff_hash=NULL,updated_at=clock_timestamp() WHERE id=$1 AND state<>'CLOSED'",
    [id],
  );
  const saved = unseal<SessionPrivate>(row.private_data);
  if (saved.token) {
    try {
      await browserRpc(row.owner_url, `/sessions/${saved.token}`, undefined, {
        boot: row.owner_boot,
        method: "DELETE",
        timeout: 5000,
      });
    } catch (error) {
      if (
        !(error instanceof LocalBrowserError) ||
        !["SESSION_LOST", "SESSION_EXPIRED"].includes(error.code)
      )
        throw error;
    }
  }
  await localPool().query(
    "UPDATE firecrawl_local_browser_sessions SET state='CLOSED',private_data=$2,active_operation=NULL,updated_at=clock_timestamp() WHERE id=$1",
    [id, seal({})],
  );
  await localPool().query(
    "DELETE FROM firecrawl_local_browser_operations WHERE session_id=$1",
    [id],
  );
};

let reconciling = false;
export const reconcileLocalBrowsers = async () => {
  if (reconciling || !config.LOCAL_BROWSER_SESSION_SECRET) return;
  reconciling = true;
  try {
    await initializeLocalStore();
    const live = await localPool().query<LocalSession>(
      "SELECT * FROM firecrawl_local_browser_sessions WHERE state IN ('READY','WAITING_HUMAN') AND updated_at<clock_timestamp()-interval '10 seconds' ORDER BY updated_at LIMIT 16",
    );
    for (const row of live.rows) {
      try {
        const owner = await inspectBrowserOwner(row.owner_url);
        if (owner.boot !== row.owner_boot)
          throw new LocalBrowserError("SESSION_LOST", "Browser owner changed");
        await localPool().query(
          "UPDATE firecrawl_local_browser_sessions SET updated_at=clock_timestamp() WHERE id=$1 AND state IN ('READY','WAITING_HUMAN')",
          [row.id],
        );
      } catch {
        await localPool().query(
          "UPDATE firecrawl_local_browser_sessions SET state='LOST',handoff_hash=NULL,updated_at=clock_timestamp() WHERE id=$1 AND state IN ('READY','WAITING_HUMAN')",
          [row.id],
        );
      }
    }
    const { rows } = await localPool().query<LocalSession>(
      "SELECT * FROM firecrawl_local_browser_sessions WHERE state IN ('CLOSING','LOST') OR (expires_at<clock_timestamp() AND state<>'CLOSED') LIMIT 16",
    );
    for (const row of rows)
      await closeLocalBrowser(row.team_id, row.id).catch(() => {});
    await localPool().query(
      "DELETE FROM firecrawl_local_browser_sessions WHERE expires_at<clock_timestamp()-interval '1 day' AND state='CLOSED'",
    );
  } finally {
    reconciling = false;
  }
};
const janitor = setInterval(() => {
  void reconcileLocalBrowsers().catch(() => {});
}, 10000);
janitor.unref();
