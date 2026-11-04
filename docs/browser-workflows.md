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
cancelled by one caller. By default, a dispatched scrape's failure is returned
without replay on another owner. A lost response is always terminal. The explicit
stateless engine fallback described below can retry a confirmed, closed-page
failure once on a distinct engine. Retained sessions continue to use
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

## Optional alternative browser

Chromium remains the default. Build a Firefox-capable browser image with
`--build-arg INSTALL_CAMOUFOX=true`, then set `BROWSER_ENGINE=camoufox` on that
owner, with `BROWSER_CHANNEL` empty. The pinned launcher is `camoufox@0.5.9`,
with `playwright-core@1.62.0` and browser `official/158.0.1-beta.41`.
For a host installation, run `pnpm prepare:camoufox` in the browser service
before starting the owner. The binary and identity model are provisioned before
serving requests; a missing pinned binary fails startup. Firefox ignores the
Chromium launch arguments and uses the host OS identity, with WebRTC and alternate
DNS disabled. The existing filtering proxy checks every destination, including
localhost; it is not an upstream egress proxy.

WebKit is another opt-in owner. Build with `--build-arg INSTALL_WEBKIT=true`,
then run that image in a **dedicated Docker network namespace**, with
`--user root --cap-add=NET_ADMIN`, `BROWSER_ENGINE=webkit` and `BROWSER_CHANNEL`
empty. Use the image's ordinary entrypoint. Do not use host networking, a shared
network namespace or host filesystem mounts for this owner. The entrypoint
installs container-local IPv4/IPv6 UID rules and drops NET_ADMIN/NET_RAW before
starting the API. The trusted service remains root with a restricted capability
set for browser UID changes and cleanup; the browser runs as UID 1000 with no
capabilities and NoNewPrivs. Application files and the installed binary must be
root-owned. Its child environment contains only the executable path, fixed PATH
and display/locale settings, excluding service credentials and loader overrides.
The privilege-drop behavior follows [setpriv](https://man7.org/linux/man-pages/man1/setpriv.1.html).

`BROWSER_FILTER_PORT` defaults to `3004`; set the same unprivileged TCP port for
startup and the service, and keep it distinct from `PORT`. The browser can send
TCP only to the destination filter on that loopback port; all other IPv4/IPv6
traffic, including direct RTC transport, is rejected. A missing policy, missing
capability, mismatched port or unsafe file ownership fails startup. Do not
publish the filter port. Leave `ALLOW_LOCAL_WEBHOOKS` disabled for public-target
operation. Standard CA certificates are installed and TLS verification remains
enabled. The owned integration tests explicitly enable private fixture access;
they are not public benchmark runs.

A WebKit owner can replace a member of the primary or alternate URL lists below;
the existing distinct-engine/boot, closed-page and one-alternate rules still
apply. A heterogeneous alternate list uses the existing round-robin selection;
it does not try every engine. WebKit is an upstream Playwright build, not
installed Safari. The latest complete proxy-free API measurement is linked
below; selected-site results alone do not establish overall coverage, and
comparable hosted performance remains unproven.

Blob-backed subresources use their HTTP/HTTPS origin for the same private-address
and ad checks before browser-local resolution. Top-level blob targets/navigations
and opaque blob origins remain unsupported; worker network requests still pass
through the destination filter. A confirmed WebKit `page.goto` connection
termination is reported as `NETWORK_ERROR` with
`networkErrorCode: WEBKIT_CONNECTION_TERMINATED`, making it eligible for the same
bounded opt-in fallback as other transport failures. This classification does
not cover certificate rejection, other TLS failures, page crashes or evaluation
exceptions. A separate exact WebKit navigation message for premature TLS
handshake termination maps to `NETWORK_ERROR` /
`WEBKIT_TLS_HANDSHAKE_TERMINATED`. It preserves TLS verification and does not
classify certificate rejection, other TLS errors or evaluation exceptions.

Configure a separate internal owner pool on the API and workers:

```dotenv
LOCAL_BROWSER_OWNER_URLS=http://chromium-a:3003,http://chromium-b:3003
LOCAL_BROWSER_FALLBACK_OWNER_URLS=http://firefox-a:3003,http://firefox-b:3003
```

Opt in on an individual scrape:

```json
{
  "url": "https://example.com/product/42",
  "formats": ["rawHtml", "markdown"],
  "timeout": 90000,
  "browserControls": {
    "workflow": "auto",
    "consent": "rejectNonEssential",
    "navigationTimeout": 30000,
    "maxAttempts": 1,
    "engineFallback": true
  }
}
```

Fallback requires a stateless request without actions and `maxAttempts: 1`.
Session creation and session scrapes reject it. Missing alternate configuration
fails before primary dispatch. A successful primary response uses no alternate.
Eligible failures are recognized verification/loading states, selected HTTP
denials/transient statuses (400, 403, 406, 417, 429, 502, 503, 504), the filtering
proxy's connection-reset status 595, or a structured network/timeout error.
A `PAGE_CRASHED` failure also qualifies only when the owner observed the Page
crash event and its document receipt includes `rendererCrashed: true`. A driver
error mentioning a crash is insufficient. Crashes do not add an internal service
retry; the explicit one-alternate policy and original deadline still apply.
For the final attempt of an owned stateless request, the service attempts bounded
disposal of the whole context before returning completion. `contextClosed: true` records
a fulfilled context-close operation; `pageClosed` still comes from the Page
close observation and remains mandatory for fallback. The context flag alone
does not authorize another fetch. A context-close timeout may still be followed
by independently confirmed Page closure; keep the two observations separate.
Intermediate retries and retained cookie leases close only their current page,
while retained workflow tabs stay open.
Unfinished cleanup stays unconfirmed and is bounded rather than awaited forever.
Before another dispatch the API requires one completed primary attempt,
`pageClosed: true` and matching owner boot identity. An ambiguous response,
transport loss, failed cleanup, or exhausted budget is never replayed.
Here HTTP 400 means the retrieved target page's status. A browser-service
request-validation error stays terminal; it does not authorize another fetch.
The workflow states `HUMAN_REQUIRED` and `VERIFICATION_REQUIRED` also qualify
when no legacy vendor signature was returned. The same completion, ownership,
single-alternate and deadline requirements apply. A supplied alternate workflow
state must be `CONTENT_READY` before it can count as recovered content; HTTP 200
alone cannot promote a login, region selector or verification page. Older owners
that omit workflow state retain the other existing response checks.

For a recognized HTTPS Amazon product URL with `workflow: "auto"`, a confirmed
`WORKFLOW_NAVIGATION_MISMATCH` may also trigger this opt-in alternate request.
It fetches the original URL in a fresh context on the other engine; the failed
document is never promoted. Other workflow/domain identity errors stay terminal.
Successful captures must retain the requested ASIN on an accepted Amazon HTTPS
host, including when no continuation form appeared. The API checks the returned
URL too, so an older owner cannot promote another product or omit the landed URL
and claim recovery. Foreign hosts, nonstandard ports and credential-bearing
URLs do not establish that identity. A failed or wrong-product alternate never
causes a third dispatch. This is a URL-identity check, not field-level extraction
proof; returned content must still be evaluated for the caller's purpose.

At most one healthy owner with a different boot identity **and** browser engine
can run the second attempt. Each API process rotates the starting candidate in
the configured alternate list, skipping unhealthy or ineligible owners during
discovery. This shares stateless fallback requests across eligible owners; it
does not coordinate load or admission across API processes. Once an alternate
request is dispatched, its failure or lost response cannot select another pool
member. Retained sessions keep their recorded owner.

Both attempts and owner discovery share the original
deadline; the alternate needs enough remaining time for the requested wait and
readiness budget. Known primary failure content is preserved if the alternate
also fails. `metadata.browser.diagnostics.engineFallback` reports attempted,
usedSecondary, recovered, skipped and completed attempt receipts when available.
`usedSecondary` alone does not mean content recovery. Failed HTTP responses may
include top-level `diagnostics.attempts` and `diagnostics.engineFallback`; these
closed-attempt receipts survive queue error serialization. They retain the engine,
boot identity, network alias and bounded document phase/navigation/failure
observations. Diagnostic URLs omit user information, query and fragment. Unknown
fields and document content are not copied into these receipts. When both engines
throw confirmed errors, the returned error preserves both receipts. A lost alternate
response preserves the known primary receipt and `outcomeUnknown: true`, without
inventing alternate completion or dispatching another request. An opt-out error
can return its confirmed primary receipt without enabling recovery. Errors with
unconfirmed completion may still lack a receipt; use owner logs to account for
those dispatches. No CAPTCHA
answers are generated or submitted. A browser change cannot promise access or
content completeness, and an additional owner consumes additional resources.

`browserControls.navigationTimeout` optionally caps the initial navigation in
milliseconds (100–120,000), including HTTP redirects until the chosen `waitUntil`
event. The overall scrape deadline still bounds the request. Consent, readiness,
post-load waits and later workflow/action navigation keep their existing budgets;
continuing a retained tab performs no initial navigation. A deliberately short
cap can fail a slow document even when the overall deadline has time left. Omit
the control to preserve the existing navigation budget.

Best Buy's country recipe separately bounds its combined document/link discovery
to five seconds, including time spent awaiting either browser query. Expired
read results cannot trigger a later link query or navigation. A validated
country destination must still preserve the requested origin, product path and
SKU. The native country navigation has its own 30-second maximum, within the
caller deadline. It is awaited under that native timeout; unfinished navigation
fails the browser attempt before capture. The initial `navigationTimeout`
control keeps its existing meaning.

Failure receipts distinguish `workflow-country-text`, `workflow-country-links`
and `workflow-country-navigation`. The API forwards these fixed phase values
through queued errors while retaining URL redaction and bounded diagnostics.
The original deadline/cancellation still wins. One opted-in alternate can run
only after the existing ownership, Page-close and remaining-time checks pass;
these recipe bounds do not guarantee alternate budget after every other phase.
A slow but otherwise valid selector or navigation may now fail earlier.

With `engineFallback: true`, each engine receives the same navigation cap. A
confirmed closed-page navigation timeout can therefore leave time for one
alternate engine, subject to the existing shared deadline and completion guards.
Owners advertise `capabilities.navigationTimeout: true`; the API skips older
stateless owners before dispatch and checks retained ownership before using this
control. It fails explicitly when no compatible primary owner is available.
JavaScript uses `navigationTimeout`; Python accepts `navigation_timeout` and
serializes the same API field.

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

For `rejectNonEssential`, a visible OneTrust banner without a unique visible
Reject button can use a bounded native preference-center path. Standard
OneTrust settings openers are supported; Canada Goose's observed
`button[data-cookie-settings][aria-haspopup="dialog"]` is scoped to that site's
hosts. The path requires one known category panel/save control, an unchanged
C0001 Always Active marker and unique matching optional category IDs. Mutable
required categories, disabled/read-only switches and unknown layouts are not
interpreted as opt-out choices.

The browser clicks associated labels for zero-area OneTrust checkbox inputs,
checks that each optional category became unchecked and rechecks the complete
category identity/state before one Save operation. It reports applied only
after Save completes and both preference panel and banner become hidden.
Checked categories have one native toggle operation; already-unchecked choices
are left alone. The path has a five-second budget with at most one second per
native operation, within the caller deadline. Native actions are awaited, while
only read-only probes are raced. No Accept/Close substitution, forced/synthetic
click or OneTrust JavaScript API call is added. `off` and `acceptAll` keep their
own behavior.

`interaction.consent.preferenceCenter` reports phase, outcome/reason, settings
and save completion, category action attempts/completions, confirmed category
changes and duration. A layout/state change or incomplete operation stays
unresolved; native action counters distinguish attempted effects from confirmed
choices. Applied is an observed UI outcome, not independent proof of server-side
cookie persistence or completion across every embedded origin. This
[owned before/after and queued-API verification](benchmarks/onetrust-preferences-results-2026-11-04.json)
establishes a functional workflow repair; a new full population score is pending.

`workflow` is `none` (default), `auto`, `bestbuy-us@1` or `product-details@1`.
The current recipes select the original Best Buy product's US destination and
expand an observed Canada Goose details control. `auto` also scrolls an observed
CoinMarketCap About section into view to trigger public, viewport-based hydration.
Canada Goose's product-details expansion is optional. Discovery and expansion
confirmation each have a one-second read-only probe budget; one native click
has at most two seconds, within the caller's deadline. No forced or repeated
click is added. A completed click reports `expanded` only after observing
`aria-expanded="true"`. An unfinished probe, click or confirmation instead
records `steps[].outcome: "unresolved"` and a reason under
`observations.productDetails`, then allows a current document capture. Caller
expiry/cancellation and non-timeout browser failures remain terminal. Expired
read-only probes cannot queue a later click. Native click timeout does not prove
that no action happened; `clickCompleted` records driver completion, not content
completeness.

Body readiness may be satisfied while an optional step is unresolved. Use explicit
readiness when a caller requires expanded content; that requirement remains
unsatisfied if the content is hidden. Markdown conversion may include hidden
HTML text and is not proof of visible content or successful expansion.

For Amazon.com product URLs, `auto` can submit the observed one-button GET
continuation form when it has exactly the three known hidden inputs and no
answer-entry controls or iframe. Hidden values remain unchanged. It submits at most once
per browser attempt, keeps the same context, and returns from the storefront to
the original product. It checks origin and product identity again at capture;
another product is an explicit `WORKFLOW_NAVIGATION_MISMATCH` failure. Visible
answer fields and other interactive verification remain unresolved for handoff.
The diagnostic step is `amazon-continue@1`, not a new public workflow value.
If automatic readiness discovers this form after the initial workflow probe,
stateless requests without caller actions can check the same recipe once more.
It still submits at most once per browser attempt. Retained/continuing sessions
and explicit readiness do not perform this late check. Any subsequent rendered
readiness wait uses the remaining original allowance; the recipe's navigation
and settle work stays within the original scrape deadline.
The recipe registers the main-frame navigation listener before its GET click,
then waits for the submission's navigation commit. It samples the resulting URL
and unresolved form controls together in one renderer call, allowing up to five
seconds for a delayed continuation within the original request deadline.
An unresolved form stays verification; another origin or product stays a
navigation mismatch. The recipe still submits at most once and returns to the
original product at most once.

When `auto` has no explicit selector/text readiness condition, it waits up to
the readiness budget (five seconds by default) for an empty/loading body or a
passive verification page to produce rendered text. It does not use a known
answer string or wait for global network idleness. Metadata includes
`readiness.automatic` with the observed outcome and time. A body that stays
empty/loading is not `CONTENT_READY`; recognized Amazon/Akamai verification
shells remain verification states. Short real text is accepted. Explicit
readiness and JSON/plain-text response handling keep their separate contracts.
This is a text-readiness check, not proof that every field or lazy section loaded.
For automatic checks, rendered main landmarks supply readiness text when they
exist, with body text as the fallback. Footer/navigation labels cannot satisfy
an empty main landmark. Text wholly outside the document's negative bounds,
including off-screen font probes, is ignored for this check; ordinary below-fold
content remains eligible. The bounded probe reads at most 20,000 text nodes and
4,096 characters and tolerates a temporarily absent document root during
navigation. Returned body text and explicit caller text/title checks retain
their existing scope.

Automatic readiness also waits while the current HTML document is still being
parsed, including a new document reached by a passive redirect. This uses the
same readiness budget; it does not wait for every image or for network idle.
`readiness.automatic.documentReadyState` records the captured document state.
A hidden or otherwise unrendered body cannot satisfy body-text readiness through
the browser's `innerText` fallback to script/text content. Rendered children of a
`display: contents` body remain supported. A stream that stays open can return
partial content with an unresolved readiness outcome when the budget expires.

Automatic readiness also recognizes the observed small AWS connection
interstitial served with HTTP 403: the `Verifying Connection` title, AWS edge
challenge script, local interstitial script, loading/status containers and
waiting or verified-redirecting message must agree. Its own scripts may finish
within the existing readiness allowance. Once recognized, changing the status
label does not make that error document ready; a successful response must arrive.
An unresolved page retains verification/readiness failure. This does not add a
fixed delay to ordinary denials or change explicit selector/text waits.

Automatic readiness also waits for visible `aria-busy="true"` regions inside a
visible `main` or `[role="main"]`, including a busy ancestor of that main region.
If there is no visible main region, it checks the body. Hidden, inert,
accessibility-hidden and offscreen busy elements are ignored, as are explicit
advertisement regions with `data-ad-status` and an advertising accessibility label.
Busy native `aside` elements without a role override, and explicit
`role="complementary"` regions, do not delay primary readiness when they sit
inside a visible main landmark. A main inside such a region, a busy ancestor
of main, and body fallback without a visible main retain their busy signals.
This uses author-provided supporting-content semantics; it does not establish
that all sidebar content has loaded. Busy navigation outside an existing main
region does not delay it. The final capture checks the signal again. Metadata
includes `busyCount`, `maxBusyCount`, `ignoredComplementaryBusyCount` and `busyScope` in
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

Automatic readiness also recognizes the observed eBay passive browser-check
shell and waits for its own redirect within the configured readiness budget.
It does not submit the continuation form. AWS WAF action headers distinguish
passive challenges from interactive CAPTCHA responses; known small AWS CAPTCHA
documents and HUMAN containers on dedicated verification routes remain explicit
verification states. Interactive detections report `HUMAN_REQUIRED` without
clicking or answering a challenge. Ordinary pages embedding SDK widgets are not
classified from the SDK alone. Unicode format characters alone cannot satisfy
body readiness; real text must appear or the bounded wait stays unresolved.

The observed large Alibaba `Captcha Interception` document is also an explicit
verification outcome. Its title, short non-script body text, Baxia container,
same-origin verification form and both specific trusted CDN script paths must
agree. The check is bounded to 262,144 characters; ordinary SDK use, quoted
examples, comments and partial signatures do not establish interception.
It reports `HUMAN_REQUIRED` and unsatisfied readiness without operating any
verification control. With `engineFallback: true`, the existing stateless,
closed-page, distinct-engine and deadline rules may allow one alternate.
This is recognition of an observed document, not universal Alibaba coverage.

The observed Autotrader HTTP 200 unavailability block is an explicit denial.
Its exact title, short non-script warning, incident reference, support-form ID
and both local block-page asset paths must agree within the existing
65,536-character signature cap. It reports `ACCESS_DENIED`, unsatisfied
readiness and `readiness.automatic.outcome: "blocked"`; automatic readiness
stops polling that known block. Ordinary vehicle content, isolated maintenance
text, a contact CAPTCHA, quoted examples and partial signatures do not establish
this denial. Support and verification forms are not operated. Existing opted-in
stateless fallback may still use one distinct engine after confirmed Page
closure, subject to its original deadline. This is an observed document
signature rather than universal Autotrader or Akamai coverage.

`maxAttempts` defaults to one. Opt-in retries recognize coded phase deadlines
and transient connection/HTTP2 errors, while cancellation, session errors,
workflow identity mismatches and hard status failures remain terminal. Attempt
budgets preserve requested fixed/readiness waits before dividing the available
time. A retry requires the previous stateless tab to finish closing; retained
workflow tabs and commands with actions keep their existing single-attempt rule.
Diagnostics include each attempt's budget and tab-close observation.

Firefox transport diagnostics retain observed `NS_ERROR_*` network codes.
Explicit stateless retries recognize reset, interrupted-transfer and timeout
codes, alongside the existing Chromium transient cases. DNS/refused-connection
codes remain typed network failures without becoming transient retry candidates.
Certificate, policy, native cancellation and unknown failures are not promoted
to transient transport errors. The default attempt count remains one.

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
Authentication route hints use the final URL's path, excluding query strings,
fragments and partial names such as `login-guide`. Root login/sign-in HTML pages
with a rendered sign-in prompt also report `AUTH_REQUIRED`, including
email-first forms that have no password field. This classifies the returned
document; it does not sign in or establish that the requested content is present.
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

The [complete API rerun after Alibaba interception recognition](benchmarks/alibaba-full-api-results-2026-11-04.json)
matched 59/100 normalized markers with direct VN egress, a four-worker cap,
100 API requests and 157 browser captures. It supersedes the earlier
selected four-target observation for population measurement. The prior complete
run matched 54/100; live-epoch differences prevent an isolated causal claim.
The historical hosted82 reference was not refreshed, and parity remains unproven.

The [complete API rerun after Autotrader access-block recognition](benchmarks/autotrader-full-api-results-2026-11-04.json)
matched 61/100 normalized markers with direct VN egress, a four-worker cap,
100 API requests and 158 browser captures. It supplies population measurement
separately from the selected cohort. The preceding complete result was 59/100;
live-epoch differences prevent an isolated causal claim. The historical hosted
82/100 reference was not refreshed; comparable coverage remains unproven.


The [complete API rerun after optional Details and bounded country workflow repairs](benchmarks/country-budget-full-api-results-2026-11-04.json)
matched 57/100 normalized markers, 56 screened markers and 54 normalized markers
also present in Markdown. It used direct VN egress, a four-worker cap, 100 API
requests and 157 browser captures, with no hosted calls, upstream proxies, client
retries or expected-text hints. This is the latest complete population result;
the preceding complete run matched 61/100. Five lost targets and one new match
are documented with their actual navigation/status receipts. Different live
epochs do not isolate a code, IP, WAF or resource cause. No workflow-phase
failures occurred, and 40 of 43 failed targets already used their alternate.
The historical hosted82 observation was not refreshed; parity remains unproven.
All Page closes are confirmed; one Carter's context-close receipt remains
unconfirmed despite final owners reporting zero pages/sessions. Candidate
implementation checks and CI are inherited without rerunning unchanged inputs;
this phase supplies fresh full retrieval evidence, replay audits, an owned
offline identity probe and scoped Docker cleanup.
