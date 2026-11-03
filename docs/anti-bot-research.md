# Open-source browser anti-detection integration

Initial browser verification: 2026-11-02. Retrieval measurement: 2026-11-03.
Upstream base: `32119bd8a`.

## Selection

| Project                 | Source and license                                                                                                                                            | Finding                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rebrowser               | [Patches](https://github.com/rebrowser/rebrowser-patches), [Node package](https://github.com/rebrowser/rebrowser-playwright); npm metadata reports Apache-2.0 | Selected default, pinned at 1.64.101. Preserves the Node/Playwright service and fixes CDP and storage-partitioning signals.                                                                           |
| Patchright              | [Driver](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright), [Node package](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs); Apache-2.0           | Integrated alternative, pinned at 1.64.2. Clears the tested webdriver/CDP signals, but retains a detectable storage-partitioning configuration.                                                       |
| Camoufox                | [Repository](https://github.com/daijro/camoufox); browser MPL-2.0, Python/TypeScript launchers MIT, additional vendored notices                               | A Firefox alternative with native fingerprint work and TypeScript support. Requires another browser distribution and a separate compatibility benchmark. Reviewed, not installed or benchmarked here. |
| Puppeteer Extra stealth | [Repository](https://github.com/berstend/puppeteer-extra)                                                                                                     | An established alternative. Patched Playwright drivers preserve the existing service and address CDP directly. Not benchmarked here.                                                                  |

The registry was checked directly for pinned driver versions. Project claims
about being undetectable or passing commercial products are not adopted as
verified outcomes. No npm alias replaces the stock Playwright core. Rebrowser's
README documents an older core-alias collision; 1.64.101 depends on
`rebrowser-playwright-core` by its real package name.

## Implementation

- Select `BROWSER_ENGINE=rebrowser|patchright|playwright`.
- Keep the existing `/scrape` contract and Firecrawl adapter.
- Use full Chromium and native UA/platform/client hints; remove random UA
  generation and unnecessary GPU disabling. Preserve explicit caller headers.
- Keep isolated per-request contexts without a shared cookie jar or persistent
  customer profile.
- Use headful Chromium under Xvfb in Docker with `init: true`; expose local
  headless/headful and system-Chrome options.
- Preserve SSRF filtering, pinned DNS, and upstream proxy support. Route browser
  loopback traffic through the filtering proxy too.
- Report recognized interstitials through `pageError`, including HTTP 200
  challenge bodies. Retain target 403/429 statuses.
- Fix IP-address cookie seeding found by the redirect regression: Chromium
  rejects domain cookies such as `.127.0.0.1`.
- Log header names rather than credential-bearing values.

## Evidence

The pre-change service was run through HTTP against a controlled JavaScript
gate. It reported `navigator.webdriver=true`, failed to retrieve the protected
record, and randomly advertised iPhone/Safari on desktop Chromium. The baseline
receipt is retained outside build output at `_local/anti-bot/baseline.json`
(ignored by Git).

Real-browser HTTP tests cover the gate, page/worker identity consistency,
caller UA/headers/cookies through redirects, landed URLs, context isolation,
unresolved challenges, ordinary Turnstile forms, 403/429 responses, validation,
failed-selector cleanup, and default private-target rejection. Helper tests
also exercise pinned DNS and proxy denial with a DNS-rebinding negative control.

Public diagnostics were loaded through `/scrape` with native, headful Google
Chrome on macOS. Raw receipts are `_local/anti-bot/headful-live.json` (stock and
Patchright) and `_local/anti-bot/rebrowser-live.json` (Rebrowser).

| Observed signal                | Stock Playwright | Patchright | Rebrowser |
| ------------------------------ | ---------------- | ---------- | --------- |
| Controlled protected record    | Blocked          | Retrieved  | Retrieved |
| Sannysoft webdriver check      | Detected         | Passed     | Passed    |
| Rebrowser CDP runtime leak     | Detected         | Passed     | Passed    |
| Rebrowser storage partitioning | Detected         | Detected   | Passed    |

The [Rebrowser diagnostic](https://bot-detector.rebrowser.net/) has 20 rows in
these runs: 16 triggered checks and four untriggered checks. Rebrowser passed
the 16 triggered checks. Grey rows need APIs the scraper does not invoke
(`dummyFn`, source-URL/main-world probes and `exposeFunction`); they are excluded
from pass counts. This tests the passive scraper workflow. The
[diagnostic source](https://github.com/rebrowser/rebrowser-bot-detector) describes
the additional probes. [Sannysoft](https://bot.sannysoft.com/) is a separate live
diagnostic; neither result establishes production coverage.

Initial focused checks passed: `pnpm build`, 12 helper tests (`pnpm test`),
33 real-browser HTTP tests (`pnpm test:integration`), and
`pnpm audit --prod` (no known vulnerabilities). `docker compose config`
confirmed the default Rebrowser/headful configuration and `init: true`.
The Linux ARM64 image was built and started with `--init`; `/health` reported
Rebrowser/headful, an HTTPS scrape retrieved Example Domain, and a private
target was denied. Its receipt is `_local/anti-bot/container-smoke.json`.
The full Firecrawl API/worker stack was not started in this verification.
The focused `Browser engine integration` workflow runs these build, helper,
HTTP-integration, and dependency-audit checks on standard GitHub Ubuntu runners.
The inherited full server/audit workflows use Blacksmith runners; their status
is separate from this focused workflow.

## Limits

No user-specific production target portfolio or paid proxy service was supplied.
The retrieval benchmark below uses publisher-classified websites; its labels
do not establish which WAF products or challenge rules were active during our
requests. CAPTCHA solving, authentication acquisition, proxy rotation, and
IP-reputation remediation are not implemented by these drivers. A remaining
challenge is reported, not relabeled as a successful scrape.

Browser versions, diagnostics and WAF rules change. Re-run the bounded benchmark
after driver/browser changes and evaluate the actual target portfolio before
promising coverage. Preserve receipts from unsuccessful runs too.

## Reproducible retrieval measurement

`pnpm benchmark:waf` calls the running browser service through `/scrape`.
The fixture pins the 100 targets, expected markers and publisher labels from
[Frontier commit 1ae0cf5](https://github.com/usestring/web-data-frontier-benchmark/tree/1ae0cf5fa11f6a80587fdba57cac3efbb75836df).
It retains source hashes and upstream MIT attribution. Five attempts per target
produce 500 observations, with concurrency two and a 90-second client deadline.
Our runner traverses the full target list five times, whereas the publisher
runs a site's five attempts together. All failures remain in the denominator.

The basic score uses a successful service response, target HTTP 2xx and a
case-insensitive raw-body marker, matching the publisher's assertion. The
screened score additionally rejects recognized challenges, reported page errors,
and markers present only in scripts/styles/comments/noscript. This extra screen
does not validate CSS visibility, full-page completeness or extracted fields.

The measured deployment is Rebrowser 1.64.101 with Chromium 156.0.8078.4,
headful under Xvfb on Linux ARM64, using direct Vietnam egress and no upstream
proxy. The standalone container has two CPUs, 4 GiB of memory, `--init`, no
additional PID cap, and two concurrent pages. Each request gets a fresh context;
each worker waits 500 ms before sending its next request, and there are no
client retries. This measures the browser backend rather than the
full Firecrawl API and worker stack. Comparing this score to hosted services
cannot isolate the browser patch's effect from networking or server-side routing.

The runner retains a fixture snapshot, manifest, every attempt and full service
responses for screened failures. A separate one-second clock monitor flags
long scheduling gaps or backwards clock changes. macOS runs use process-scoped
`caffeinate -i` to prevent idle sleep. See the
[service README](../apps/playwright-service-ts/README.md) for reproduction.

Two invalid setup runs are retained outside Git: an initial 2 GiB/512-PID pilot
hit the PID cap, and an overnight run had 93 request latencies above two minutes
despite a 90-second client deadline. Neither complete aggregate is suitable for
performance comparison; their audit files preserve the reasons.

The measurement runner and timing monitor passed the
[focused CI run for 23268b6](https://github.com/toreleon/firecrawl/actions/runs/41557864272):
build, 23 helper tests, 34 HTTP/integration tests, and production dependency audit.
The inherited server/audit workflows require separate runner infrastructure;
this result is not a claim that the whole monorepo test suite passed.

## Reliability research and implementation, November 3

The retained run exposed failure modes beyond egress reputation. The following
primary sources guided the changes; these documents describe mechanisms, not
evidence that this fork defeats a vendor's protection:

| Source | Finding and implementation decision |
| --- | --- |
| [Playwright navigation lifecycle](https://playwright.dev/docs/navigations) | Modern pages can populate content after `load`. Add explicit text/selector readiness within one deadline and track later main-document responses. |
| [Cloudflare challenge response detection](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/) | `cf-mitigated: challenge` identifies challenge responses. Use the current document's headers rather than headers retained from a superseded navigation. |
| [DataDome response pages](https://docs.datadome.co/docs/response-pages) | Device checks, CAPTCHAs and hard blocks are different response types, with customizable templates. Extend detection with bootstrap/interstitial evidence rather than relying on a fixed title or a vendor script alone. |
| [Zyte session mechanisms](https://docs.zyte.com/zyte-api/usage/features.html#sessions) | IP, cookies and network identity can matter together. Add bounded, origin/profile-bound browser sessions with exclusive leases; this service still has one configured egress path. |
| [HTTP Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after) | Accept delta-seconds or HTTP dates, fit delays and retries inside the request deadline, and retain attempt counts. Do not blindly retry denials or challenges. |
| [Playwright service workers](https://playwright.dev/docs/service-workers) | Disabling workers can affect behavior, and workers complicate interception. Preserve the current worker restriction while testing ad-filter compatibility separately; do not remove SSRF controls. |
| [tldts public-suffix parsing](https://github.com/remusao/tldts) | Last-two-label cookie scoping mishandles multi-label/private suffixes. Pin tldts 7.4.19 and use the private-domain-aware registrable domain. |

Implemented regressions exercise delayed redirects in both directions (including
stale challenge headers), hydration and missing content, session cookies and
isolation, token secrecy, origin/profile mismatch, concurrent use, expiry and
capacity, retry counts and server backoff, queued-request deadlines, and late
browser-allocation disposal. Existing three-driver and SSRF checks remain part
of the focused CI workflow.

The scorer keeps the raw published assertion and adds an independent normalized
text assertion. In the archived observations all five arXiv pages contained the
expected normalized text but failed the raw substring; Reddit's five challenges
passed the raw marker while failing the screen. Retained failure bodies can be
replayed without a network request. Successful bodies were not retained in that
older run, so a replay cannot establish a newly verified full-run success rate.
The new controlled runner retains every response for that reason.

`benchmark:reliability` compares five profiles on 12 explicitly selected sites,
with two rounds and rotated profile order. Runtime/browser binaries are held
fixed by overlaying the revised application on the original pinned Linux image.
All three services use the same CPU/memory limits and host egress. The comparison
separates compatible behavior, readiness, ad-filter removal and cold/reused
sessions. First-attempt settings remain fixed; recovery behavior is verified
with controlled fixtures rather than silently increasing the live request budget.
The test has shared-IP interference and a short observation window, and cannot
estimate general WAF coverage or causal effects outside these selected cases.

At this stage, remaining deployment work included proxy/region experiments,
site-specific consent/navigation flows, browser-fingerprint investigations,
API-adapter controls and distributed session ownership. The subsequent
[local browser workflows](browser-workflows.md) change implements consent and
navigation controls, the v2 adapter, fixed browser ownership and page-scoped human
handoff. Proxy/region experiments remain separate. Interactive verification is
not automatically solved; human-assisted outcomes must be measured separately.

### Observed results

Replaying the 272 retained failures from the original run recognized 68
additional challenge responses across 15 targets and found five normalized
marker matches (all arXiv). This is an accounting/detection result, not five
new retrievals; the original 500-request report remains unchanged.

The controlled 120-request experiment used 12 sites, two requests per profile
per site, shared Vietnam egress, and identical two-CPU/3-GiB container limits:

| Profile | Normalized content matches |
| --- | --- |
| Original service, load + two-second wait | 6/24 (25.0%) |
| Revised service, compatible waits | 6/24 (25.0%) |
| Revised service, text readiness | 10/24 (41.7%) |
| Readiness with ad filtering disabled | 10/24 (41.7%) |
| Readiness, no ad filter, session reuse | 10/24 (41.7%) |

The four additional matches were Booking.com and TikTok on both rounds. All
three previously successful control targets stayed successful. Removing the
ad filter and reusing contexts yielded no additional normalized matches in
this sample. Twelve session-profile requests reused contexts from round one.
These results support the readiness strategy on these cases, not general
coverage or a new whole-portfolio success rate. Dynamic content and shared-IP
interference remain limitations.

All 120 service responses were retained (capability tokens omitted), their
content hashes and unique profile/target/round pairs verified, and all services
ended healthy with zero active pages or sessions. No timing gaps, PID-limit
hits or memory/OOM events occurred. Receipts are retained outside Git in
`_local/anti-bot/reliability-paired-2026-11-03/`; the failure replay is
`_local/anti-bot/reliability-replay-2026-11-03.json`.

The experimental runtime is pinned to `a6c0912f5`; a subsequent cleanup-only
fix at `cdde87d6f` bounds page/context closure after expired requests. The
[focused CI for that fix](https://github.com/toreleon/firecrawl/actions/runs/41570715167)
passed the build, 32 helper tests, 42 HTTP/CLI integration tests and production
dependency audit. The experimental results are not relabeled as measurements
of the subsequent commit.

### Deployment-specific fingerprint check

The earlier native-Mac diagnostic result did not describe the Linux benchmark
worker. The final application image at `5c9fae005` was checked through its real
HTTP endpoint, then compared with the same application using native macOS
Google Chrome 156.0.8078.80 and the Apple M4 Pro GPU:

| Environment | Triggered Rebrowser checks | Sannysoft WebGL renderer |
| --- | --- | --- |
| Linux ARM64 bundled Chromium under Xvfb | 14 green, 1 red, 1 yellow | SwiftShader software renderer, flagged |
| Native macOS stable Chrome | 16 green | Apple M4 Pro, passed |

Each run also had four untriggered Rebrowser API probes, excluded from pass
counts. The Linux red check concerned the absence of a Google Chrome brand in
client hints; the warning included software-rendering signals. The
[diagnostic source](https://github.com/rebrowser/rebrowser-bot-detector/blob/main/index.js)
describes those heuristics. A diagnostic flag is not proof of the reason a
commercial target blocked a request. The existing `BROWSER_CHANNEL=chrome`
option can use an installed real Chrome; a container's graphics environment
remains a separate deployment concern.

A further interleaved comparison used eight difficult targets, two attempts
per target/environment and the same readiness policy: Linux retrieved the
normalized marker on 3/16 attempts and native Chrome on 4/16. The extra match
was one TikTok visit; Booking.com passed twice in both environments. The other
six targets failed in both. The OS, browser build, graphics and resource limits
changed together, so the small difference is inconclusive. Passing all public
diagnostic checks did not establish broad target access in this test.

Receipts are `_local/anti-bot/reliability-linux-diagnostics-2026-11-03/` and
`_local/anti-bot/native-vs-linux-2026-11-03/`. All 32 response hashes and unique
target/profile/round pairs were audited with no timing gaps. The temporary
native browser service and Linux diagnostic container were stopped afterward.

### Browser workflows and distributed ownership

The [local browser workflow implementation](browser-workflows.md) adds recognized
consent handling, bounded actions, initial Best Buy/Canada Goose recipes, retained
tabs and page-scoped human handoff. The v2 API and JS/Python SDKs forward the new
controls. PostgreSQL records the tenant, exact browser owner and boot identity;
revision fences and operation journals serialize commands and return recorded
results without repeating known completed actions. Unknown outcomes end the
session. A concurrent close also wins over a late creation response.

The completed rerun used browser runtime `5eecbf75553d55957e8614695ba97377ca7b1329`
and image `sha256:54c4c69e2e01ac8ad3f3f4eef75febdd4566a7fc31a3222c39ff73ead9e842ef`.
It ran from **06:09:45 to 06:38:46 UTC on November 3, 2026**: 100 frozen targets,
five attempts each, two concurrent requests, fresh contexts, one service attempt,
90-second client / 85-second service deadlines, DOM-content-loaded navigation,
five-second body-text readiness and no post-load sleep. The worker had two CPUs,
4 GiB, direct Vietnam egress and no configured upstream proxy. Consent rejection
and automatic navigation recipes were enabled. Human handoffs and paid scraping,
CAPTCHA or model services were excluded.

| Marker check | Previous full run | Workflow run | Change |
| --- | --- | --- | --- |
| Raw published substring | 246/500 (49.2%) | 232/500 (46.4%) | -2.8 pp |
| Screened marker | 208/500 (41.6%) | 194/500 (38.8%) | -2.8 pp |
| Normalized marker | 213/500 (42.6%) | 199/500 (39.8%) | -2.8 pp |

| Publisher WAF label | Previous normalized matches | Workflow normalized matches |
| --- | --- | --- |
| Cloudflare | 33/75 (44.0%) | 30/75 (40.0%) |
| DataDome | 20/100 (20.0%) | 20/100 (20.0%) |
| Akamai | 39/100 (39.0%) | 26/100 (26.0%) |

The overall unattended marker rate did not improve in this observation. Best Buy
improved from 0/5 to 2/5 normalized matches: both successful attempts recorded
navigation to the original product after the country selection. Its other three
attempts returned network errors without retaining the navigation phase. The
delayed country prompt and asynchronously rewritten product link have controlled
browser regressions.
Canada Goose expanded details on all five attempts but still failed body-text
readiness; expansion alone did not establish retrieval of the expected text.
Consent diagnostics recorded 11 applied choices, six unresolved choices, 455
not-detected outcomes and 28 responses without interaction diagnostics.

The largest failure classes were recognized challenges (111), HTTP 403 (82),
content not ready (43), network errors (20), HTTP 429 (16) and timeouts (8).
Screened-success latency p50 changed from 2,630 to 3,222 ms and p95 from 7,040 to
6,740 ms. These are serial observations at different times, rather than a
randomized paired experiment: live-site and network changes prevent attributing
the overall difference to the implementation. WAF labels do not verify active
live vendor rules, and marker presence does not establish field completeness or
CSS visibility.

All 500 unique target/attempt pairs, response content hashes and replayed scores
were verified. The grader source is byte-identical to the previous run. No timing
gaps over ten seconds, memory/OOM or PID-limit events occurred; the largest timing
sample gap was 1,010 ms. Source and compiled runtime hashes matched the checkout,
the browser owner boot identity stayed fixed, and the service ended healthy with
zero active pages or sessions. All task-owned services were stopped afterward.
Two earlier partial runs, stopped while fixing navigation timing, remain separate
diagnostics and are excluded from these totals.

Validation: API build and 171 focused checks passed through `pnpm harness`,
including real API/browser requests, PostgreSQL exclusion across processes,
creation/close races and page handoff. The unchanged browser runtime passed its
[CI build, 34 helper checks, 49 integration checks and dependency audit](https://github.com/toreleon/firecrawl/actions/runs/41587930882).
JS serialization had four passing checks; Python request preparation had 15.
The live benchmark calls the browser backend; it is not a load benchmark of the
full API, multiple workers or human-assisted retrieval.

A [compact result receipt](../apps/playwright-service-ts/benchmarks/workflows-results-2026-11-03.json)
is tracked without response bodies. Full local evidence, timing/resource receipts,
score replay and per-target comparison are retained in
`_local/anti-bot/waf-workflows-navigation-full-2026-11-03/`. API receipts are in
`_local/anti-bot/api-workflow-harness-2026-11-03-creation-close/`.


### Failed-target investigation and repairs

The 42.6% to 39.8% normalized-rate change was a net loss of 14 matches: 24 lost
matches across regressing targets, offset by 10 gains. The lost matches break down
as follows; these are observed response differences, rather than proof of cause.

| Lost normalized matches | Target and response observed in workflow run |
| --- | --- |
| 13 | Louis Vuitton (5), eBay (4), Mouser (2), Apartments.com (2): HTTP 403 |
| 4 | Lululemon: HTTP 400 with `GE401001` |
| 3 | Yahoo Finance: `ERR_EMPTY_RESPONSE` |
| 2 | Zoopla: recognized verification responses |
| 1 | Yellow Pages: HTTP 503 |
| 1 | TikTok: expected profile body did not render |

A new 78-request interleaved diagnostic tested 13 targets twice with the earlier
readiness image, the workflow image with controls off, and that same workflow
image with consent/recipes on. Profile order rotated by target and round, with
two workers and fresh contexts on shared direct host egress. All response hashes
and 78 unique profile/target/round pairs were audited; timing had no invalid gaps.

| Profile | Normalized matches |
| --- | --- |
| Earlier readiness image | 7/26 |
| Workflow image, controls off | 9/26 |
| Workflow image, controls on | 9/26 |

All three profiles failed on Apartments.com, eBay, Louis Vuitton, Lululemon and
Mouser in both rounds. Consent did not reduce the observed match count in this
small test. This supports live origin/edge and network variability as the main
observed explanation for the earlier decline; it does not establish a causal
vendor reason or exclude all effects of the new code. The controls-on profile
had a higher screened-success median latency (3,981 vs 2,624 ms with controls off).
The subset is selected and shares egress, so its rate is not a portfolio estimate.

The investigation read all 301 failed normalized attempts across 67 targets.
The [target-by-target receipt](../apps/playwright-service-ts/benchmarks/failed-target-analysis-2026-11-03.json)
records counts, outcomes, findings and representative evidence hashes without
copying page bodies into Git. It identified these repairable issues:

- Facebook application scripts/styles were blocked by the broad `fbcdn.net` ad
  rule, leaving zero rendered body characters on all five attempts. The filter
  now allows this content CDN and preserves requested documents/first-party
  resources. Third-party ad filtering and the SSRF boundary remain in force.
  A live no-ad-filter control retrieved the profile, and the repaired pilot
  retrieved it on 2/2 attempts with ad filtering enabled.
- CoinMarketCap's public About content was present in server HTML but hydrated
  on viewport intersection. A real scroll grew rendered text from 7,664 to
  27,247 characters and exposed the expected marker. The bounded `auto` recipe
  scrolls the observed About section into view, then applies the ordinary body
  readiness check. It matched on 2/2 repaired pilot attempts.
- Small static HTTP denial documents consumed the full readiness window while
  they had no active content capable of producing the requested body. The
  service now inspects the original response, including chunked responses, and
  skips that poll only for small static HTTP errors. Script/iframe/event-handler
  or refresh-bearing error responses retain the wait; a controlled delayed
  redirect regression verifies that they can still reach ready content.
- The network-error regex truncated numeric names such as
  `ERR_HTTP2_PROTOCOL_ERROR` to `ERR_HTTP`. Diagnostics now retain the complete
  name, operation phase and recent main-document/network events even when no DOM
  capture is possible. This improves diagnosis rather than claiming new retrieval.

Several failed markers still have useful but different evidence. Bing and
Zillow rendered result content whose expected string was confined to the title
or differed from the body heading. Canada Goose expanded details, but the exact
expected sentence remained metadata-only. Allmenus returned an explicit location
restriction. Temu presented interactive image verification. The NYT response
contained a subscription/sign-in gate and an expected paragraph outside the
rendered body. Roblox exhausted navigation deadlines without a captured document;
a separate diagnostic was stopped without a DOM result, so its underlying cause
remains unconfirmed. These cases retain their frozen failure outcomes. No title
fallback, hidden-text success rule, geographic routing or automated verification
solver was added.

The previous Best Buy description saying all three network failures occurred
before navigation was too specific: the retained container log also includes a
follow-up country/product-navigation failure and preflight requests, while the
old failed responses omitted phase information. The historical counts are
unchanged; new phase diagnostics address that evidence gap.

The rendering investigation follows the distinction between navigation and
application hydration in [Playwright's navigation documentation](https://playwright.dev/docs/navigations)
and its [HTTP-status behavior](https://playwright.dev/docs/api/class-page#page-goto).
Viewport-triggered content is consistent with the browser behavior documented by
[MDN's Intersection Observer reference](https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API).
The distinct network errors are defined in
[Chromium's error catalog](https://github.com/chromium/chromium/blob/main/net/base/net_error_list.h);
the code does not infer a WAF vendor from a transport error.

Local diagnostic receipts: `_local/anti-bot/workflow-regression-ablation-2026-11-03/`,
`workflow-failure-analysis-2026-11-03.json`, `deep-probe-cmc-2026-11-03.json`,
`facebook-adblock-disabled-probe-2026-11-03.json` and
`regression-repair-pilot-ready-2026-11-03/`, all under `_local/anti-bot/`.


### Completed repair benchmark

The repaired browser runtime `f47d7085ce6a07be1ce38fc523a10533648b9f36` was measured
from **07:07:10 to 07:34:31 UTC on November 3, 2026**. Its image is
`sha256:9a97a3c48ff12f8ec20518f769f620d31516262daa2a3636ba679ae87695d94d`.
The frozen targets, graders and body-text assertions were unchanged: 100 targets,
five attempts, two workers, fresh contexts, one service attempt, the same
90/85-second client/service deadlines and five-second readiness budget. The
worker kept two CPUs and 4 GiB, direct Vietnam egress and no upstream proxy.
Human assistance and commercial scraping/verification/model APIs were excluded.

| Check | Initial readiness run | Workflow run | Repaired run |
| --- | --- | --- | --- |
| Raw substring | 246/500 (49.2%) | 232/500 (46.4%) | 230/500 (46.0%) |
| Screened marker | 208/500 (41.6%) | 194/500 (38.8%) | 204/500 (40.8%) |
| Normalized marker | 213/500 (42.6%) | 199/500 (39.8%) | 209/500 (41.8%) |

Facebook and CoinMarketCap each improved from 0/5 to 5/5 normalized matches,
accounting for ten additional matches. The other 98 targets had no aggregate net
change, although individual outcomes varied. Best Buy moved from 2/5 to 3/5;
Yahoo Finance from 2/5 to 5/5; Target from 5/5 to 0/5, with all five new attempts
returning HTTP 429. Those changes illustrate the continuing live-site variation.
Raw substring matches fell by two, while screened and normalized matches rose
by ten: metadata/script substrings and rendered-content retrieval are different
checks. The repaired normalized rate is still 0.8 percentage points below the
initial readiness run. No general WAF-bypass gain is established.

| Publisher WAF label | Workflow normalized matches | Repaired normalized matches |
| --- | --- | --- |
| Cloudflare | 30/75 (40.0%) | 33/75 (44.0%) |
| DataDome | 20/100 (20.0%) | 20/100 (20.0%) |
| Akamai | 26/100 (26.0%) | 26/100 (26.0%) |

Wall time was 27m21s versus 29m01s previously. Forty-four small static HTTP errors
skipped the futile readiness wait; their median end-to-end latency was 733.5 ms.
Screened-success latency p50 was 3,172 ms (previously 3,222) and p95 was 5,543 ms
(previously 6,740). These are observed serial-run timings, with live-site and
shared-egress confounding. The 291 normalized failures still include 109
recognized challenges, 81 HTTP 403 responses, 32 readiness failures, 22 rate
limits, 19 network failures, nine timeouts and smaller status-error groups.

The new diagnostics show CarGurus receiving HTTP 406 before Chromium reports
`ERR_HTTP_RESPONSE_CODE_FAILURE`. Roblox receives an initial 301 and then times
out without a final-document response; no captured evidence establishes a
renderer cause. Both remain failures rather than being retried or reclassified
as successful retrieval.

Build, 37 helper checks, 53 browser integration checks and the production
dependency audit passed locally and in
[CI for the measured runtime](https://github.com/toreleon/firecrawl/actions/runs/41594178283).
All 500 response hashes, unique target/attempt pairs and replayed scores matched.
Grader bytes matched both earlier runs. Source/compiled hashes and browser owner
identity matched the recorded deployment, no invalid timing gaps or cgroup
memory/OOM/PID-limit events occurred, and the service ended healthy with zero
active pages or sessions. Task-owned diagnostic and benchmark services were
stopped. No API/SDK behavior was changed in this repair; their earlier focused
checks are not relabeled as newly run checks.

The [repair result receipt](../apps/playwright-service-ts/benchmarks/regression-repair-results-2026-11-03.json)
contains the full metrics and limits. Full response evidence, per-target deltas,
resource/timing checks and score replay are retained in
`_local/anti-bot/waf-regression-repair-full-2026-11-03/`.

This comparison stayed at two workers. Four-worker runs are a separate
throughput profile: increase both the runner's `--concurrency` and the service's
`MAX_CONCURRENT_PAGES`, budget CPU/memory accordingly, and measure changes in
throttling and success instead of mixing concurrency levels within one run.

### Four-worker throughput profile

The next 500-attempt run reused the repaired runtime image, fixture, grader and
request settings. Runner concurrency and browser capacity increased from two
to four, and the CPU allocation increased from two to four. Memory remained
4 GiB and egress remained direct Vietnam, with no upstream proxy.

| Metric | Two workers, two CPUs | Four workers, four CPUs |
| --- | --- | --- |
| Wall time | 27m21s | 13m50s |
| Raw substring | 230/500 (46.0%) | 238/500 (47.6%) |
| Screened marker | 204/500 (40.8%) | 210/500 (42.0%) |
| Normalized marker | 209/500 (41.8%) | 215/500 (43.0%) |
| Screened-success p50 | 3,172 ms | 3,275 ms |
| Screened-success p95 | 5,543 ms | 7,390 ms |

The combined capacity change gave **1.98 times the throughput**, while the
latency tail of successful requests increased. This is a serial live-site
comparison, not proof that concurrency improved retrieval or that scaling is
linear. Cloudflare-labelled normalized matches were 32/75, DataDome 20/100 and
Akamai 29/100. Live-site variation still applies.

All 500 target/attempt pairs, content hashes and replayed scores matched. Timing
integrity passed; sampled peak memory was 2,794 MiB, with zero cgroup memory,
OOM or process-limit events. The service ended healthy with no active pages or
sessions and was stopped. The [compact scaling receipt](../apps/playwright-service-ts/benchmarks/scale-four-results-2026-11-03.json)
records resource limits, per-target changes and evidence locations. Eight
workers are now accepted by the benchmark CLI and covered by controlled runner
checks; this live result measured four workers.

### Fresh full-API comparison

The new [paired API runner](../apps/playwright-service-ts/benchmarks/API-BENCHMARK.md)
calls both deployments through `/v2/scrape`, requests fresh `rawHtml` and
`markdown`, and sends no expected marker as a readiness hint. Fork-only controls
and each deployment's rate pacing are explicit in the manifest. This separates
ordinary API output from the earlier browser benchmark's marker-aware wait.
Cloud's internal routing and retries remain provider-controlled; the fork
continues to use direct egress.

An initial 20-target pilot made 20 hosted and 20 fork requests. Both returned
nine normalized matches, but **ten hosted requests received account-level HTTP
429 responses**, and one exhausted its scraping engines. It is not a valid
retrieval-capability tie. The account reported a ten-request-per-minute limit.
The runner now supports a shared per-profile dispatch interval across workers,
records provider rate limits separately, and leaves failed attempts in the
denominator. The original pilot and its complete offline audit are retained in
`_local/anti-bot/api-hosted-pilot-2026-11-03/`; the observed credit balance fell
by nine, matching the nine hosted responses reporting one credit each. A balance
delta can include concurrent account activity.

The paced pilot then repeated the same 20 targets once per deployment, with a
7,000 ms minimum dispatch interval for **both** profiles and at most four HTTP
requests in flight. The measured minimum interval was 7,000 ms for each profile;
there were **zero provider HTTP 429s**. Both APIs received identical fresh
HTML/Markdown options; only the fork received its explicit browser controls.

| API output check | Direct fork | Hosted Firecrawl |
| --- | --- | --- |
| Raw substring | 8/20 (40%) | 13/20 (65%) |
| Screened marker | 8/20 (40%) | 13/20 (65%) |
| Normalized marker | 9/20 (45%) | 14/20 (70%) |
| Markdown marker | 9/20 | 14/20 |
| Screened-success p50 | 2,080 ms | 6,664 ms |
| Screened-success p95 | 4,059 ms | 11,688 ms |

Five targets passed on both deployments, nine only on hosted, four only on the
fork, and two on neither. Hosted-only matches were Amazon, Indeed, Louis
Vuitton, Mouser, Tripadvisor, eBay, CarGurus, Crunchbase and Stack Overflow.
Fork-only matches were Google Search, Best Buy, Facebook and CoinMarketCap.
Hosted returned explicit unsupported-site API responses for Facebook and
Reddit, exhausted its engines on Lowe's and Google Search, missed Best Buy's
marker, and returned no usable HTML/target status for CoinMarketCap. Those all
remain failures under the same rule. Shorter fork success latency compares
different successful target sets and does not prove matched-target superiority.

The [full-API pilot receipt](../apps/playwright-service-ts/benchmarks/hosted-api-pilot-results-2026-11-03.json)
records every paired outcome and retained evidence hashes. All 40 unique
deployment/target pairs, payload hashes, scores and summary metrics passed
offline replay. Build, 42 helper checks, 55 integration checks and the production
dependency audit passed in [browser CI](https://github.com/toreleon/firecrawl/actions/runs/41602196803).
The API and SDK implementations were unchanged; these browser/runner checks are
not a new full API regression-suite result. The paced run's observed hosted
credit balance decrease was 16 versus 15 credits reported in responses; missing
usage is unknown, and concurrent account activity or settlement timing is not
excluded. Across both pilots, the observed balance decrease was 25 credits.
Task services were stopped and the temporary hosted credential file removed.

Hosted comparability remains **unproven**. This deliberately selected pilot
contains previously reliable, variable and blocked pages, with only one attempt
per deployment and target. It does not replace the 100-target repeated browser
benchmark, measure extraction F1, or establish production availability. The
next runtime investigation should examine ordinary navigation/empty-content
states and preserve informative engine failures: the fork reported
`CONTENT_READY` for an Amazon continuation page and an empty rendered Louis
Vuitton response, and Reddit's browser failure became a generic API error.
Recovering content, clearer failure reporting and throughput must be measured
separately; Cloud's infrastructure differs from the proxy-free fork, so this
comparison alone does not identify the cause of its retrieval advantage.

### Rendered content and answer-free continuation repair

The paired API failures included a single-button Amazon validation form and an
empty rendered Akamai shell. Neither was product content, despite the earlier
`CONTENT_READY` metadata. Playwright documents that page activity can continue
after `load`; navigation completion alone does not establish content readiness
([navigation documentation](https://playwright.dev/docs/navigations)).

`workflow: auto` now waits within the readiness budget for empty/loading HTML or
a passive verification page to produce rendered text, without receiving an
expected answer string. Explicit readiness and JSON/plain-text handling retain
their separate behavior. Runtime classification recognizes the observed Amazon
and Akamai verification documents. Empty Markdown-dependent browser results
return typed HTTP 422 failures through the API instead of a generic engine error.

The Amazon recipe submits only the observed answer-free GET form with exactly
the known hidden inputs and no answer-entry controls or iframe. It preserves
server-supplied hidden values, keeps the browser context, and returns from the
storefront to the original product. Actual puzzles remain unresolved. Three
diagnostic submissions alone retrieved no product; adding a return to the
original URL retrieved the expected rendered product in two of three fresh
sessions. This small diagnostic motivated the recipe, not a general success claim.

A completed interleaved browser comparison used the frozen 100 targets twice on
each runtime: 400 service requests, four total client workers, two pages/two CPUs
and 3 GiB per browser, the same browser distribution/base image, direct Vietnam
egress and no upstream proxy. Both received consent rejection, automatic
workflows, one service attempt and no expected-text readiness hint. Profile
order rotated by target and round. The baseline was `f47d7085c`; the measured
candidate was `da7af1f2a`.

| Check | Baseline, 200 requests | Candidate, 200 requests |
| --- | --- | --- |
| Raw substring | 83 (41.5%) | 91 (45.5%) |
| Screened marker | 79 (39.5%) | 86 (43.0%) |
| Normalized marker | 81 (40.5%) | 88 (44.0%) |
| Screened-success p50 | 3,099 ms | 3,846 ms |
| Screened-success p95 | 5,966 ms | 7,475 ms |

There were eight candidate-only matches and one baseline-only match, for seven
net additional matches. Changes were Amazon +1, Booking.com +2, Expedia +1,
TikTok +2, Airbnb +1, Zoopla +1 and YouTube -1. The YouTube loss timed out in the
consent phase. This does not establish a causal consent regression or a general
WAF improvement: live-site variation and shared egress remain confounders. The
observed coverage increase also cost latency. Earlier 500-request measurements
used marker-aware readiness and different capacity profiles, so their rates
are not interchangeable with this comparison.

All 400 unique profile/target/round records, response hashes and scores replayed
correctly. Grader and fallback-classifier bytes were unchanged. The added runtime
classifier rejected none of 424 historical normalized successes. Timing passed,
peak sampled memory was 1,284/1,247 MiB for baseline/candidate, and all recorded
memory/OOM/process-limit counters stayed zero. Both services ended healthy with
zero pages/sessions and were stopped. An earlier 218-request candidate run was
aborted when live evidence showed that the hidden form field already had a
server-supplied value. Its incorrect empty-value guard was repaired; those
partial results are excluded. The [400-request receipt](../apps/playwright-service-ts/benchmarks/content-readiness-results-2026-11-03.json)
preserves the versions and exclusions.

One measured candidate attempt exposed a later redirect race: a form marked
unresolved subsequently landed on the storefront. It remained a failed marker
check. The subsequent `d27415afa` repair observes the pending redirect for up to
1.5 seconds and checks identity on every post-submission capture, including an
unresolved form. Controlled tests cover both delayed recovery and rejecting a
later storefront/other-product capture. The 400-request result is not relabeled
as a measurement of that later repair.

### Refreshed full-API comparison

The later runtime `d27415afa` was measured through the full API against hosted
Firecrawl on the same selected 20 targets. Both profiles again requested fresh
raw HTML/Markdown, had no expected-text hint, dispatched at least 7,000 ms apart
and made 20 requests each. Account-level HTTP 429 responses were zero.

| Check | Direct fork | Hosted Firecrawl |
| --- | --- | --- |
| Raw substring | 9/20 (45%) | 15/20 (75%) |
| Screened marker | 8/20 (40%) | 15/20 (75%) |
| Normalized marker | 9/20 (45%) | 16/20 (80%) |
| Markdown marker | 10/20 | 15/20 |
| Screened-success p50 | 2,483 ms | 11,551 ms |
| Screened-success p95 | 10,988 ms | 21,017 ms |

The fork gained Amazon and lost Google Search to target HTTP 429 versus the
previous paced pilot, keeping its normalized count at nine. Hosted gained
Lowe's and Google Search, increasing from 14 to 16. Six targets passed both,
ten only on hosted, three only on the fork and one on neither. The fork-only
matches were Best Buy, Facebook and CoinMarketCap. Successful latency compares
different target sets and does not establish broad speed superiority. The
captured Reddit response retained `HUMAN_REQUIRED` and challenge/error metadata;
its raw substring was not treated as a screened or normalized success.

All 40 records and scores passed offline replay. Twelve running-image source
and compiled files matched the checkout, verified from the stopped container;
the exact image ID is in the [API result receipt](../apps/playwright-service-ts/benchmarks/content-readiness-api-results-2026-11-03.json).
The runtime passed build, 46 helper checks, 60 integration checks and production
dependency audit in [CI](https://github.com/toreleon/firecrawl/actions/runs/41610946910).
Three focused real-API harness checks passed for the changed API engine code,
covering ordinary and transient-shell content, typed empty/verification failure,
retained tabs and handoff. The later browser-only corrections did not change
that API engine file. This is not a new full API/SDK regression-suite result.

The hosted balance decreased by 18 during this refresh, versus 17 credits
reported in responses, with three responses lacking usage data. Across all
three API pilots, the observed balance decrease was 43. Concurrent usage and
settlement timing remain possible; balance changes are not a complete billing
receipt. A broker-startup failure before this run issued no scrape requests;
the launcher was repaired to wait for an AMQP handshake. Task services were
stopped and the temporary credential file removed.

The goal remains open: the local comparison improved match rate, while the
fresh hosted comparison still showed a substantial retrieval gap. Neither this
selected pilot nor the browser comparison measures extraction F1, a complete
crawl/refresh system, or production availability.
