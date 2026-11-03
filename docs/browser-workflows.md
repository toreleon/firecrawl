# Local browser workflows

The self-hosted browser supports explicit readiness, CMP consent rules, bounded
actions, country/product navigation recipes, retained tabs and page-scoped human
handoff. The v2 API forwards these controls to the browser. Ordinary requests
without `browserControls` keep their existing engine selection and defaults.

## Configure

Set `PLAYWRIGHT_MICROSERVICE_URL` to the service's `/scrape` URL. For durable local
workflow sessions, also set:

```dotenv
LOCAL_BROWSER_DATABASE_URL=postgresql://USER:PASSWORD@HOST/SESSION_DATABASE
LOCAL_BROWSER_SESSION_SECRET=YOUR_SHARED_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
LOCAL_BROWSER_OWNER_URLS=http://browser-a:3003,http://browser-b:3003
BROWSER_SERVICE_AUTH_TOKEN=YOUR_SHARED_INTERNAL_BROWSER_SECRET
```

Use the same session secret across API/worker replicas. The session database may
be the NUQ PostgreSQL database; `NUQ_DATABASE_URL` is the fallback. The dedicated
pool has four connections per process. The first session operation provisions
the two `firecrawl_local_browser_*` tables in a short transaction under a schema
lock; provision them before restricting the application's DDL permission. The
schema is exported as `localBrowserSchema` in `src/lib/local-browser/store.ts`.

Set `BROWSER_SERVICE_AUTH_TOKEN` on every browser owner too. Keep owner URLs on
the internal network and use a separate address for each owner. An address that
can switch between browser processes will fail the boot-identity check. Each
owner advertises a unique process boot ID and its
capabilities; commands addressed to an old process fail. Existing Firecrawl API
authentication supplies the team identity. Authentication-disabled installations
have the existing single `bypass` identity and must remain on a trusted network.

For stateless requests with `browserControls`, the API rotates across
`LOCAL_BROWSER_OWNER_URLS` per API process, with a randomized starting position.
It can choose another owner if health discovery fails before dispatch. Discovery
shares the caller's deadline and cancellation; a shared health probe is not
cancelled by one caller. Once a scrape is dispatched, its failure or lost response
is returned without replay on another owner. Retained sessions continue to use
their recorded owner. `metadata.browser.diagnostics.ownerBootId` identifies the
process that executed a capture. Requests without `browserControls` retain their
existing engine path. This is round-robin distribution, not a distributed load
balancer or a guarantee of equal utilization across API replicas.

The browser's optional `BLOCK_MEDIA=true` setting blocks image and media
subresources by resource type, after URL/security checks. It preserves scripts,
styles and explicitly requested documents, including an image document. Its
default remains `false`; enabling it can change image-dependent workflows and
human handoff screenshots. `/health` exposes the effective `blockMedia` value.

Do not configure `PROXY_SERVER` for direct-egress operation. No proxy pool,
rotation, external CAPTCHA solver or paid model is required by this feature.

## Scrape controls

```json
{
  "url": "https://example.com/product/42",
  "formats": ["rawHtml"],
  "timeout": 30000,
  "browserControls": {
    "waitUntil": "domcontentloaded",
    "readiness": {
      "selector": "main",
      "text": "Product 42",
      "scope": "body",
      "timeoutMs": 5000
    },
    "consent": "rejectNonEssential",
    "workflow": "auto",
    "maxAttempts": 1
  }
}
```

Selector and text are AND conditions. Text is checked against rendered body text
unless scope is explicitly `title`. Readiness is checked again against the final
document capture, and metadata includes the document revision. A title assertion
does not establish body content completeness. JSON/text responses use their raw
body for text readiness.

Consent defaults to `off`. Autoconsent 17.3.0 provides CMP rules, with frame-local
message routing; cosmetic hiding, generated rules and heuristic detection are
disabled. Page-supplied eval messages are not executed. Explicit OneTrust,
Cookiebot, Didomi and Bing controls cover recognized DOM-based choices.
For retained tabs the library detects CMPs without automatic background actions;
explicit awaited controls handle the choice. This keeps consent actions from
racing a human handoff. Consent diagnostics report applied/unresolved/not-detected
and available self-test results. This is not universal CMP coverage or proof of a
site's stored choice.

Explicit consent discovery uses one combined visible-container query on frames
without a known CMP, rather than four separate visibility calls. It reserves up
to three seconds for a cold main frame, one second per auxiliary-frame probe,
and five seconds for the discovery window, all within the scrape deadline.
Known choice clicks and hidden-overlay waits keep their respective 1.5/1 second
bounds. These are separate from `readiness.timeoutMs`.

Only read-only discovery is raced against these probe budgets. An expired result
is discarded, with deadline checks before subsequent queries and before any
click. An unresponsive embedded frame can therefore be skipped without leaving
a late choice queued for a retained page or human handoff. This bounds waiting;
it does not claim that the browser cancelled the underlying read-only RPC.
The latest explicit pass reports frame counts, main/auxiliary probe timeouts,
probe/action errors, scan-limit exhaustion and duration under
`interaction.consent.diagnostics`. Incomplete discovery is reported unresolved
when no choice was applied. Neither a successful scrape nor one applied CMP
choice proves consent completion across every embedded origin.

`workflow` is `none` (default), `auto`, `bestbuy-us@1` or `product-details@1`.
The current recipes select the original Best Buy product's US destination and
expand an observed Canada Goose details control. `auto` also scrolls an observed
CoinMarketCap About section into view to trigger public, viewport-based hydration.
For Amazon.com product URLs, `auto` can submit the observed one-button GET
continuation form when it has exactly the three known hidden inputs and no
answer-entry controls or iframe. Hidden values remain unchanged. It submits at most once
per browser attempt, keeps the same context, and returns from the storefront to
the original product. It checks origin and product identity again at capture;
another product is an explicit `WORKFLOW_NAVIGATION_MISMATCH` failure. Visible
answer fields and other interactive verification remain unresolved for handoff.
The diagnostic step is `amazon-continue@1`, not a new public workflow value.

When `auto` has no explicit selector/text readiness condition, it waits up to
the readiness budget (five seconds by default) for an empty/loading body or a
passive verification page to produce rendered text. It does not use a known
answer string or wait for global network idleness. Metadata includes
`readiness.automatic` with the observed outcome and time. A body that stays
empty/loading is not `CONTENT_READY`; recognized Amazon/Akamai verification
shells remain verification states. Short real text is accepted. Explicit
readiness and JSON/plain-text response handling keep their separate contracts.
This is a text-readiness check, not proof that every field or lazy section loaded.

Automatic readiness also waits for visible `aria-busy="true"` regions inside a
visible `main` or `[role="main"]`, including a busy ancestor of that main region.
If there is no visible main region, it checks the body. Hidden, inert,
accessibility-hidden and offscreen busy elements are ignored, as are explicit
advertisement regions with `data-ad-status` and an advertising accessibility label. Busy navigation
outside an existing main region does not delay it. The final capture checks the
signal again. Metadata includes `busyCount`, `maxBusyCount` and `busyScope` in
`readiness.automatic`. A remaining busy region yields outcome `busy` and
`CONTENT_NOT_READY`, within the shared request deadline.

Tune this budget through v2 without supplying a selector or expected text:

```json
{
  "browserControls": {
    "workflow": "auto",
    "readiness": { "timeoutMs": 1500 }
  }
}
```

A timeout-only readiness object requires `workflow: "auto"` and uses body scope.
Explicit selector/text conditions retain their own contract and take precedence.
Nonempty partial captures may still return HTTP 200 with unresolved browser
metadata; inspect readiness and interaction state before treating them as complete.
Recognized Google unusual-traffic forms remain verification states, and are not
automatically retried as ordinary HTTP 429 responses. They require explicit
verification handling rather than an automatic form submission.

`maxAttempts` defaults to one. Opt-in retries recognize coded phase deadlines
and transient connection/HTTP2 errors, while cancellation, session errors,
workflow identity mismatches and hard status failures remain terminal. Attempt
budgets preserve requested fixed/readiness waits before dividing the available
time. A retry requires the previous stateless tab to finish closing; retained
workflow tabs and commands with actions keep their existing single-attempt rule.
Diagnostics include each attempt's budget and tab-close observation.

A recipe and caller actions
cannot be combined. Version recipes deliberately as sites change.

Alternatively supply existing `actions` with `browserControls: {}`. Supported
local actions are a single-element `click`, `wait`, `write`, `press`, `scroll`
and `scrape`. Bulk clicks and JavaScript/PDF/screenshot actions are rejected
before execution. Screenshot/branding/rawBase64/audio/video output formats,
cloud profiles, mobile/location/proxy overrides and lockdown are unavailable
with these local controls. These limits do not change ordinary cloud-engine
requests. JS and Python v2 SDKs serialize the new options; other SDKs can use
the HTTP contract directly. v1 has no local-browser-controls contract.

New local controls verify TLS by default; set `skipTlsVerification` explicitly
only when required. Sessions bind that setting, UA, consent policy, resource
policy and origin at creation. Use matching settings on subsequent scrapes.

The API requires this backend rather than accepting cached/fetch/provider output
for a workflow. It skips shared index reads and writes, prevents proxy feature
escalation and parallel engine fallback, forwards structured failures and places
safe details under `data.metadata.browser`. Private browser capability tokens
are encrypted in PostgreSQL and do not appear in the public response or queue
payload. Scrape deadlines are stamped before dispatch and carried through the
queue where internal request context exists; remaining budgets are bounded at
the adapter and browser. Interactive commands use one attempt.

If a controlled browser returns no usable text for a Markdown-dependent output,
the API returns HTTP 422 with a typed `CONTENT_NOT_READY`,
`VERIFICATION_REQUIRED`, `HUMAN_REQUIRED` or `ACCESS_DENIED` code, rather than
losing the cause in a generic engine failure. Raw-HTML responses can still carry
their captured document and explicit readiness/error metadata.

## Retained tabs and multiple workers

`POST /v2/browser/sessions` accepts `url`, optional `creationId` (a caller-generated
UUID for safe creation retries), optional `browserControls` without session/retry
fields, `headers`, `blockAds`, `skipTlsVerification` and `timeout`. It navigates
once and returns `{id,state,expiresAt}` plus initial interaction diagnostics.
Reusing a creation ID with different options is rejected. Pending/lost/closed
creations are never silently replaced under that ID.

Use the returned public ID with `POST /v2/scrape`:

```json
{
  "url": "https://example.com/product/42",
  "formats": ["rawHtml"],
  "browserControls": {
    "sessionId": "PUBLIC_UUID_FROM_CREATION",
    "continueSession": true,
    "readiness": {"selector": "main", "text": "Product 42"}
  }
}
```

`continueSession: true` uses the existing tab without navigating. Otherwise a
session scrape deliberately navigates the retained tab. A closed tab is a lost
workflow, not an instruction to open a replacement. Sessions are exact-origin
bound, including top-level navigation. Cross-origin login workflows are not
implemented; third-party subresources still pass the normal network controls.

Any worker resolves the owning browser through the PostgreSQL directory. A row
lock serializes dispatch, each command carries an increasing revision and owner
boot ID, and the owner also enforces exclusivity. Completion and its encrypted
result commit atomically. Duplicate operations can return a recorded result;
uncertain external actions are not retried. Losing a browser process or an
unacknowledged response ends the session rather than migrating live state.
The reconciler checks idle owners and expires/closes sessions. This is fixed
ownership with explicit loss, not live browser migration or exactly-once effects
on external websites.

Limits: eight live sessions per team, browser-owner capacity configured through
`MAX_BROWSER_SESSIONS`, five-minute absolute API session TTL (or an earlier
browser expiry), 1,000 operations per session. Snapshots are not stored as durable
images. Encrypted result retention is capped at 5 MiB per result and 20 MiB per
session; a completed operation whose large result was not retained returns
`OPERATION_RESULT_UNAVAILABLE` on replay rather than rerunning. Explicit delete
revokes routing immediately; failed browser cleanup remains pending for the
reconciler. Closed directory records expire after one day; result/capability data
is removed when closed. A capability returned after creation was closed is never
published and receives a direct cleanup attempt; if that attempt fails, the
browser owner's TTL bounds its lifetime. The secret currently has no
key-rotation/migration API.

`GET /v2/browser/sessions/:id` reads public status. `DELETE` closes it. A single
mutable session ID is rejected in batch/crawl; stateless controls/recipes can be
inherited through those paths. Durable sessions are rejected under ZDR and safe
mode. Ordinary threat policy and blocklist checks remain in force.

## Human handoff

`POST /v2/browser/sessions/:id/handoff` pauses automation and returns an expiring
`viewPath`. Open that path on the API origin. Its fragment ticket is exchanged
only through the handoff header, and the viewer removes it from the address bar.
The viewer shows screenshots of this exact Page and permits viewport clicks,
typed text and a restricted set of navigation/editing keys. It does not expose
the shared desktop, arbitrary code execution or a browser-wide CDP endpoint.

`POST /v2/browser/sessions/:id/resume` (optional `operationId` UUID) revokes the
viewer ticket, re-checks the same tab and returns the resulting content/state.
The viewer's completion is not evidence that verification succeeded. Site
verification, authentication and access denial remain explicit outcomes.
Handoff does not extend the session TTL or hold a queue worker/DB transaction
open. Human-assisted completion must be reported separately from automation.

## Benchmark

The existing frozen 100-target runner now accepts:

```sh
pnpm benchmark:waf --attempts=5 --concurrency=2 --timeout=90000 \
  --readiness=text --readiness-timeout=5000 --wait-until=domcontentloaded \
  --consent=rejectNonEssential --workflow=auto --max-attempts=1 \
  --evidence=all --out=UNIQUE_OUTPUT_DIRECTORY
```

The benchmark remains fresh-context, unattended and direct to the browser backend;
it does not warm sessions or count human handoffs. The API, PostgreSQL ownership
and handoff path have separate harness acceptance tests. Preserve the frozen raw,
screened and normalized graders. Run on an awake host and retain image/source,
full response evidence, hashes, timing and resource receipts. Do not treat a
title/body predicate correction as a new WAF bypass.

The resource filter keeps application content from `fbcdn.net`, requested main
documents and first-party resources. Third-party advertising domains remain
filtered; bounded blocked-host counts are included in diagnostics. On small,
static HTTP error documents the browser skips a futile text-readiness poll.
The original response must contain no executable scripts, frame content,
event handlers or refresh directive; active error pages retain their full wait.
Error responses preserve the operation phase, recent navigation/failure events
and complete Chromium network-error names, including numeric protocol names.

The [November 3 workflow rerun](anti-bot-research.md#browser-workflows-and-distributed-ownership)
completed all 500 attempts with no upstream proxy. Normalized marker matches
were 199/500 (39.8%), compared with 213/500 (42.6%) in the earlier full run.
Best Buy's country recipe retrieved the product on 2/5 attempts; the aggregate
unattended rate did not improve. The report records limits and separate API,
ownership and handoff validation.

The subsequent [failed-target investigation and repaired rerun](anti-bot-research.md#failed-target-investigation-and-repairs)
found and fixed application-CDN blocking and viewport-triggered content loading.
Both Facebook and CoinMarketCap moved from 0/5 to 5/5 normalized matches. The
complete repaired run matched on 209/500 (41.8%) with the frozen grader and no
upstream proxy. The report includes the 78-request controls-on/off comparison,
all failed-target findings, timing and remaining origin/verification failures.
