# Open-source browser anti-detection integration

Initial browser verification: 2026-11-02. Retrieval measurement: 2026-11-03.
Upstream base: `32119bd8a`.

## Selection

| Project                 | Source and license                                                                                                                                            | Finding                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rebrowser               | [Patches](https://github.com/rebrowser/rebrowser-patches), [Node package](https://github.com/rebrowser/rebrowser-playwright); npm metadata reports Apache-2.0 | Selected default, pinned at 1.64.101. Preserves the Node/Playwright service and fixes CDP and storage-partitioning signals.                                                                           |
| Patchright              | [Driver](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright), [Node package](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs); Apache-2.0           | Integrated alternative, pinned at 1.64.2. Clears the tested webdriver/CDP signals, but retains a detectable storage-partitioning configuration.                                                       |
| Camoufox                | [Repository](https://github.com/daijro/camoufox); browser MPL-2.0, Python/TypeScript launchers MIT, additional vendored notices                               | A Firefox alternative with native fingerprint work and TypeScript support. Requires another browser distribution and a separate compatibility benchmark. Optional backend added after an isolated direct-egress pilot; see the later Firefox experiment for source pins, compatibility gates and limits. |
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

## Stateless worker routing, retries and media policy

The next iteration (`ac228cbf0`) repaired three concrete implementation gaps.
Stateless requests with `browserControls` selected only the first configured
owner; they now rotate across owners per API process. Health discovery shares
the caller's deadline and cancellation, deduplicates pending probes, and permits
selection of another owner only before dispatch. Retained sessions remain pinned
to their recorded owner. A failed dispatched command or lost response is never
replayed on another owner. Capture diagnostics expose the executing boot ID.

Opt-in retry detection previously depended on error-message wording and missed
the service's own coded phase deadline. It now checks typed errors and a narrow
set of transient transport failures, including HTTP2 protocol errors. Budget
planning preserves requested fixed/readiness waits when all possible attempts
cannot fit. The old tab must finish closing before another stateless attempt.
Cancellation, session loss, workflow identity mismatches and hard denials remain
terminal; action/workflow-session retry restrictions remain in effect. The
controlled fixture recovers a slow first navigation in the shared deadline and
proves that a fixed wait does not become an impossible half-budget attempt.
This repair is not a measured public-target retry-coverage gain.

The optional `BLOCK_MEDIA=true` route was also bypassed by a later catch-all
handler calling `continue()`. Playwright documents that matching handlers run
in the opposite order to registration and `continue()` skips remaining handlers.
The repair combines security, advertising and optional media decisions in one
handler. It uses the browser's resource type instead of a filename extension,
blocking extensionless/query-string image subresources while preserving scripts
named `.jpg` and requested top-level image documents. A failure-first fixture demonstrated
the previous ineffective filter. The default was and remains `false`.
Sources: [route chaining](https://playwright.dev/docs/api/class-route#route-fallback)
and [resource types](https://playwright.dev/docs/api/class-request#request-resource-type).

### Full API capacity measurement

With the same native macOS API and two headless Rebrowser owners, eight concurrent
fresh fixture scrapes requested a 1,200 ms post-load wait. Each owner had two page
permits. One configured owner completed all eight in 5,649 ms; two owners completed
them in 2,950 ms, with four requests on each. All 16 measured requests and four
warmups returned the expected document and HTTP status. Timing had no suspension
gaps and all owners ended with zero active pages/sessions.

This is a 1.91× throughput increase in a controlled, single-run capacity check,
obtained by using four page permits instead of two. It establishes functioning
API distribution, not hosted speed parity, a CPU efficiency improvement, or a
public-site success-rate increase. The separate real API regression checks also
confirm that a retained session uses the same owner after a subsequent scrape.

### Media experiment before proxy routing

The same Linux ARM64 headful image ran both profiles with only `BLOCK_MEDIA`
different. A selected subset of 20 frozen targets ran three times per profile:
120 requests, four client workers, two page permits/two CPUs/3 GiB per owner,
direct Vietnam egress, one attempt, consent rejection, automatic workflows and
no supplied expected-text hint. This subset differs from the earlier 20-target
full-API pilot and is not a fresh hosted comparison.

| Check | Media allowed | Media blocked |
| --- | --- | --- |
| Raw substring | 25/60 | 21/60 |
| Screened marker | 23/60 | 18/60 |
| Normalized marker | 26/60 (43.3%) | 21/60 (35.0%) |
| Screened-success p50 | 3,920 ms | 3,366 ms |
| Screened-success p95 | 9,730 ms | 7,509 ms |
| Observed non-loopback RX | 118,732,672 bytes | 101,115,391 bytes |
| Peak sampled memory | 969 MiB | 1,176 MiB |

There were 21 paired matches, five media-allowed-only matches and no
media-blocked-only matches. The differences were Amazon 2→0, Zoopla 2→0 and
Airbnb 1→0. Blocked-media Amazon attempts ended in empty/aborted network responses
or timeout; Zoopla returned challenge states, and Airbnb's marker stayed only in
non-content markup. These observations do not isolate the cause of an individual
loss from live-site variation or shared egress. Successful latency also compares
different successful target sets. There is no basis here to enable blocking as a
general coverage optimization.

The blocked profile recorded 433 blocked media requests and about 14.8% fewer
incoming NIC bytes. NIC counters include TLS, API traffic and protocol overhead;
they are not exact target payload measurements or an outcome-independent cost
estimate. Memory/OOM/process-limit counters stayed zero. All 120 unique records,
response hashes, scores and summaries replayed with unchanged grader/classifier
bytes and identical runtime source/compiled hashes. Both services ended healthy
and were stopped. Keep media loading enabled by default.

A separate ten-target direct-HTTP diagnostic used the existing secure dispatcher,
TLS verification, private-address checks and redirect guards, without proxies,
JavaScript or a fake browser identity. None of the ten previous hosted-only
targets passed the unchanged normalized grader: eight returned 403, CarGurus
returned 406 and Google returned a 200 non-content shell. CarGurus also failing
through Undici is evidence against assuming Chromium HTTP2 alone caused its
denial. This small diagnostic does not establish a universal transport result;
it provides no reason to add a raw-fetch shortcut for these targets.

The source passed [browser CI](https://github.com/toreleon/firecrawl/actions/runs/41618803019):
build, 48 helper checks, 62 integration checks and production dependency audit.
Four real API harness checks passed, including two-owner routing and retained-owner
identity. Five focused client checks cover balanced selection, health fallback,
no replay after failure or a lost response, and deadline/cancellation before
dispatch. The harness logged an extract-worker AMQP closing error during shutdown;
the tests and harness exited zero, and all task services were stopped. Broader
custom-runner server/SDK CI is still queued. No hosted calls or provider credits
were used in this iteration.

The [compact receipt](../apps/playwright-service-ts/benchmarks/worker-routing-media-results-2026-11-03.json)
pins all three experiments and local evidence hashes. Hosted parity remains open;
the last direct hosted comparison is still the separately pinned 45% versus 80%
API pilot, not a measurement of this newer source.

## Primary content loading and an automatic API wait budget

Saved Airbnb failures exposed a gap in the body-text readiness rule: search
navigation and a footer were rendered while result placeholders still carried
`aria-busy="true"`. Any nonempty body text was sufficient, so the browser captured
the shell before result hydration. WAI-ARIA defines `aria-busy` as an element
being modified. We use that author-provided state as a bounded loading hint,
not as proof that every site implements it correctly. This is an inference from
the [W3C state semantics](https://www.w3.org/TR/wai-aria-1.2/#aria-busy).

Automatic readiness now checks viewport-visible busy regions inside a visible
main landmark, or the body when no visible main exists. Busy ancestors of a main
landmark also count. Hidden/inert/accessibility-hidden and offscreen regions are
ignored. Content, text and the final busy observation are captured together,
under the existing document revision/origin checks. Explicit caller readiness
and raw JSON/text handling keep their separate contracts. No expected fixture
marker is supplied to this mechanism.

The first complete comparison on `7c3b35864` returned 83/200 baseline versus
87/200 candidate normalized matches, but also revealed a real regression:
Bloomberg's editorial content was loaded while a labeled advertisement remained
busy. The new readiness flag incorrectly rejected two captures. The source was
corrected to ignore an explicit advertising region with `data-ad-status`,
`role="region"` and an advertisement accessibility label. Generic busy content
still counts. Failure-first HTTP fixtures and the full API fixture cover both
cases. That initial 400-request run is retained with its original source pin;
it is not a result for the corrected source.

The v2 API also rejected timeout-only readiness objects. `5b2efe29d` permits
`browserControls: {workflow: "auto", readiness: {timeoutMs: 1500}}` without a
selector/text predicate, and forwards that budget to the existing browser
control. Timeout-only objects without automatic workflow, empty readiness
objects and title-only automatic budgets remain invalid. The existing JS/Python
SDK types already support the optional fields. The API harness proves budget
forwarding at 1,200 ms, bounded unresolved content at 250 ms, and rejection before
navigation for an invalid combination. Partial nonempty content can retain an
HTTP 200 response with `CONTENT_NOT_READY` metadata; that is not completion proof.

Google's observed unusual-traffic form is now classified as verification using
its form, widget and visible message together. An ordinary CAPTCHA widget or a
documentation sample alone does not trigger it. A controlled HTTP 429 fixture
with two attempts allowed issues only one navigation. This avoids a futile
retry; it does not solve the verification or increase Google's retrieval rate.
The frozen benchmark grader and fallback classifier remain unchanged.

### Corrected comparison and outcome

The corrected source `38546557c` ran against `ac228cbf0` on all 100 frozen targets,
twice per profile. Both images used the same Linux ARM64 headful browser/base,
two CPUs/3 GiB/two pages per owner, four total client workers, direct Vietnam
egress, media enabled, consent rejection, automatic workflows, one attempt and
no expected-text readiness hint. The API budget addition does not alter this
browser-service comparison's five-second readiness budget.

| Check | Baseline, 200 requests | Corrected candidate, 200 requests |
| --- | --- | --- |
| Raw substring | 92 (46.0%) | 91 (45.5%) |
| Screened marker | 86 (43.0%) | 86 (43.0%) |
| Normalized marker | 88 (44.0%) | 88 (44.0%) |
| Screened-success p50 | 3,212 ms | 3,381 ms |
| Screened-success p95 | 6,752 ms | 8,767 ms |

There were 87 paired normalized matches, one candidate-only match, one
baseline-only match and 111 pairs matching neither. Airbnb increased from one
to two matches; Ashley Furniture decreased from two to one. Bloomberg passed
both rounds on both profiles after the advertisement correction. Candidate
loading signals were observed on Airbnb twice, Best Buy and Yahoo Finance;
all four completed within budget, with no remaining busy outcomes. The Ashley
loss timed out after about 84.9 seconds in the consent phase, before automatic
readiness started, with a recorded HTTP 200 document. This identifies a stalled
phase, not its cause.

The 87 common normalized-success pairs also had higher candidate latency:
nearest-rank p50 3,193→3,375 ms and p95 6,752→8,767 ms. Loading waits have a real
cost, and live-network/shared-host variation remains a confounder. Neither this
comparison nor the earlier superseded run supports claiming an aggregate
performance improvement. The implemented gains are a specific hydration
recovery, truthful loading/verification states and a configurable API wait budget.

All 400 records, hashes and scores replayed offline with unique target/round/profile
keys and unchanged grader/fallback bytes. Timing had no suspension gaps; peak
sampled memory was 1,503/1,141 MiB, resource-limit counters stayed zero, and both
owners ended healthy with zero pages/sessions before being stopped. The final
source passed [browser CI](https://github.com/toreleon/firecrawl/actions/runs/41622740722):
build, 49 helper checks, 67 integration checks and production dependency audit.
The final native API harness passed five real API checks and four contract checks,
including hydration while an advertisement remains busy, forwarded timeout-only
budgets, unresolved partial capture and invalid-input rejection before navigation.
An extract-worker AMQP closing error appeared during teardown; tests and harness
exited zero, and task infrastructure was stopped. Broader custom-runner server/SDK
CI remains queued. No hosted requests or credits were used.

The [final compact receipt](../apps/playwright-service-ts/benchmarks/primary-loading-results-2026-11-03.json)
contains source/image pins, both completed run references, audit hashes and the
common-success latency cohort. Hosted parity remains unproven. The last hosted
API pilot is still the separately pinned older comparison; these browser results
are not a refreshed hosted score, extraction F1 or proof of a complete crawl and
refresh system.

## Bounded consent discovery on stalled auxiliary frames

The historical Ashley Furniture and YouTube failures stopped during consent,
before automatic readiness. Fresh traces completed normally, so their original
root cause remains unknown. Source review found a narrower, reproducible risk:
explicit CMP discovery made four visibility calls on every frame. Playwright
[documents that the `isVisible` timeout option is ignored](https://playwright.dev/docs/api/class-locator#locator-is-visible).
A page script that blocks a child renderer can therefore hold up the parent
workflow while it waits for a browser protocol reply. The controlled blocked
cross-origin iframe fixture demonstrates this failure class; it does not prove
what happened on either historical live site.

Source `4a363134f` combines known CMP selectors into one visible-element query,
preserving utility-world and shadow-root locator behavior. Explicit discovery
has a three-second primary-frame allowance, one second per auxiliary probe and
a five-second discovery window within the caller's deadline. Known CMP actions
remain awaited and bounded. Expired read-only queries cannot proceed to another
query or an explicit click after their result arrives. This bounds the caller's
wait; it does not cancel the underlying browser RPC. Ambiguous buttons and
verification puzzles remain outside this mechanism.

Consent metadata now includes frames scanned, primary/auxiliary probe timeouts,
probe/action errors, window exhaustion and duration for the latest explicit
pass. An unknown stalled frame reports unresolved consent while usable primary
content can still be captured. A successful known primary choice retains its
receipt if an auxiliary probe later expires; it does not prove that consent
completed on every embedded origin. The pinned Autoconsent rules remain in use.

An initial one-second primary allowance passed locally but failed the known-CMP
fixture in CI. That source's live comparison was stopped at 199 completed records
and audited as partial. Its scores are excluded from the completed comparison.
The corrected fixture holds a synchronous child request without spinning the
CPU, then releases the child after consent returns and checks for late clicks.
The corrected source passed build, 50 helper checks, 71 browser integration checks
and dependency audit in [browser CI](https://github.com/toreleon/firecrawl/actions/runs/41630769224).
Six real full-API harness checks passed, including applied primary consent and
unresolved auxiliary consent with usable content. Extract-worker logged the
known AMQP closing error during teardown; tests and harness exited zero.

### Complete matched browser comparison

Both images ran all 100 frozen targets twice, using direct Vietnam egress,
Linux ARM64 headful Chromium, two CPUs/3 GiB/two pages per owner, four global
workers, media enabled, consent rejection, automatic workflow and one attempt.
Expected fixture text was not sent to either browser.

| Check | Baseline `38546557c`, 200 requests | Candidate `4a363134f`, 200 requests |
| --- | --- | --- |
| Raw substring | 92 (46.0%) | 93 (46.5%) |
| Screened marker | 85 (42.5%) | 87 (43.5%) |
| Normalized marker | 87 (43.5%) | 89 (44.5%) |
| Screened-success p50 | 3,533 ms | 3,552 ms |
| Screened-success p95 | 7,452 ms | 7,746 ms |

There were 86 common normalized matches, three candidate-only matches and one
baseline-only match. On the common cohort, nearest-rank p50 was 3,471→3,492 ms
and p95 was 7,452→7,502 ms. Amazon, Louis Vuitton and TikTok each gained one
match; Expedia lost one to a target HTTP 429. These few discordant live cases
cannot establish a causal aggregate improvement.

The candidate returned four auxiliary probe timeouts: Amazon, Target, YouTube
and Yahoo Finance. All four returned matching content. No returned primary probe
timed out. These are latest-pass counters on returned responses; baseline
counters were unavailable and must not be read as zero. Ashley Furniture and
YouTube passed both rounds on both profiles. The candidate's four full request
timeouts occurred during navigation on Allegro and Roblox, before consent.
This change does not repair those navigation failures.

All 400 evidence hashes and scores replayed offline, with unique keys, unchanged
grader/fallback bytes and valid timing. Sampled memory peaked at 1,502/1,494 MiB;
resource-limit counters stayed zero. Both owners ended healthy with zero active
pages/sessions and were stopped. The [compact receipt](../apps/playwright-service-ts/benchmarks/consent-probe-results-2026-11-03.json)
pins images, sources, audits, latency cohorts and the excluded partial attempt.

### Full API comparison on all 100 targets

The current fork (`4a363134f` API/browser, `6ba3ccc03` benchmark runner) was then
compared with the actual hosted v2 API on every frozen target, once per profile.
Both received fresh `rawHtml` plus Markdown requests, no expected-text hint,
`onlyMainContent: false`, zero explicit wait and an 85-second body timeout.
The fork additionally used the disclosed automatic browser controls. Four
client workers shared a per-profile limit of two and a seven-second dispatch
interval; queue and pacing waits were excluded from HTTP latency. Hosted
routing, region and internal retries remained provider-controlled, while the
fork used direct Vietnam egress. This is a product-outcome comparison, not a
matched proxy/browser experiment.

| Check | Direct fork, 100 requests | Hosted, 100 requests |
| --- | --- | --- |
| Raw substring | 45 (45%) | 80 (80%) |
| Screened marker | 41 (41%) | 79 (79%) |
| Normalized marker | 42 (42%) | 80 (80%) |
| Screened-success p50 | 3,016 ms | 5,895 ms |
| Screened-success p95 | 6,368 ms | 22,062 ms |

There were 34 common normalized matches, 46 hosted-only matches, eight fork-only
matches and 12 matching neither. The 34 common matches had nearest-rank p50
2,833/5,444 ms and p95 5,049/16,723 ms for fork/hosted. Faster successful fork
requests do not compensate for its substantially lower coverage. The old
selected 20-target pilot is a different workload and source, not a baseline for
attributing a percentage-point change.

Among the 46 hosted-only matches, fork failures were 18 verification pages,
17 HTTP 403 responses, three target rate limits, two network errors, two
timeouts, HTTP 417 and 405 once each, one content-readiness failure and one
missing marker. The latter was an explicit unavailable-region response on
Allmenus. These observations do not identify the underlying reason each site
blocked access. Adding workers would not resolve those responses.

Hosted explicitly refused ten sites under the account used; eight were
fork-only matches. Provider refusals remain in the original denominator and are
separate from target-site WAF failures. No API-level quota 429 occurred. The
lifecycle ledger verified four simultaneous HTTP requests globally and two per
profile, and every observed per-profile dispatch interval was at least 7,000 ms.
All 200 unique records, payload hashes, scores and source hashes replayed offline.
Timing was valid; sampled browser memory peaked at 1,091 MiB with zero resource
limit events. The browser ended with zero pages/sessions, all task infrastructure
stopped and the temporary hosted credential was deleted. The account balance
decreased by 114 credits over 100 hosted dispatches; balance changes can include
other account usage and are not an exact per-request invoice.

A supplementary offline Canada Goose audit found changed product-description
wording in both retrieved bodies while the frozen expected sentence remained in
metadata. Both still fail the unchanged marker rubric. This limits what the
score says about actual product content; normalized text checks also do not
establish CSS visibility or extraction F1. The [full API receipt](../apps/playwright-service-ts/benchmarks/full-api-frontier-results-2026-11-03.json)
contains the original 100-target denominator, per-target outcomes, provider
refusals, marker-quality evidence and source/credit/audit pins. Hosted parity is
not established.

## Supporting sidebars must not gate primary-content readiness

The complete hosted API comparison exposed a correctable Yahoo Finance failure.
The direct fork returned HTTP 200, the expected company marker in body text and
Markdown, and usable quote content. Its sole busy region was a widget list under
the supporting Dock sidebar, with skeletons and advertising. Because the site's
broad main wrapper contained the sidebar, automatic readiness counted it as
primary loading, waited five seconds and returned `CONTENT_NOT_READY`.

This is a captured false readiness failure, rather than evidence of an access
block. W3C defines [complementary landmarks](https://www.w3.org/WAI/ARIA/apg/patterns/landmarks/examples/complementary.html)
as supporting content that remains meaningful separately, and maps native
`aside` to that role. We infer that a busy supporting region inside a broad main
wrapper should not gate primary readiness. Source `8daec7135` implements that
rule without Yahoo-specific selectors or an expected-text hint.

The rule only applies when all relevant visible main landmarks contain the
supporting region. Body fallback still honors busy supporting content; a main
inside an aside, an aside explicitly assigned `role="main"` and busy ancestors of
main retain their loading signals. Final capture applies the same rule and
reports `ignoredComplementaryBusyCount`. Explicit caller readiness remains
authoritative. Author-provided landmark semantics can be wrong, so this does
not establish completeness of primary content or sidebars.

Seven focused readiness checks passed after the failure-first fixture. The
full API harness passed six checks, including primary results hydrating while
a supporting sidebar remains busy, and unresolved primary content retaining its
failure metadata. [Browser CI](https://github.com/toreleon/firecrawl/actions/runs/41637736679)
passed build, 51 helper checks, 73 integration checks and dependency audit.
The API harness logged the known extract-worker AMQP closing error during
teardown; tests and harness exited zero. Broader custom-runner server/SDK CI
remains queued. Protection classification and the frozen grader are unchanged.

The follow-up comparison used all 100 frozen browser targets once per image:
`4a363134f` baseline versus `8daec7135` candidate, four global workers and the same
Linux ARM64 headful base, direct Vietnam egress, two CPUs/3 GiB/two page permits,
media enabled, consent rejection, automatic workflow, one attempt and no expected
answer hint. This was a browser-service comparison; no hosted calls were made
for this fix.

| Check | Baseline, 100 requests | Candidate, 100 requests |
| --- | --- | --- |
| Raw substring | 45 (45%) | 45 (45%) |
| Screened marker | 42 (42%) | 41 (41%) |
| Normalized marker | 43 (43%) | 42 (42%) |
| Screened-success p50 | 3,966 ms | 3,913 ms |
| Screened-success p95 | 8,108 ms | 7,931 ms |

All 42 candidate normalized matches were shared with the baseline. The sole
baseline-only match was Yellow Pages: its candidate response had the marker but
HTTP 503, before automatic readiness ran. There were 57 pairs matching neither.
On the 42 common matches, nearest-rank p50 was 3,966→3,853 ms and p95
8,108→7,931 ms. This small latency change and one response-status difference do
not establish a causal aggregate gain or regression.

Yahoo Finance passed both profiles this time. The candidate observed and
excluded one supporting busy region on Yahoo Finance and one on Best Buy;
both returned matching content. The historical full-API false failure was not
reproduced in the live baseline, so the controlled API fixture provides the
causal regression proof. Neither the live run nor the semantic rule proves all
sidebar content was loaded.

All 200 unique records, hashes and scores replayed offline with unchanged frozen
grader/fallback bytes and valid timing. Memory peaked at 1,262/1,220 MiB with zero
resource-limit events. Both owners ended healthy with zero pages/sessions and
were stopped. The [compact receipt](../apps/playwright-service-ts/benchmarks/complementary-readiness-results-2026-11-03.json)
records the exact source/image pins, loss diagnostics, supporting-region cases,
current checks and separate historical classifier audit. The hosted API score
remains 42/100 versus 80/100 on the separately pinned `4a363134f` deployment;
it is not a refreshed score for `8daec7135`. No hosted parity is claimed.

## Optional Firefox backend and confirmed-failure fallback

The all-target hosted comparison left 46 hosted-only matches, including 18
verification outcomes and 17 target HTTP 403 failures on the fork. Readiness and
consent repairs do not account for this remaining access gap. The next bounded
experiment therefore changes browser implementation while retaining direct VN
egress, resource policy, consent and frozen scoring.

The [official TypeScript launcher](https://github.com/daijro/camoufox/tree/main/typescript)
supports a Firefox alternative. The package registry checked on November 3
reported `camoufox@0.5.9`, published November 1, requiring Node >=22.15 and
`playwright-core <1.63`. The fork pins core 1.62.0 independently of the existing
Chromium drivers. The [browser release](https://github.com/daijro/camoufox/releases/tag/v158.0.1-beta.41)
is pinned to `official/158.0.1-beta.41`; the Linux ARM64 asset's published SHA-256
is `60e25f6eb95e13d9ec655bc02913d51057e669cb31542e6ace9d2190ab5380af`.
The launcher verifies the downloaded asset against its manifest. Browser code is
MPL-2.0, launcher code MIT, with additional vendored notices. These software
licenses do not grant rights to collected site data.

The [usage documentation](https://camoufox.com/python/usage/) explains generated
browser identity and browser options; it is not evidence that a particular WAF
will accept a request. The integration chooses the actual host OS, disables
GeoIP matching, WebRTC and alternate DNS, and excludes the bundled ad blocker
so the service keeps its existing resource policy. Firefox uses no Chromium
arguments or channel. Localhost and resolved destinations must traverse the
same pinned filtering proxy, with SSRF checks enabled by default. No upstream
proxy or challenge-answering service was used.

### Isolated feasibility pilot

Before changing production dependencies, an isolated image overlaid only the
compiled browser factory. Source and compiled hashes identify that prototype
explicitly; it is not relabeled as integrated production support. A controlled
probe verified Firefox page/worker identity, the existing explicit consent
choice, and denial of localhost and a test DNS name resolving to loopback with
zero private-fixture hits.

Twenty selected frozen targets, including hard failures and several positive
controls, ran twice per profile: 80 total browser-service requests, four global
workers, two pages per owner, 2 CPUs/3 GiB each, headful Linux ARM64, media enabled,
fresh contexts, consent rejection and automatic workflow. No expected text was
sent to the service. Both profiles used direct VN egress and the unchanged grader.

| Pilot outcome, 40 requests/profile | Chromium | Firefox prototype |
| --- | --- | --- |
| Raw substring | 5 | 8 |
| Screened marker | 5 | 8 |
| Normalized marker | 7 | 10 |
| Peak sampled memory | 815 MiB | 1,834 MiB |

Five normalized matches were common, five Firefox-only and two Chromium-only;
28 pairs matched neither. Firefox added Amazon 2/2, Indeed 2/2 and Google Search
1/2, but lost Zoopla 2/2. Among the five common matches, p50 was 2,549→1,976 ms
and p95 44,027→9,260 ms. This small selected cohort cannot establish a stable
latency gain or full-dataset success rate. Every record, hash and score replayed;
timing was valid, no resource-limit events occurred, and owners finished with
zero pages and sessions. The initial launcher startup race dispatched zero
scrapes and is excluded. The [pilot receipt](../apps/playwright-service-ts/benchmarks/camoufox-pilot-results-2026-11-03.json)
preserves the prototype distinction, exact pins and audit digests.

### Integration and retry contract

Production support is opt-in with `BROWSER_ENGINE=camoufox`; Chromium remains
the default. Provision the pinned browser and model before serving work. The
optional Docker build downloads as the runtime user: a recursive ownership
change after extraction copied several GB into another layer during the initial
experiment. The compact experimental image uses actual compiled production
source, with no browser-factory overlay.

Compatibility tests exercise identity, headers/cookies/redirects, fresh-context
isolation, verification/status failures, short-deadline cleanup and the private
network guard. CI exposed a real Firefox allocation race: a 250 ms deadline
could expire while `newPage()` was still allocating, and context close then
blocked subsequent health discovery. The fix drains and closes a late page
within the cleanup budget before context cleanup. Three repeated short
deadlines now release capacity; the six Firefox checks also passed at 0.5 CPU
locally. This is a browser lifecycle repair, not a WAF success claim.

The full v2 API can opt in with `browserControls.engineFallback: true` and a
separate `LOCAL_BROWSER_FALLBACK_OWNER_URLS` pool. It allows at most one distinct
engine after a recognized failure with one completed attempt, page-closed proof
and matching process boot ID. Owner discovery and both attempts share the
original deadline. A lost response or unconfirmed cleanup never authorizes
another dispatch. Interactive actions, retained sessions and multi-attempt
retries reject this option. Successful primary results do not touch the alternate.
Both engines receive the same explicit consent/navigation policy and no answer
strings. Known primary failures are preserved when the alternate also fails;
metadata distinguishes selecting the secondary from recovering usable content.

The installed filtering proxy maps HTTP connection resets to status 595. A real
API fixture caught this case after the initial unit design; the policy now
recognizes that confirmed closed-page status without inventing a successful
network result. The corrected seven-check API harness passed on source
`90cd76c6ca877a41bc62fac2ca8ff09839456a83`, including alternate recovery,
denial preservation, action/session rejection and existing workflow/session
contracts. Twenty focused API client/contract checks, five JS scrape tests plus
SDK build, and two Python serialization checks passed. Extract-worker still
logged an AMQP closing error during harness teardown; tests and harness exited
zero. Broader custom-runner server and SDK CI remain separately queued.

The [browser CI on the measured source](https://github.com/toreleon/firecrawl/actions/runs/41649010785)
passed build, helper/integration checks and the production dependency audit.
Configuration and diagnostic limits are in [browser workflows](browser-workflows.md#optional-alternative-browser).

### Completed full API policy comparison

Source `90cd76c6ca877a41bc62fac2ca8ff09839456a83` completed 200 fresh v2 API
requests: one per frozen target for each of two profiles on the same API. Both
used automatic workflows, consent rejection, DOM-content-loaded navigation,
one service attempt per dispatch, media enabled and no marker readiness hint.
Only `engineFallback` differed. Four global HTTP workers and two slots per
profile stayed within the user's eight-worker ceiling. There were no hosted
requests or upstream proxies; browser egress was checked as VN.

Two Chromium owners served both profiles. The adaptive profile could also use
one separate Firefox owner; each owner had 2 CPUs, 3 GiB and two page slots.
All three used image
`sha256:30a3d3a0988726a9724e88623e28290faac94f10d8bd03cab818aa8e1cdb8ba0`.
Twenty-six source/compiled browser hashes matched the checkout before dispatch,
and API source/compiled hashes remained unchanged across the run. This compares
an extra sequential attempt and extra owner capacity, not equal-cost engines.

| All 100 targets, one request/profile | Baseline | Opt-in fallback |
| --- | --- | --- |
| Raw substring | 46/100 | 57/100 |
| Screened marker | 44/100 | 54/100 |
| Normalized marker | 45/100 | 55/100 |
| Screened-success p50 | 3,073 ms | 3,981 ms |
| Screened-success p95 | 7,120 ms | 10,791 ms |
| Primary browser dispatches | 100 | 100 |
| Additional Firefox dispatches | 0 | 48 |
| API quota 429 responses | 0 | 0 |

There were 45 common normalized matches, ten adaptive-only, zero baseline-only
and 45 matching neither. Nine added matches used a confirmed successful Firefox
attempt: Indeed, Louis Vuitton, Expedia, MarketWatch, Barron's, Reuters,
Capterra, SeatGeek and Apartments.com. Google Search also matched only in the
adaptive profile, but its primary Chromium attempt succeeded without fallback;
that difference cannot be attributed to Firefox. Amazon succeeded in both
profiles on this run. Among the 45 common matches, p50 increased
3,073→3,772 ms and p95 7,120→9,475 ms. More coverage came with added time and
browser work; there is no aggregate speedup claim.

Backend logs account for exactly 200 primary dispatches, 100 per owner, plus 48
alternate calls with no target sent to the alternate twice. Returned fallback
metadata exists on 97 adaptive responses: 46 report an attempted alternate,
13 report backend recovery, and nine of those meet the frozen normalized marker.
Canada Goose, American Airlines, eBay and Skyscanner were labeled recovered by
the backend without the expected marker and remain failures. The later shell
audit below found eBay and Skyscanner were verification pages, not usable target
content; those runtime classifications were corrected. Three API errors have
no returned fallback diagnostics; their secondary-dispatch state is not inferred
from that absence. Owner logs provide total dispatch accounting.

The first monitoring run stopped at 24 completed results because it treated
`memory.events:sock_throttled` as a fatal resource-limit event. That partial run
is retained and excluded. The corrected monitor still stops on memory/process
limits and OOM, but records socket throttling separately, following the
[kernel counter definitions](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).
In the completed run, socket-throttling counters reached 473/1,017/563 for the
two primary owners and Firefox. Other memory/process-limit and OOM counters
were zero. Peak sampled memory was 1,054/1,043/2,697 MiB. Socket throttling,
shared-host contention and live-site variation limit causal latency conclusions.

All 200 unique records, payload/content hashes, scores and summary metrics
replayed offline. Lifecycle overlap peaked at four globally and two per
profile; timing gaps stayed below 1,025 ms. All owners finished healthy with
zero pages/sessions, then were stopped and removed. Task database/queue/cache
containers were stopped. The [full API fallback receipt](../apps/playwright-service-ts/benchmarks/api-engine-fallback-results-2026-11-03.json)
includes owner-log dispatch accounting, returned-versus-missing metadata,
resource counters, exact pins and validation digests.

This is a measured ten-point coverage gain on the current fork, not hosted
parity. The separately pinned hosted run remains 80/100 normalized matches on
the earlier `4a363134f` comparison; it was not refreshed for this source.
One live round and one marker per site do not establish stable WAF-brand
success, extraction fidelity or complete crawl/refresh behavior.

### Docker storage hygiene

The task removed 50 older stopped benchmark containers and obsolete Firecrawl
image tags after preserving logs and image/source digests. New harness and
benchmark launchers archive logs/state and remove their browser containers in
cleanup. The Dockerfile provisions optional Firefox as the runtime user to avoid
duplicating its extracted browser/font bundle in an ownership-change layer.
Reported image usage fell from 37.6 GB to 28.89 GB; this is Docker accounting,
not proof that its host VM disk file shrank by that amount. The current compact
image and small stopped test infrastructure remain available. Unrelated running
services, images and data volumes were not pruned. Shared build cache and
unidentified volumes are retained; no global prune was used.

## Passive continuation timing and unrendered verification shells

The next investigation used the retained 45 failures from the full API fallback
run. Canada Goose and American Airlines had substantive body content with the
frozen expected sentence only in metadata; Canada Goose used different current
product wording. Their original scores remain unchanged. eBay and Skyscanner
were more serious runtime errors: both were labeled `CONTENT_READY` and selected
as recovered alternates while still on verification documents. Temu's body
contained only zero-width format characters. Redfin's AWS CAPTCHA (HTTP 405)
and eMAG's custom AWS CAPTCHA (HTTP 511) also had `CONTENT_READY` state.

[AWS documents](https://docs.aws.amazon.com/waf/latest/developerguide/waf-captcha-and-challenge-actions.html)
the `x-amzn-waf-action` header, a passive HTTP 202 challenge and interactive
HTTP 405 CAPTCHA. Its CAPTCHA is distinct from an ordinary embedded SDK widget.
[HUMAN documents](https://docs.humansecurity.com/applications/advanced-blocking-response)
custom and embedded challenge containers; `px-captcha` alone cannot establish
that every ordinary page containing it is blocked. The runtime therefore uses
combined header, script, interstitial-structure and dedicated-route evidence.
Commented examples, inline script strings, similarly named untrusted hosts and
normal contact-form SDK embeds are negative test cases. The frozen grader and
fallback classifier are unchanged.

The observed eBay document had its continuation form, browser-check message and
first-party challenge script, but had not redirected yet. Automatic readiness
now waits passively for that document to finish within the existing budget,
without clicking or submitting a form. [Playwright's navigation documentation](https://playwright.dev/docs/navigations)
explains why DOM-content-loaded or even load cannot establish completion of
later client activity. Controlled fixtures demonstrate both delayed successful
redirects and bounded unresolved shells, without using an expected-text hint.
Format-only text no longer satisfies readiness; ordinary text and emoji still do.

### Matched Firefox experiment

Production source `6ed6b1024342b4734098f6ca76f0c47710a01e47` ran against the
prior production Firefox image on 20 selected targets, twice per profile:
80 fresh browser-service requests, four global workers, two slots per profile,
2 CPUs/3 GiB per owner, headful Linux ARM64, direct VN egress, media enabled,
consent rejection and automatic readiness with no marker hint. This is a
selected-target experiment, not an all-target API or hosted comparison.

| Selected 40 requests/profile | Previous build | Shell/readiness repair |
| --- | --- | --- |
| Raw substring | 22 | 21 |
| Screened marker | 21 | 21 |
| Normalized marker | 23 | 23 |
| eBay normalized matches | 0/2 | 2/2 |
| Screened-success p50 | 5,695 ms | 5,472 ms |
| Screened-success p95 | 10,184 ms | 11,207 ms |

The overall normalized count tied. Louis Vuitton and Capterra each lost one
match while eBay added two. The first eBay success waited about three seconds
for the passive check before capturing product content. Redfin and eMAG were
correctly identified as interactive verification instead of ready content.
Temu waited for visible content rather than accepting a format-only shell; it
still did not match the frozen discontinued-product marker. These findings
support the targeted repair and more faithful outcomes, not an aggregate gain.

All 80 unique records, hashes, scores and summary metrics replayed offline.
Actual overlap stayed at four globally/two per profile. Timing was valid,
memory/process-limit and OOM events were zero, and socket-throttling counters
were retained separately. Peak memory was 2,175/2,024 MiB. Both owners finished
with zero pages/sessions and were removed after archiving logs. The
[paired receipt](../apps/playwright-service-ts/benchmarks/runtime-shells-paired-results-2026-11-03.json)
includes target changes and exact image/source/runtime hashes. A separate
offline classification audit checked 1,037 successful captures from seven
earlier browser/API runs and found zero new rejections; this includes retained
hosted HTML, not new hosted requests.

The live test also showed that a loaded HUMAN press-and-hold page reached the
older detector before the new dedicated-route detector. Source
`b7da5a8a047896ba1b60526012e823b2e877c7b3` annotates those already recognized
interactive providers consistently, avoiding a futile passive wait. It passed
58 helper checks, 11 packaged Chromium/Firefox contract checks and eight real
full API harness checks. The eight-check API harness passed on both source
versions; the initial Unicode fixture was corrected to declare UTF-8 explicitly.
The prototype fixture failure is not reported as a production runtime failure.

### Fresh full API result on the final runtime

The completed rerun on `b7da5a8a0` made 200 fresh API requests: all 100 targets
with fallback disabled and enabled, four global workers and two slots per
profile. Both used the final production browser image, two primary Chromium
owners and one optional Firefox owner, with 2 CPUs/3 GiB/two pages per owner.
No expected text hint, upstream proxy or hosted request was used.

| Final runtime, 100 requests/profile | Without fallback | With fallback |
| --- | --- | --- |
| Raw substring | 43 | 52 |
| Screened marker | 41 | 50 |
| Normalized marker | 42 | 51 |
| Screened-success p50 | 3,113 ms | 3,270 ms |
| Screened-success p95 | 6,509 ms | 6,881 ms |
| Extra Firefox calls | 0 | 50 |

There were 42 common matches, nine adaptive-only and no baseline-only matches.
Eight additions used confirmed alternate recovery; eBay passed in the adaptive
profile's primary Chromium attempt. All eight returned backend recoveries also
matched the frozen normalized marker in this run. Five API errors had no returned
fallback diagnostics; owner logs still account for all 200 primary and 50
alternate calls, with no alternate target repeated. The 42 common matches had
p50 3,075→2,651 ms and p95 6,509→6,443 ms. Different successful cohorts and live
variation prevent a causal aggregate latency claim.

The new adaptive total, 51/100, is below the earlier 55/100; its primary-only
comparison also fell from 45/100 to 42/100. Across the unmatched adaptive runs,
eBay added a match while Amazon, Yahoo Finance, Louis Vuitton, Zoopla and
Apartments.com lost matches. Amazon triggered the existing final product-identity
guard after continuation, so a different document was never promoted as the
requested product. Yahoo's primary failed with `net::ERR_EMPTY_RESPONSE` and
Firefox failed with `NS_ERROR_NET_RESET`. The other three returned HTTP 403 or
verification in both engines. These observations identify concrete remaining
failures; they do not establish that all differences were caused by the repair.
Firefox reset classification and Amazon continuation stability remain follow-up
work. The overall change does not establish an aggregate success-rate increase.

The [full API receipt](../apps/playwright-service-ts/benchmarks/runtime-shells-full-api-results-2026-11-03.json)
records all 200 replayed hashes/scores, cross-run changes, error diagnoses,
exact source/image pins and [browser CI](https://github.com/toreleon/firecrawl/actions/runs/41655505422)
(58 helper checks, 90 integration checks, build and dependency audit passed).
Eight real API checks passed on this final source. Timing was valid, primary
owners peaked at 1,336/960 MiB and Firefox at 1,669 MiB. Memory/process-limit
and OOM counters were zero; Firefox reported 132 socket-throttling events.
All owners finished with zero pages/sessions and were removed after archiving
logs; task infrastructure was stopped. A one-profile configuration was rejected
before dispatch because the comparison runner requires two profiles; that
zero-request validation abort is retained separately. Broader server/SDK CI has
not passed. The earlier hosted score remains 80/100 on its separately pinned
comparison, not a current hosted result or proof of parity.
