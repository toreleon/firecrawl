import type { Request, Response } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { browserControlsSchema } from "../../lib/local-browser/controls";
import {
  createLocalBrowser,
  closeLocalBrowser,
  localBrowserPageOperation,
} from "../../lib/local-browser/client";
import {
  getLocalSession,
  hash,
  LocalBrowserError,
  localPool,
} from "../../lib/local-browser/store";
import { resolveSafeMode } from "../../lib/safe-mode";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import { resolveThreatProtection } from "../../lib/threat-protection/request";
import { checkUrl } from "../../lib/threat-protection";

const idOf = (req: Request) => z.uuid().parse(req.params.sessionId);
const teamOf = (req: Request) => (req as any).auth.team_id as string;
const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response) => {
    res.setHeader("cache-control", "no-store");
    try {
      return await fn(req, res);
    } catch (error) {
      if (error instanceof z.ZodError)
        return res.status(400).json({
          success: false,
          code: "INVALID_BROWSER_OPTIONS",
          error: "Invalid local browser options",
        });
      if (error instanceof LocalBrowserError)
        return res
          .status(error.status)
          .json({ success: false, code: error.code, error: error.message });
      return res.status(503).json({
        success: false,
        code: "LOCAL_BROWSER_UNAVAILABLE",
        error: "Local browser service or session directory is unavailable",
      });
    }
  };
const guard = async (req: Request, url: string) => {
  const flags = (req as any).acuc?.flags;
  if (getScrapeZDR(flags) === "forced" || req.body?.zeroDataRetention === true)
    throw new LocalBrowserError(
      "SESSION_ZDR_UNSUPPORTED",
      "Durable local sessions are unavailable with zero data retention",
      400,
    );
  const safe = resolveSafeMode(flags, req.body?.safeMode, url);
  if (safe.error || safe.safeMode)
    throw new LocalBrowserError(
      "SAFE_MODE_BLOCKED",
      "Local interactive sessions are unavailable in safe mode",
      403,
    );
  const resolved = await resolveThreatProtection({
    teamId: teamOf(req),
    orgId: (req as any).acuc?.org_id ?? null,
    flags,
  });
  if (resolved.error)
    throw new LocalBrowserError("unsafe_domain_blocked", resolved.error, 403);
  const policy = resolved.policy;
  if (
    policy &&
    policy.mode !== "off" &&
    !(await checkUrl(url, policy, { teamId: teamOf(req) })).allowed
  )
    throw new LocalBrowserError(
      "unsafe_domain_blocked",
      "Target is blocked by the domain policy",
      403,
    );
};
const createSchema = z.strictObject({
  creationId: z.uuid().optional(),
  url: z
    .url()
    .refine(value => ["http:", "https:"].includes(new URL(value).protocol)),
  browserControls: browserControlsSchema
    .optional()
    .refine(
      value =>
        !value?.sessionId &&
        !value?.continueSession &&
        !value?.engineFallback &&
        (value?.maxAttempts ?? 1) === 1,
      "Cannot reuse or retry during creation",
    ),
  headers: z.record(z.string(), z.string()).optional(),
  blockAds: z.boolean().optional(),
  skipTlsVerification: z.boolean().optional(),
  timeout: z.int().min(1000).max(120000).optional(),
  zeroDataRetention: z.boolean().optional(),
});
export const localBrowserCreate = handle(async (req, res) => {
  const body = createSchema.parse(req.body);
  await guard(req, body.url);
  return res.status(201).json(
    await createLocalBrowser(teamOf(req), {
      ...body,
      controls: body.browserControls,
    }),
  );
});
export const localBrowserStatus = handle(async (req, res) => {
  const row = await getLocalSession(teamOf(req), idOf(req));
  return res.json({ id: row.id, state: row.state, expiresAt: row.expires_at });
});
export const localBrowserDelete = handle(async (req, res) => {
  await closeLocalBrowser(teamOf(req), idOf(req));
  return res.status(204).end();
});
export const localBrowserResume = handle(async (req, res) => {
  const id = idOf(req);
  const row = await getLocalSession(teamOf(req), id);
  await guard(req, row.origin);
  const operationId =
    z.uuid().optional().parse(req.body?.operationId) ?? randomUUID();
  return res.json(
    await localBrowserPageOperation(teamOf(req), id, operationId, "resume"),
  );
});
export const localBrowserHandoff = handle(async (req, res) => {
  const id = idOf(req);
  const row = await getLocalSession(teamOf(req), id);
  await guard(req, row.origin);
  const ticket = randomBytes(32).toString("hex");
  const update = await localPool().query(
    "UPDATE firecrawl_local_browser_sessions SET state='WAITING_HUMAN',handoff_hash=$3,handoff_until=LEAST(expires_at,clock_timestamp()+interval '5 minutes') WHERE id=$1 AND team_id=$2 AND state IN ('READY','WAITING_HUMAN') AND expires_at>clock_timestamp() RETURNING handoff_until",
    [id, teamOf(req), hash(ticket)],
  );
  if (!update.rowCount)
    throw new LocalBrowserError(
      "SESSION_BUSY",
      "Session is unavailable or busy",
    );
  return res.json({
    id,
    expiresAt: update.rows[0].handoff_until,
    viewPath: `/v2/browser/sessions/${id}/view#${ticket}`,
  });
});
const handoffOwner = async (req: Request) => {
  const id = idOf(req);
  const ticket = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(req.headers["x-browser-handoff"]);
  const result = await localPool().query(
    "SELECT team_id FROM firecrawl_local_browser_sessions WHERE id=$1 AND handoff_hash=$2 AND handoff_until>clock_timestamp() AND expires_at>clock_timestamp() AND state IN ('WAITING_HUMAN','BUSY')",
    [id, hash(ticket)],
  );
  if (!result.rows[0])
    throw new LocalBrowserError(
      "HANDOFF_EXPIRED",
      "Handoff is expired or revoked",
      403,
    );
  return result.rows[0].team_id as string;
};
export const localBrowserSnapshot = handle(async (req, res) => {
  const team = await handoffOwner(req);
  return res.json(
    await localBrowserPageOperation(team, idOf(req), randomUUID(), "snapshot"),
  );
});
export const localBrowserInput = handle(async (req, res) => {
  const team = await handoffOwner(req);
  const input = z
    .discriminatedUnion("type", [
      z.strictObject({
        type: z.literal("click"),
        x: z.number().min(0).max(10000),
        y: z.number().min(0).max(10000),
      }),
      z.strictObject({
        type: z.literal("key"),
        key: z.enum([
          "Tab",
          "Shift+Tab",
          "Enter",
          "Backspace",
          "Delete",
          "Escape",
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "Home",
          "End",
          "PageUp",
          "PageDown",
        ]),
      }),
      z.strictObject({ type: z.literal("text"), text: z.string().max(1024) }),
    ])
    .parse(req.body?.input);
  const operationId = z.uuid().parse(req.body?.operationId);
  return res.json(
    await localBrowserPageOperation(
      team,
      idOf(req),
      operationId,
      "input",
      input,
    ),
  );
});
// No target HTML or browser-wide debugger is embedded. The fragment ticket is
// sent only in a header and is scoped to this session's screenshot/input API.
export const localBrowserView = handle(async (req, res) => {
  idOf(req);
  res.setHeader(
    "content-security-policy",
    "default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  res.setHeader("referrer-policy", "no-referrer");
  return res.type("html")
    .send(`<!doctype html><meta charset="utf-8"><title>Browser handoff</title><style>body{margin:20px;background:#151515;color:#eee;font:16px system-ui}img{max-width:100%;border:1px solid #555;cursor:pointer}input{min-width:260px}button,input{padding:8px;margin:8px}#status{min-height:24px}</style><p>Complete the required step in this tab, then resume the session through the API.</p><div id="status">Connecting…</div><img id="screen" tabindex="0" alt="Retained browser tab"><div><input id="text" placeholder="Text to type"><button id="type">Type</button><button id="tab">Tab</button><button id="enter">Enter</button><button id="back">Backspace</button></div><script>
const base=location.pathname.replace(/\\/view$/,''),ticket=location.hash.slice(1);history.replaceState(null,'',location.pathname);let busy=false,ended=false,w=0,h=0;const status=document.querySelector('#status'),screen=document.querySelector('#screen');
async function call(path,body){const r=await fetch(base+'/handoff/'+path,{method:body?'POST':'GET',headers:{'x-browser-handoff':ticket,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await r.json();if(!r.ok){if(r.status!==409)ended=true;throw Error(result.error||'Session unavailable')}return result}
async function refresh(){if(busy||ended)return;busy=true;try{const r=await call('snapshot');screen.src='data:image/jpeg;base64,'+r.image;w=r.width;h=r.height;status.textContent='Connected'}catch(e){status.textContent=e.message}finally{busy=false}}
async function input(value){if(busy||ended)return;busy=true;try{await call('input',{operationId:crypto.randomUUID(),input:value})}catch(e){status.textContent=e.message}finally{busy=false;refresh()}}
screen.onclick=e=>{const r=screen.getBoundingClientRect();input({type:'click',x:(e.clientX-r.left)*w/r.width,y:(e.clientY-r.top)*h/r.height})};document.querySelector('#type').onclick=()=>{input({type:'text',text:document.querySelector('#text').value});document.querySelector('#text').value=''};for(const [id,key]of[['tab','Tab'],['enter','Enter'],['back','Backspace']])document.querySelector('#'+id).onclick=()=>input({type:'key',key});setInterval(refresh,1500);refresh();</script>`);
});
