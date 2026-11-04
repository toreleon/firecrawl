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

## Amazon navigation commits and Gecko transport failures

The follow-up examined two concrete failures from the 51/100 API run. A new
three-request Chromium probe of the original Amazon URL on the pinned prior
image produced one direct product capture and two
`WORKFLOW_NAVIGATION_MISMATCH` failures. Both failed captures had reached the
storefront after a submitted continuation; the final identity guard prevented
that storefront from being reported as the requested product.

The workflow had relied on `waitForLoadState` and read `page.url()` separately
from an awaited form query. The old document can already satisfy that load
state, and navigation can occur between the URL read and form observation.
The repair registers a main-frame navigation listener before clicking the
observed GET continuation and awaits the commit. A single renderer query then
observes the URL and verification controls together. A bounded five-second
settling window handles delayed continuations, inside the original request
deadline. It preserves the one-submission/one-return limit and the final
origin/product check. It does not fill verification answers or count a
storefront as product success.

The [Playwright Page reference](https://playwright.dev/docs/api/class-page)
documents the frame-navigation event and load-state behavior; controlled
fixtures provide the causal regression evidence. The new delayed-return
fixture failed against the old production image with a product-identity
mismatch, then passed on the repair. Fixtures also keep an over-budget form
unresolved and reject immediate or late redirects to a different product.

Firefox's `NS_ERROR_NET_RESET` had been reduced to generic `BROWSER_ERROR`.
The repair retains Gecko transport codes and treats reset, interrupted transfer
and network timeout as transient only for explicit stateless retries. Unknown
host and refused connection remain typed network errors without automatic
transient retries. Native cancellation, certificate and policy failures are
negative cases. [Mozilla's reset-error investigation](https://bugzilla.mozilla.org/show_bug.cgi?id=2068800)
also distinguishes HTTPS resets from certificate failures; a reset does not
justify disabling TLS verification. Default attempts remain one.

A real local TCP-reset fixture reached through the pinned Firefox browser
verified the raw transport code, one versus two requested browser attempts,
closed pages and released capacity. The fixture makes no external requests.
Sixteen packaged browser/workflow checks, 59 helpers and eight real API harness
checks passed on source `025f01ec118ca369ad46e5fa9d09be20fa4e0106`.
[Browser CI](https://github.com/toreleon/firecrawl/actions/runs/41659246359)
passed all 59 helper and 91 integration checks, build and production dependency
audit. These checks establish lifecycle/classification behavior, not a new
retrieval success rate for Yahoo Finance.

### Matched Amazon measurement

Five fresh attempts per production Chromium image ran on the single frozen
Amazon target, interleaving profile order with two workers and one HTTP slot
per profile. Both used headful Linux ARM64, 2 CPUs/3 GiB/two page capacity,
direct VN egress, consent rejection, automatic workflow, media enabled and one
service attempt. No expected marker was sent as a readiness hint.

Both builds matched on 3/5 attempts and each had two transport failures.
Every successful capture used the one-submit/return workflow and retrieved the
original product. The earlier capture race did not reproduce in the baseline
of this matched run, so no live success-rate gain is established. Screened
success p50 was 9,484→8,870 ms and p95 9,694→10,327 ms; five observations are
too few for a stable latency conclusion. All ten records, hashes and scores
replayed offline; timing was valid and both owners finished with zero
pages/sessions, then were removed. Exact pins and state observations are in the
[matched receipt](../apps/playwright-service-ts/benchmarks/amazon-commit-paired-results-2026-11-03.json).

### Full API rerun on the repaired source

Source `025f01ec1` completed another 200 fresh requests on all 100 frozen
targets, with fallback disabled/enabled on the same API. The setup retained
four global workers, two slots per profile, two primary Chromium owners and
one optional Firefox owner, 2 CPUs/3 GiB/two page slots each. Browser/service
hashes and API source/compiled hashes were verified. No proxy, marker hint or
hosted request was used, and the per-dispatch attempt count stayed one.

| All 100 targets, one request/profile | Without fallback | With fallback |
| --- | --- | --- |
| Raw substring | 45 | 53 |
| Screened marker | 43 | 51 |
| Normalized marker | 44 | 52 |
| Screened-success p50 | 3,479 ms | 3,976 ms |
| Screened-success p95 | 6,844 ms | 8,318 ms |
| Additional Firefox calls | 0 | 52 |

There were 43 common matches, nine adaptive-only, one baseline-only (eBay),
and 47 matching neither. Seven adaptive-only matches used confirmed alternate
recovery; two had successful primary responses. Ten returned backend recoveries
included nine frozen normalized matches. Five API errors lacked fallback
metadata, so owner logs account for all 200 primary and 52 alternate calls.
No alternate target repeated. Among the 43 common matches, p50 was
3,444→3,810 ms and p95 6,844→7,437 ms. Added coverage still costs browser work
and time.

The prior adaptive run scored 51/100; the current one scored 52/100. Across
those unmatched live runs, Louis Vuitton and Yahoo Finance added matches while
eBay lost one. Yahoo succeeded in both current profiles without alternate
recovery, so that change cannot be attributed to the Gecko error classification.
Amazon still failed the final product-identity check in both full API profiles.
The controlled navigation repair is verified, but it has not resolved every
live Amazon continuation outcome. The matched Amazon test tied, so no causal
aggregate code-version improvement is established.

All 200 unique records, hashes and scores replayed offline with valid timing
and overlap at four globally/two per profile. Peak sampled memory was
1,352/1,535/1,503 MiB across the two primary owners and Firefox. Memory/process
limit and OOM counters were zero; Firefox recorded 31 socket-throttling events.
Owners finished with zero pages/sessions and were removed after preserving
logs; task infrastructure stopped. The [full receipt](../apps/playwright-service-ts/benchmarks/amazon-gecko-full-api-results-2026-11-03.json)
records source pins, actual dispatches, remaining Amazon/Yahoo/eBay outcomes,
unmatched cross-run changes and validation digests. The earlier 80/100 hosted
score remains separately source-pinned; hosted parity is still unproven.

## Recovering a confirmed product-identity failure on another engine

The previous full API run still failed Amazon before the alternate engine was
considered: `WORKFLOW_NAVIGATION_MISMATCH` was terminal even after the stateless
page had closed. Earlier Firefox captures showed the requested product could be
retrieved through a different browser. Source `8215f48b9` therefore adds one
narrow eligibility case: an explicitly opted-in Amazon product request using
the automatic workflow may fetch the original URL on a distinct engine after
confirmed identity-error cleanup. Lost responses, wrong owner identity, failed
page cleanup, retained sessions, actions and additional retries remain ineligible.

The identity guard was strengthened at the same time. Browser captures must
retain the original requested ASIN even when there was no continuation form.
The API independently validates successful primary and alternate landed URLs,
including responses from older owners. A wrong product, foreign host, missing
URL, nonstandard port or credential-bearing URL cannot establish recovery.
Failed HTTP/protection captures retain their explicit failure states; a failed
alternate is never counted as a successful product. No third dispatch is made.
The checks identify a product by its recognized URL, not a complete semantic
attestation of every field in its body.

Twenty-five focused API client/contract checks passed. A full API harness with
controlled HTTP browser-protocol fixtures exercised seven modes: primary
identity error, an old owner's wrong-document success, a wrong-product alternate,
missing alternate URL, unclosed primary page, wrong primary boot ID and opt-out.
It tested the real API/queue/worker path but is not real-browser evidence.
Separately, eight API checks used real browser owners and eighteen packaged
browser/workflow checks passed. Offline browser fixtures reject wrong products
without a continuation form while allowing explicit failed HTTP/protection
captures. The old production image failed the new wrong-product fixture.
[Browser CI](https://github.com/toreleon/firecrawl/actions/runs/41664075243)
passed build, 59 helpers, 94 integration checks and dependency audit.

### Five-round full API Amazon comparison

The current API ran five fresh requests per policy against the single frozen
Amazon URL: two global workers, one slot per profile, one-second profile pacing,
rotating profile order, two primary Chromium owners and one optional Firefox
owner. Each owner had 2 CPUs/3 GiB/two page slots. Direct VN egress, enabled media,
consent rejection, automatic workflow, original deadlines and the frozen grader
were retained; no expected marker, proxy or hosted request was used.

Without fallback, the marker matched on **1/5** requests. With fallback it matched
on **5/5**. Four adaptive requests first returned a closed-page Chromium identity
failure, then captured the original ASIN with Firefox and the expected marker.
The fifth succeeded in primary Chromium. The corresponding baseline's first
four requests failed the identity guard; its fifth succeeded. Logs account for
ten primary calls and four alternate calls. This shows the new recovery path
working on real requests, not a skipped guard or a storefront accepted as a
product. It remains a selected five-attempt cohort, not an all-target rate.

Successful p50/p95 was 11,043/11,043 ms for the sole baseline match and
16,016/17,212 ms for the adaptive matches. Different cohorts and one baseline
success prevent a general latency conclusion; the extra browser work is explicit.
All ten unique records, hashes, scores and lifecycle bounds replayed offline.
Owners finished with zero pages/sessions and were removed after archiving logs.
The [targeted API receipt](../apps/playwright-service-ts/benchmarks/identity-fallback-amazon-api-results-2026-11-03.json)
records the closed-page proof, original landed URL, source/image hashes and
the separate real-browser versus protocol-fixture validation.

### Full API result after identity-failure recovery

The same source completed a fresh deployment and all 200 requests on the frozen
100-target set, one per policy per target. It used four global workers, two slots
per profile, the same owner resource limits and no upstream proxy or hosted call.

| All 100 targets, one request/profile | Without fallback | With fallback |
| --- | --- | --- |
| Raw substring | 45 | 55 |
| Screened marker | 43 | 52 |
| Normalized marker | 44 | 53 |
| Screened-success p50 | 3,855 ms | 4,020 ms |
| Screened-success p95 | 7,762 ms | 10,017 ms |
| Additional Firefox calls | 0 | 52 |

There were 43 common matches, ten adaptive-only, one baseline-only (TikTok) and
46 matching neither. Eight adaptive-only matches used confirmed alternate
recovery; Zoopla and Yellow Pages succeeded through primary responses.
Ten returned backend recoveries all matched the frozen normalized marker in
this run. Three API errors lacked returned fallback diagnostics. Owner logs
account for all 200 primary calls and 52 alternate calls, with no alternate
target repeated. Common-success p50 was 3,671→3,645 ms and p95
7,762→10,017 ms; these small live cohorts do not establish stable latency gains.

Amazon succeeded in primary Chromium in both full-run profiles, so this run
does not itself exercise the new identity-error branch. The separate five-round
API measurement provides that direct evidence. Compared with the prior,
unmatched 52/100 adaptive run, Amazon, eBay, Apartments.com and Zoopla added
matches, while Louis Vuitton, Google Search and TikTok lost matches. The current
53/100 does not establish a causal aggregate code-version gain. The unchanged
primary-only total was 44/100 in both runs.

All 200 unique payload/content hashes, scores, summaries and source pins
replayed. Actual overlap stayed at four globally/two per profile, and timing
was valid. Peak sampled memory was 965/1,013/1,960 MiB for the two primary
owners and Firefox. Memory/process-limit and OOM counters were zero; separate
socket-throttling counters were 0/126/301. Every owner finished healthy with
zero pages/sessions and was removed after preserving logs; test infrastructure
stopped. The [full receipt](../apps/playwright-service-ts/benchmarks/identity-fallback-full-api-results-2026-11-03.json)
includes missing-versus-returned diagnostics, dispatch accounting, source/image
pins and unmatched prior-run changes. Hosted parity is still unproven; the
earlier 80/100 hosted result was not refreshed for this source.

## Waiting for a passive connection page across HTTP 403

The retained failures exposed a lifecycle gap: automatic body readiness ran only
after 2xx responses. Trustpilot returned a small HTTP 403 `Verifying Connection`
document with an AWS edge challenge script and its own interstitial script, so
the browser captured it while those scripts were still running. AWS documents
that its native challenge scripts can obtain a token and resubmit the original
request; waiting for that browser-owned flow is different from accepting the
interstitial as requested content. See [AWS action behavior](https://docs.aws.amazon.com/waf/latest/developerguide/waf-captcha-and-challenge-actions.html).

Cloudflare's [response documentation](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)
says its challenge header covers all challenge types. Its [challenge overview](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/)
also describes passive JavaScript completion and possible interactive escalation.
The header alone therefore does not establish that waiting will retrieve the
requested content. An exploratory eight-second fixed-wait probe returned 26 of
36 planned responses before its resource guard stopped the run. Trustpilot
passed with the delay and failed without it in both browser engines; completed
Cloudflare observations remained challenged. The failing resource sample was
not persisted before the guard raised. The exact event is unknown, and no
complete-run success rate or final health claim is made for that probe.

Source `02f47b315` adds a narrow runtime recognition rule for the observed AWS
connection document: its title, live HTTPS AWS edge SDK script, local bootstrap,
loading/status containers and waiting or verified-redirecting text must agree.
Automatic workflows may then wait within the existing readiness budget even
when the initial response is 403. Once identified, that verification document
cannot become ready merely by changing a status label; a successful response
must arrive. Explicit readiness, workflow opt-out, ordinary denials and
interactive CAPTCHA retain their own behavior. Frozen grading is unchanged.

The first implementation still captured the intermediate `Verified!
Redirecting...` label before navigation, producing 0/5 Trustpilot matches in
both browser-runtime profiles. A second failure-first fixture reproduced that
specific transition. The final fixture covers successful return, unresolved
waiting, verified-but-stuck and unknown-but-stuck labels, workflow opt-out,
ordinary denial and interactive CAPTCHA. Sixty helper checks and the native
integration suite passed (83 checks, three configuration skips). Thirteen
packaged readiness/product/verification checks passed with Chromium and Firefox.
[Browser CI](https://github.com/toreleon/firecrawl/actions/runs/41670175837) on
the final source passed build, 60 helper checks, 97 integration checks and the
production dependency audit.

### Five-round browser-runtime comparison

The old image (`8215f48b9`) and revised image (`02f47b315`) each captured five
fresh requests for the affected Trustpilot URL and two controls. Both used
headful Linux ARM64 Chromium, direct VN egress, 2 CPUs/3 GiB/one page slot per
owner, no fixed wait, a five-second readiness allowance, consent rejection and
the automatic workflow. Requests ran as rotating, coupled profile pairs with
two global workers. No expected marker or hosted request was used.

| Frozen target, five requests/profile | Prior runtime | Revised runtime |
| --- | --- | --- |
| Trustpilot Amazon reviews | 0/5 | 5/5 |
| GitHub React repository | 5/5 | 5/5 |
| StockX Cloudflare control | 0/5 | 0/5 |

All thirty responses were captured. The original post-run verifier rejected
Trustpilot's canonical `/review/amazon.com` → `/review/www.amazon.com` redirect,
so the runner exited before persisting its report/timing diagnostics and the
launcher did not collect final health. A corrected offline verifier explicitly
allows only those two review paths, checks the Amazon Reviews title and rendered
review text, and replays every original score/hash without new network requests.
The revised captures contained over 1,000 rendered characters and retained the
review identity; their automatic wait was 2,588–4,494 ms. Per-response closed-page
and owner proofs, recorded zero resource-event counters and removed-container
receipts were checked separately. No uninterrupted-clock or final-health claim
is inferred from the failed post-run validator.

The [experiment receipt](../apps/playwright-service-ts/benchmarks/passive-verification-paired-results-2026-11-03.json)
preserves all three stages: the interrupted 26-response probe, the first
30-response implementation with no gain, and the revised 30-response measurement.
All 86 returned observations replayed. This selected five-round comparison
supports the specific lifecycle repair; it does not establish an all-target
gain, extraction F1 or hosted parity.

### Full API result after passive connection readiness

Source `02f47b315` then completed a fresh full API deployment and all 200
requests on the frozen 100-target set, one request per policy per target.
Four global workers/two per profile, direct VN egress, fresh contexts,
rawHTML/Markdown, enabled media and no expected-text hint were retained.
Both primary Chromium owners and the optional Firefox owner used image
`sha256:4cf1c1eb4550e82504a0f11af5817e2a95143bc96e3b83f081400764e51a8244`
with 2 CPUs/3 GiB/two page slots each. The API source and compiled hashes were
unchanged during the run; browser source/compiled hashes matched preflight.

| All 100 targets, one request/profile | Without fallback | With fallback |
| --- | --- | --- |
| Raw substring | 45 | 57 |
| Screened marker | 44 | 55 |
| Normalized marker | 45 | 56 |
| Screened-success p50 | 3,106 ms | 3,357 ms |
| Screened-success p95 | 6,384 ms | 7,103 ms |
| Additional Firefox calls | 0 | 50 |

All 45 baseline matches also matched in the adaptive profile. Eleven targets
matched only with the adaptive policy and 44 matched neither. Nine adaptive-only
matches used confirmed alternate recovery; Amazon and Zoopla had successful
primary responses. Of eleven reported backend recoveries, ten matched the
frozen normalized marker; American Airlines remained a marker failure. Three
API errors lacked returned fallback diagnostics. Owner logs account for all
200 primary and 50 alternate dispatches, with no alternate target repeated.
Common-success p50 was 3,106→2,942 ms and p95 6,384→6,860 ms. The extra browser
work remains explicit; these live cohorts do not establish stable latency gains.

Trustpilot passed through primary Chromium in both profiles (7,379/5,441 ms),
so the full API path exercised the repaired readiness behavior without using
the alternate browser for that target. Compared with the preceding unmatched
53/100 adaptive run, WSJ, Google Search, TikTok and Trustpilot added matches,
while Apartments.com lost one. The current 56/100 is not a causal three-point
code-version gain; the selected runtime comparison supplies the direct evidence
for the Trustpilot fix.

All 200 payload/content hashes, scores, summaries, source pins and lifecycle
bounds replayed. Observed HTTP concurrency stayed at four globally/two per
profile and timing was valid. Peak sampled owner memory was
1,056/1,082/1,997 MiB. Memory/PID limit and OOM counters were zero; the separate
Firefox socket-throttling counter reached 116. Owners finished healthy with
zero pages/sessions and were removed after logs were preserved. Test
infrastructure stopped. The harness and replay exited zero; the extract worker
again logged AMQP closing during teardown. API/SDK code was unchanged, so its
earlier eight-test browser API harness is identified as inherited evidence,
separately from these current 200 real API records.

The [full API receipt](../apps/playwright-service-ts/benchmarks/passive-verification-full-api-results-2026-11-03.json)
records the diagnostic gaps, actual dispatch accounting and current-source CI.
Hosted was not refreshed: its earlier 80/100 result remains source-pinned to
the older comparison. Hosted parity is unproven. The [cleanup receipt](../apps/playwright-service-ts/benchmarks/passive-verification-cleanup-results-2026-11-03.json)
records removal of prototype/obsolete task image tags while retaining the
current image, stopped test infrastructure and all unrelated data volumes.

## Testing remaining timeout, driver and session hypotheses

The next investigation kept production source unchanged and separated three
failure classes before changing the fallback policy. A saved Canada Goose
timeout came from a two-second product-details click intercepted by OneTrust,
not the total navigation deadline. Playwright's [actionability contract](https://playwright.dev/docs/actionability)
checks whether another element receives the pointer event; the observed call
log identified the consent overlay. In fresh probes both browser engines
expanded the product details, but the current rendered description differed
from the frozen expected sentence, which appeared only in metadata. Those
observations remain marker failures; forcing a click or changing the grader
would not establish retrieval of that expected body text.

That transport/consent probe returned four of eight planned observations before
its resource guard stopped it. The retained Firefox sample recorded
`memory.events:max=196`, with zero OOM/OOM-kill and PID-limit counters. It had
reached the 3 GiB memory boundary; the exact event is preserved, unlike the
earlier fixed-wait probe whose failing sample was missing. Both created
containers were stopped and removed. Unfinished cases are not counted as
observed failures.

### Existing driver portfolio

Thirty-four current adaptive failures that matched in the earlier hosted run,
plus GitHub and arXiv controls, were fetched once with Rebrowser and Patchright
using the same pinned image. A fresh Firefox owner separately tested Roblox and
GitHub without first loading the memory-heavy Canada Goose page. All owners
used headful Linux ARM64, direct VN egress, 2 CPUs/3 GiB/one page slot, a
30-second service deadline, automatic workflows, consent rejection and no
expected-text hint. Three global workers ran 74 browser-service requests.

| Selected observations | Rebrowser | Patchright | Firefox |
| --- | --- | --- | --- |
| Normalized marker matches | 3/36 | 3/36 | 1/2 |
| Matching targets | Verizon, GitHub, arXiv | Verizon, GitHub, arXiv | GitHub |
| Roblox | Navigation timeout | Navigation timeout | Navigation timeout |

Patchright added no exclusive match. Verizon passing in both Chromium profiles,
after failing the prior full run, illustrates live variability. All three
Roblox failures occurred before the destination document committed; retained
diagnostics showed its initial 301 and no successful destination response.
This probe does not show that reserving time for a second engine will recover
Roblox, nor does a thirty-second observation prove a permanent outage or its
network/access-policy cause. No default driver or deadline-splitting change was
made on this evidence.

### Same-origin retained-tab warm-up

DataDome documents its [browser JavaScript tag](https://docs.datadome.co/docs/javascript-tag)
and [cookie/session storage](https://docs.datadome.co/docs/cookie-session-storage)
as parts of protection and session handling. That made homepage initialization
a testable hypothesis, not a guarantee that it would permit a protected URL.
Six selected targets compared a fresh direct visit with a same-origin homepage
visit, three seconds for its scripts, then the original URL in the same retained,
origin-fenced tab. Both profiles used Rebrowser and two global workers.

The direct and warm-up profiles each matched only GitHub (1/6). Lowe's and
Crunchbase homepages returned 200, but their requested product/organization
pages still returned 403. G2, Macy's and Home Depot also remained failures.
All six returned session capabilities were reused on the same owner, then
explicitly deleted with HTTP 204. No cookie values or capabilities are published.
The experiment made eighteen browser-service scrapes for twelve target records.
Extra requests/time and retained-tab consent behavior differ, so this is not
a cookie-only experiment. It does not justify a blanket homepage warm-up.

The [alternative-probe receipt](../apps/playwright-service-ts/benchmarks/no-proxy-alternatives-results-2026-11-03.json)
records ninety-six scored target observations and hashes for 102 RPC payloads,
including six homepage responses and the six follow-up HTTP-400 driver probes
described below. Complete runs retained valid timing and ended
healthy with zero page/session counts; all created containers were removed.
These selected negative results narrow the remaining work without relabeling
the earlier full API rate or claiming that all software-only approaches are
exhausted. A fresh actual hosted comparison is recorded separately below.

## Refreshed actual hosted comparison before the HTTP-400 repair

The unchanged `da4bb50c9` fork API (browser image/source `02f47b315`) was compared
again with the actual hosted API on all 100 frozen targets, one request per
profile. The fork explicitly enabled engine fallback. Four global workers,
two slots per profile and seven-second per-profile dispatch pacing bounded
the 200 requests. Both profiles requested fresh rawHTML/Markdown with no
expected marker; the fork used direct VN egress and no upstream proxy.
Hosted routing, resources and internal attempts remained provider controlled.

| Full API outcomes, 100 targets/profile | Fork with fallback | Hosted |
| --- | --- | --- |
| Raw substring | 55 | 81 |
| Screened marker | 53 | 80 |
| Normalized marker | 54 | 81 |
| Screened-success p50 | 2,967 ms | 5,663 ms |
| Screened-success p95 | 6,013 ms | 14,565 ms |

There were 44 common matches, 37 hosted-only, ten fork-only and nine matching
neither. Ten explicit hosted unsupported-site responses remain failures in
the original denominator. No API-level HTTP 429 occurred; target-page rate
limits remain separate failures. Among hosted-only cases the fork had fifteen
recognized verification pages, thirteen other HTTP 403 responses, three target
rate limits, one each of target HTTP 400/405/406, one network error, one timeout
and one missing marker. AllMenus explicitly reported regional unavailability.
These are observed outcomes, not proof that one cause explains every denial.

Owner logs account for 100 original fork calls and 49 alternate calls. Four
fork API errors lacked returned fallback diagnostics. Of nine reported backend
recoveries, seven matched the frozen normalized marker. For the 44 common
matches, fork p50/p95 was 2,967/5,954 ms versus hosted 5,155/14,565 ms. Different
infrastructure and the selected successful cohort prevent a causal speed claim.

The hosted account balance decreased by 116 credits; 86 responses reported
115 credits in total. Missing per-request credits are unknown. Balance changes
can include other account activity and are not an exact invoice for this run.
Only 100 hosted requests were dispatched, with no client retry. The temporary
key and private directory were removed, and retained artifacts passed credential
redaction checks.

All 200 payload/content hashes, scores, source pins and lifecycle bounds
replayed. Timing was valid and overlap stayed within four globally/two per
profile. Peak sampled fork memory was 907/719/2,032 MiB, with zero memory/PID
limit or OOM events; the separate Firefox socket-throttling counter reached 288.
Owners ended healthy with zero page/session counts, were removed after logs
were preserved, and test infrastructure stopped.

The earlier 56/100 fork-only measurement used a different live epoch and
per-profile pacing. This unchanged code matched 54/100 here: WSJ, eBay, Google
Search and Zoopla lost matches, while Verizon and Apartments.com added them.
The difference does not establish a code regression. The [fresh comparison
receipt](../apps/playwright-service-ts/benchmarks/current-hosted-api-results-2026-11-03.json)
keeps this measurement distinct from the older 42/100 versus 80/100 comparison.
The current self-hosted coverage gap remained substantial.

## Opt-in recovery of a completed target HTTP 400

The fresh hosted comparison supplied a new actionable case: lululemon matched
with hosted but the fork returned a small target JSON HTTP 400 (`GE401001`).
Its confirmed closed-page receipt was available, but HTTP 400 was not eligible
for the explicit alternate-engine policy. A separate three-engine probe returned
400 in Rebrowser and Patchright while Firefox retrieved the requested product
through its observed canonical catalog redirect. GitHub controls passed in all
three engines. No meaning is inferred from the undocumented vendor error code.

API source `ffcb8b45e` adds target HTTP 400 to the opted-in eligibility set.
The existing same-deadline, single distinct alternate, original-URL, owner-boot
and page-closure guards remain. Browser-service request-validation errors stay
terminal; a failed alternate preserves the known primary failure. Sessions,
interactive actions and internal retries still cannot be combined with this
policy. Browser code, image and API/SDK control fields did not change.

The new full API fixture failed before the change by returning 400 instead of
the expected recovery. It then passed six modes: target-400 recovery, opt-out,
unclosed page, wrong boot identity, browser-service validation rejection and a
failed alternate. This is one Vitest test with controlled HTTP browser-protocol
fixtures through the API/queue/worker path, distinct from real browsers.
Twenty-seven focused API client/contract checks passed. [Browser CI](https://github.com/toreleon/firecrawl/actions/runs/41680717955)
passed 60 helpers, 97 integration checks, build and dependency audit on the new
commit. Broader server/SDK CI is not reported as passed.

### Five-round real API lululemon comparison

The current API made five fresh requests per policy on the original frozen URL.
Two global workers, one slot per profile, one-second pacing, the unchanged
Linux ARM64 browser image, 2 CPUs/3 GiB/two page slots per owner, consent
rejection and automatic workflows were retained. No marker or proxy was supplied.

Without fallback, all five captures returned target 400 and failed the marker.
With fallback, all five matched after confirmed closed-page Chromium 400 results
and Firefox 200 responses. All original backend requests used the original URL;
the observed canonical product destination and body marker were checked. Logs
account for ten primary and five alternate calls. Adaptive successful p50/p95
was 4,408/4,707 ms; baseline successful latency is undefined because none matched.
This improves selected retrieval at an explicit extra browser cost.

All ten records, hashes, scores and lifecycle bounds replayed. Peak sampled
memory was 460/428/1,227 MiB, with zero memory/PID-limit and OOM events. Owners
ended healthy with zero page/session counts and were removed after preserving
logs. The [targeted API receipt](../apps/playwright-service-ts/benchmarks/target400-lululemon-api-results-2026-11-04.json)
distinguishes this real-browser result from the controlled protocol fixture.
This selected policy comparison does not establish an all-target code-version
gain, extraction F1 or hosted parity.

### Full API result after target-400 eligibility

The same API source completed a fresh 200-request deployment on all 100 frozen
targets, one request per policy per target. Four global workers/two per profile,
the unchanged browser image and owner resources, direct VN egress, fresh
rawHTML/Markdown and no marker hint were retained. No hosted calls were made.

| All 100 targets, one request/profile | Without fallback | With fallback |
| --- | --- | --- |
| Raw substring | 48 | 59 |
| Screened marker | 46 | 57 |
| Normalized marker | 47 | 58 |
| Screened-success p50 | 3,360 ms | 3,522 ms |
| Screened-success p95 | 7,114 ms | 7,527 ms |
| Additional Firefox calls | 0 | 49 |

All 47 baseline matches also matched in the adaptive profile. Eleven targets
were adaptive-only and 42 matched neither. Ten adaptive-only matches used
confirmed alternate recovery; Expedia succeeded in primary Chromium. Eleven
reported backend recoveries produced ten frozen-marker matches. Two API errors
lacked returned fallback diagnostics. Logs account for 200 primary and 49
alternate calls, with no alternate target repeated. Common-success p50 was
3,360→3,218 ms and p95 7,114→6,061 ms; this selected live cohort does not
establish a stable latency improvement.

Lululemon returned 400 in the baseline and matched after alternate recovery
(760/4,701 ms). Compared with the preceding, differently paced 54/100 fork run,
lululemon, eBay, Google Search and Zoopla added matches. The current 58/100 does
not establish a causal four-point code-version gain. The five-round real API
comparison supplies direct evidence for the repaired target-400 eligibility.

All 200 records, payload/content hashes, summaries, source pins and lifecycle
bounds replayed; timing was valid and overlap stayed within four globally/two
per profile. Peak sampled memory was 1,052/1,047/2,150 MiB. Memory/PID-limit and
OOM events were zero; Firefox's separate socket-throttling counter reached 526.
All owners ended healthy with zero page/session counts and were removed after
logs were preserved; test infrastructure stopped. The [full API receipt](../apps/playwright-service-ts/benchmarks/target400-full-api-results-2026-11-04.json)
keeps its current API source distinct from the unchanged browser image and
the pre-repair 54/100 versus 81/100 actual hosted comparison. No further hosted
calls were made after that comparison; current hosted parity is unproven.

The [cleanup receipt](../apps/playwright-service-ts/benchmarks/target400-cleanup-results-2026-11-04.json)
verifies removal of nineteen browser containers across this investigation and
its API measurements. Docker image usage remains 28.92 GB; no browser image
rebuild was needed for the API-only fix. Nine unrelated running services and
all data volumes were preserved. The temporary hosted key/directory were
deleted and retained artifacts passed credential-redaction checks.

## Stateless alternate-owner capacity and bounded scaling (November 4)

Source `c65d3df2ff0b6a13c2b4d5c4fd09f75271059463` fixes a separate capacity
problem: alternate health discovery always began with the first configured
owner, so a healthy first owner received every fallback request. The API now
rotates the starting candidate independently in each process. Discovery still
skips unhealthy or ineligible owners and requires a different engine and boot
identity. There is still at most one alternate dispatch within the original
deadline. A failed or lost alternate response never tries a third owner, and
retained sessions keep their original owner. This is per-process distribution;
it does not implement distributed capacity admission.

### Controlled API capacity model

A real API/queue/worker test supplied a primary 403 fixture and two HTTP browser
protocol fixtures, each modeling one alternate page slot with 400 ms of work.
The same eight-job test was run before and after the fix:

| Controlled model, eight concurrent API jobs | Before | After |
| --- | --- | --- |
| Successful API responses | 8 | 8 |
| Alternate calls by owner | 8 / 0 | 4 / 4 |
| Maximum simultaneous alternate owners | 1 | 2 |
| Batch elapsed | 3,258 ms | 1,654 ms |

The failure-first test correctly failed its distribution assertion; its separate
lost-response case passed. After the fix, both API cases passed, including proof
that a lost alternate response makes only one alternate dispatch. The production
API build and 29 focused client/contract checks passed. [Browser CI](https://github.com/toreleon/firecrawl/actions/runs/41686748267)
passed 60 helper checks, 97 integration checks, build and production dependency
audit on this source. Broader server/SDK CI was queued when checked. The capacity
model establishes functional concurrency on controlled protocol fixtures; its
timings do not establish public-site throughput or coverage improvements.

### Two independently launched Firefox owners

The unchanged Linux ARM64 browser image was tested on eight selected remaining
failures and recovery controls, two rounds each, against Chromium and two Firefox
owners. Each had one active test request, 2 CPUs/3 GiB, fresh contexts, no proxy,
automatic workflows and recognized consent rejection. No expected marker was sent.

The first run stopped at 27 of 48 observations because its guard treated any
`memory.events:max` increment as fatal. That owner recorded 131 boundary events
and zero OOM events; all three containers were removed. Its 27 completed payloads
and scores replayed, but it remains a partial run. Kernel documentation
distinguishes memory-boundary reclaim pressure from allocation failure and OOM
kills. A separate run retained pressure counters and stopped on allocation/OOM
or PID-limit failures instead. [Linux cgroup v2 documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)

The separate run completed and replayed all 48 observations with valid timing.
Chromium matched 3/16; each Firefox owner matched 7/16. Capterra, SeatGeek and
GitHub matched in both Firefox rounds; Google Search varied between owners and
rounds. Lowe's, Louis Vuitton, WSJ and StockX failed in both rounds on all owners.
Generated browser identity and live-site timing were not isolated, so no causal
fingerprint or added-owner coverage gain is inferred. Peak sampled memory was
702/2,196/1,388 MiB. Memory-boundary, OOM and PID-limit counters were zero in this
completed run; socket-throttling counters were separately 478/791/95. Owners
ended healthy with zero pages/sessions and were removed after logs were saved.
The [pool probe receipt](../apps/playwright-service-ts/benchmarks/fallback-pool-probes-results-2026-11-04.json)
contains the controlled model and both browser runs without combining their rates.

### Eight-worker resource failure

A subsequent full API run configured eight global HTTP workers/four per policy,
two primary owners with 2 page slots/1.5 GiB each and two alternate owners with
1 page slot/1.75 GiB each. The aggregate browser memory cap was 6.5 GiB inside the
7.75-GiB Docker VM. This allocation proved insufficient for a primary owner:
it recorded 18 OOM events and three OOM kills, and Docker reported `OOMKilled`.
The guard stopped the run after 172 of 200 responses. All 172 completed payload
hashes and scores replayed offline, but this is not a completed benchmark rate
or a valid speed comparison. All four browser containers were removed and the
three task infrastructure services stopped. This failure is distinct from the
earlier pressure-only probe.

A fresh run reduced concurrency to four global HTTP workers/two per policy and
used one 2.5-GiB primary owner with two page slots plus two 2-GiB alternate owners
with one slot each. Its aggregate browser cap remained 6.5 GiB. The different
topology and memory allocations prevent an equal-resource speed claim against
earlier deployments. No hosted calls or proxy rerouting were used.

### Completed four-worker API rerun

The bounded deployment completed all 200 requests and replayed every payload
hash, score, summary and lifecycle bound. Timing was valid, with at most four
HTTP requests globally and two per profile.

| All 100 targets, one request/profile | Without fallback | With fallback |
| --- | --- | --- |
| Raw substring | 48 | 56 |
| Screened marker | 46 | 54 |
| Normalized marker | 47 | 55 |
| Screened-success p50 | 4,873 ms | 4,939 ms |
| Screened-success p95 | 9,378 ms | 10,102 ms |
| Additional Firefox calls | 0 | 49 |

All 47 baseline matches also matched with fallback; eight were adaptive-only
and 45 matched neither. Logs account for 200 primary and 49 alternate calls,
distributed 24/25 across the Firefox owners, with no original target dispatched
more than once to an alternate. Returned diagnostics reported nine recoveries,
all nine matching the frozen marker; eight were adaptive-only. Five API errors
lacked fallback diagnostics and remain unknown in that returned-metadata ledger.
Common-success p50 was 4,873/4,393 ms and p95 9,378/10,102 ms; this run does not
establish a stable latency improvement.

Relative to the preceding 58/100 deployment, eBay no longer matched because the
API returned `CONTENT_NOT_READY` with no usable rendered text; Google Search
returned verification/rate-limit 429, including on its alternate receipt; and
Apartments.com returned 403 on both engines. No new adaptive matches were added.
These observations explain the three lost matches in this sample. Changed live
timing, browser identities, owner topology and memory budgets prevent assigning
them causally to the pool-routing code.

Peak sampled memory was 1,324/2,044/1,371 MiB. The first Firefox owner recorded
3,178 memory-boundary events; allocation/OOM, OOM-kill and PID-limit counters
remained zero for every owner. Pressure therefore remains an operational limit,
even though this deployment completed. Owners ended healthy with zero active
pages/sessions and were removed after evidence was saved. The
[full API receipt](../apps/playwright-service-ts/benchmarks/fallback-pool-full-api-results-2026-11-04.json)
also retains the separate 172-record OOM stop. The last actual hosted result is
still 81/100 from its earlier source-pinned comparison; it was not refreshed for
this source. Hosted parity and an added-owner coverage gain remain unproven.

### Scoped Docker cleanup

Across these four browser deployments, thirteen task browser containers were
removed and three task infrastructure containers stopped. Three unreferenced
historical benchmark image tags were removed; the current image and raw evidence
were retained. Sixty-five reclaimable cache records were traced to the exclusive
eight Firecrawl browser-build window and pruned by exact IDs. Docker's reported
build cache fell from 5.29 GB to zero; this is not an independently measured
physical-byte saving. Image accounting remains 28.92 GB. Host free space was
126 GiB at final inspection.

Nine unrelated services remained running, all 114 data volumes were retained,
and no global prune was used. The [cleanup receipt](../apps/playwright-service-ts/benchmarks/fallback-pool-cleanup-results-2026-11-04.json)
records these checks. No browser image rebuild or hosted credential was needed
for this API-only routing change.

## Optional initial-navigation deadline (November 4)

The next investigation separated access failures from document-readiness
failures. The previous full-run captures show an explicit Allmenus location
rejection and a Temu discontinued-item page. Neither was promoted into a marker
success. Sixteen fresh browser observations tested eBay at five- and fifteen-second
automatic readiness budgets, three transport failures and a GitHub control,
using two workers, one per engine, direct VN egress and no expected-text hint.
Firefox retrieved eBay in all four observations; Chromium returned 403 in all
four. Increasing readiness added no match. Saks returned Chromium 403 and a
Firefox pre-commit reset; Neiman Marcus returned 403 on both; LinkedIn failed
before a document committed on both. GitHub matched on both engines. The earlier
eBay empty-content failure was not reproduced, so no longer default wait or
extra transport retry was added. All sixteen hashes/scores replayed and the two
containers were removed after healthy zero-page/session checks.

The previous full run also exposed a separate capacity problem: one DraftKings
response spent 83,327 ms in the browser service, but its recorded attempt took
only 704 ms. Its remaining attempt budget was 1,848 ms. Service duration includes
queuing and setup, so this is evidence of substantial time outside the actual
attempt; it is not evidence that the target navigation itself needed 83 seconds.
Two Roblox navigations in that run consumed almost the full 85-second API budget.
Long initial navigations can therefore hold scarce page slots while later jobs
use up their request deadline waiting.

Implementation `f8d479fa709917cd6fec09049f6b4197ab24ea21` adds opt-in
`browserControls.navigationTimeout` (100–120,000 ms). It caps the initial
navigation, bounded by the existing overall deadline, while preserving the
remaining consent, readiness, post-load and workflow budgets. Omitting it keeps
the prior behavior. This follows Playwright's separate
[navigation timeout contract](https://playwright.dev/docs/api/class-page#page-goto-option-timeout);
a short caller-selected cap can reject a legitimately slow document. Both
explicitly selected engines receive the cap, and a confirmed closed-page primary
timeout can leave time for the existing one alternate attempt. No global default
deadline split, extra attempt, or CAPTCHA answer handling was added.

The control passes through scrape/batch/crawl options, the existing queue/worker
path, retained-session creation/continuation and JS/Python SDK serialization.
Owners advertise a dedicated capability flag. Unsupported stateless owners are
skipped before dispatch; retained requests validate support and boot identity.
An old owner cannot silently ignore the requested cap. The frozen grader and
challenge classifier remain unchanged.

Before implementation, a delayed fixture returned 200 despite its requested cap,
and invalid cap values were accepted. The new test initially expected HTTP 408;
it was corrected to the existing service's HTTP 500 plus `SCRAPE_TIMEOUT`
contract. Production error-status mapping was preserved. After implementation,
the API build and 32 focused client/contract checks passed. Five JS request checks,
the JS SDK build and sixteen Python request checks passed. Native Chromium passed
seven TAP checks; the Linux container passed thirteen TAP checks across Chromium
and Firefox, including five functional cases per engine. These nested TAP totals
are not counts of distinct public sites.

Three full API tests passed with real native Chromium and Linux Firefox owners
against local HTTP fixtures. They cover a closed primary phase timeout recovered
by one alternate, post-commit hydration longer than the navigation cap, omitted
caps preserving the prior budget, invalid values rejected before target access,
and retained-session continuation followed by HTTP 204 deletion. Eight unrelated
API cases were skipped in this focused invocation. The harness recorded its
then-uncommitted implementation; retained source hashes were subsequently checked
against `f8d479fa7`. This is separate from the later source-pinned public-site run.
The [verification receipt](../apps/playwright-service-ts/benchmarks/navigation-timeout-verification-results-2026-11-04.json)
contains those checks and the sixteen pre-change browser observations.

### Full API measurement with explicit 30-second navigation caps

The current source completed 200 fresh requests on the frozen 100 targets,
without proxies or hosted calls. Four global HTTP workers/two per policy used
the same one-primary/two-alternate topology, page limits and 6.5-GiB aggregate
memory cap as the preceding completed deployment. Both policies explicitly used
`navigationTimeout: 30000`; the overall API timeout remained 85 seconds and the
client deadline 90 seconds. The browser image adds the tested control to the
existing pinned bundle without downloading browsers again.

| All 100 targets, one request/profile | Without fallback | With fallback |
| --- | --- | --- |
| Raw substring | 46 | 56 |
| Screened marker | 45 | 54 |
| Normalized marker | 46 | 55 |
| Screened-success p50 | 5,388 ms | 4,748 ms |
| Screened-success p95 | 9,607 ms | 10,792 ms |
| Additional Firefox calls | 0 | 53 |

All 46 baseline matches also matched with fallback; nine were adaptive-only and
45 matched neither. Owner logs account for 200 primary calls and 53 alternates,
split 27/26, with no target dispatched to an alternate more than once. Returned
diagnostics reported eleven recoveries, ten matching the frozen marker. Four API
errors lacked returned fallback diagnostics and remain unknown in that metadata
ledger. Backend recovery and expected-marker success remain separate measures.

The adaptive normalized total remains 55/100. Apartments.com added a match while
Verizon lost one after target 417. This is a different fresh sample and policy,
not evidence that navigation timeouts improved site access. The overall two-policy
run took 337.860 seconds versus 354.818 seconds previously. Adaptive all-request
p99 was 30,237 ms versus 83,338 ms, and maximum was 60,981 versus 84,565 ms.
Roblox still failed, now after 60,981 ms; DraftKings still returned 403, now after
30,237 ms rather than 83,338 ms. The adaptive screened-success p95 increased from
10,102 to 10,792 ms. These mixed observations do not establish a general throughput
or latency gain. Source, request policy, browser identities and live timing differ.

All 200 payload hashes, scores, summaries and lifecycle bounds replayed; timing
was valid. Peak sampled memory was 1,025/1,318/1,199 MiB. Memory-boundary, OOM,
OOM-kill and PID-limit counters were zero for every owner; separate Firefox
socket-throttling counters were 162/194. All owners ended healthy with zero
pages/sessions and were removed. [Browser CI](https://github.com/toreleon/firecrawl/actions/runs/41692590578)
passed 60 helper checks, 110 integration checks, build and production dependency
audit on implementation `f8d479fa7`; broader server/SDK CI is not claimed as passed.
The [full API receipt](../apps/playwright-service-ts/benchmarks/navigation-timeout-full-api-results-2026-11-04.json)
retains the source/image pins and the qualified preceding-deployment comparison.
The last actual hosted result remains the earlier source-pinned 81/100; hosted
was not refreshed and parity remains unproven.

### Cleanup after navigation-timeout experiments

Seven task browser containers were removed, including both selected-triage
owners, the dual-engine integration container, the API harness's Firefox owner
and the three full-benchmark owners. Three task infrastructure services stopped;
nine unrelated services and all 114 volumes were preserved. Exact-ID cache
cleanup removed four unshared records, with Docker reporting 453.6 kB. Fifty-nine
records shared with retained images remain (2.132 GB reported cache, 0 B reported
reclaimable); the current image and its pinned base remain available. Image
accounting remains 28.92 GB and host free space was 126 GiB. No global prune was
used. The [cleanup receipt](../apps/playwright-service-ts/benchmarks/navigation-timeout-cleanup-results-2026-11-04.json)
preserves preflight inventories and actual prune results without claiming all
shared cache was deleted or independently measuring physical bytes freed.

## Driver, request-interception and consent-policy experiments (November 4)

The next investigation kept production source unchanged at the contents of
`f93fbdb601d0974d64e3ea2095dfedc645f45a31` and tested three remaining browser
hypotheses. No hosted calls or upstream proxies were used. The maximum HTTP
concurrency was two, below the user's ceiling of eight. The [combined receipt](../apps/playwright-service-ts/benchmarks/driver-policy-experiments-results-2026-11-04.json)
retains all 76 completed observations, replayed hashes/scores, request/context
completion receipts, configurations and resource samples.

### Pydoll on the same Chromium binary

[Pydoll](https://github.com/autoscrape-labs/pydoll) offers a direct CDP controller
and a Python Playwright-compatible API. The experiment pinned the published
`pydoll-python==3.0.0` wheel, SHA-256
`9a78c597cdb5de2db17c6646253c97d74a705d5571231a3cc529b1d5fcc85435`,
and verified its included MIT license. The [published package metadata](https://pypi.org/pypi/pydoll-python/3.0.0/json)
and [upstream setup documentation](https://pydoll.tech/docs/getting-started/)
were consulted before inspecting the installed implementation.

Two experimental HTTP owners ran Rebrowser and Pydoll against the identical
Chromium executable hash/version in the same Linux ARM64 image, headful display,
2 CPUs/3 GiB per owner, one request per owner, fresh contexts and direct VN
egress. Both used the existing pinned-DNS filtering proxy, the same DOM capture
function and runtime protection classifier, and a five-second post-load delay.
The prototype deliberately allowed service workers and advertising on both
profiles and performed no consent or workflow actions. Its launch arguments
were captured; this compares driver/launcher bundles, not one isolated CDP call.

| Eight selected targets, two rounds each | Rebrowser | Pydoll |
| --- | --- | --- |
| Frozen normalized HTML marker matches | 5/16 | 5/16 |
| Exclusive matches | 0 | 0 |
| GitHub and arXiv controls | 4/4 | 4/4 |

Both retrieved Lowe's only in round one and failed it in round two. The complete
frozen expected phrase appeared in HTML but not captured rendered body text;
the displayed product heading was shorter. That supplementary distinction does
not change the frozen grader. StockX, WSJ, G2, Neiman Marcus and LinkedIn added no
match. Two Pydoll G2 captures encountered a 403 navigation but could not establish
a stable capture URL; those remain adapter errors, not a different inferred WAF
rule. There is no demonstrated selected-site coverage benefit from the new driver.

The inspected Pydoll compatibility context accepts `service_workers` without
implementing blocking. Other production consent, workflow, session and fencing
contracts were not ported into this prototype. It therefore cannot replace the
production worker on these results. Both owners passed a real browser loopback
navigation denial through the existing proxy. Peak sampled memory was 633/979
MiB, all observed memory-boundary/OOM/PID and socket-throttling counters were zero,
and both containers were removed. Prototype health counts active commands rather
than every browser tab; per-request context-close receipts and container removal
are recorded separately.

### Proxy scope and guarded interception

The transient Lowe's result prompted a separate two-by-two Rebrowser experiment.
It varied browser-global versus per-context filtering proxy configuration and
guarded request interception versus no interception. The proxy continued to
reject private addresses in every cell. Service workers were blocked in every
cell; advertising and consent automation were off. Four Lowe's rounds per cell
used counterbalanced interception order, followed by one GitHub control per cell.
Two owners shared the same Chromium binary/version and used one request each.

| Rebrowser configuration | Lowe's | GitHub control |
| --- | --- | --- |
| Global proxy, guarded interception | 0/4 | 1/1 |
| Global proxy, no interception | 0/4 | 1/1 |
| Context proxy, guarded interception | 0/4 | 1/1 |
| Context proxy, no interception | 0/4 | 1/1 |

All twenty completed observations replayed with valid timing. No cell established
a recovery, so the experiment does not justify removing the production guard or
changing proxy scope. The earlier runner had a string-quoting parse error before
any scored target request; that zero-record attempt and its two-container cleanup
remain separate from the corrected twenty-record measurement. Both corrected
owners passed loopback-denial controls, peaked at 560/565 MiB, recorded zero
memory/PID-limit and socket events, and were removed after evidence was saved.

### Consent bridge enabled versus disabled

Production installs the consent bridge before navigation when a consent policy
is enabled. To test whether that accounted for the remaining failures, the
unchanged production Rebrowser service compared `consent: "off"` with
`"rejectNonEssential"`. Two rounds on Lowe's, StockX, WSJ, G2, Neiman Marcus and
GitHub used fresh contexts, automatic readiness, no fixed wait and one request
per policy, sharing a two-page owner capped at 2 CPUs/3 GiB.

Each policy matched 2/12, all GitHub controls. None of the five persistent failures
recovered. All twenty-four hashes/scores replayed with valid timing; the owner
peaked at 569 MiB with zero memory-boundary/OOM/PID or socket events. This result
does not justify disabling consent handling or changing its injection lifecycle.
The production driver, guarded routing and consent defaults remain unchanged.

### Cleanup and remaining gap

Seven browser containers were removed across these experiments, including the
unscored bootstrap attempt. The two remaining prototype images were removed;
two superseded prototype build outputs were already absent. Twenty exact task
cache records were pruned, with Docker reporting 143 MB. The baseline production
and unrelated image IDs were restored, including the current browser image and
its pinned base. Image accounting returned to 28.92 GB. Fifty-nine baseline
image-shared cache records remain, with 0 B reported reclaimable cache.

Nine unrelated services and all 114 volumes were preserved; the three task
infrastructure services remained stopped. No global prune was used. The
[cleanup receipt](../apps/playwright-service-ts/benchmarks/driver-policy-cleanup-results-2026-11-04.json)
retains image/build-cache preflights, actual removals and volume inventories.

These are selected browser experiments, not a new full API result. The latest
source-pinned full run remains 55/100 with fallback, and the earlier hosted
comparison remains 81/100 on its own source and deployment. Parity is unproven.
The next experiment investigates the HTTP fetch engine, which uses Undici.
It must preserve redirect/private-address checks and requested browser-control
semantics; a static HTTP response cannot satisfy browser controls.

## HTTP headers, HTTP/2 and TLS transport experiment (November 4)

The [transport receipt](../apps/playwright-service-ts/benchmarks/http-transport-experiments-results-2026-11-04.json)
records 56 static HTTP observations: four profiles on twelve selected persistent
failures plus GitHub/arXiv controls. This is a one-round diagnostic, not a new
full API benchmark. Source remained at `1aa610f1d8cc6d8ea4bccd270168470961ea3cb9`,
with production implementation from `f8d479fa709917cd6fec09049f6b4197ab24ea21`.

[curl_cffi supports a pinned Chrome 152 profile](https://curl-cffi.readthedocs.io/en/latest/impersonate/targets.html).
The experiment used the Linux ARM64 `curl_cffi==0.17.0` wheel, SHA-256
`aa91d26234516ddb9eb97310d5fe1705aa6f677f101d57ffdb76d5f75439506e`,
and Undici 7.30.1 on Node 24.16.0. Browser-style header values were obtained from
that packaged curl profile and explicitly supplied to all three browser-header
profiles. The default Undici profile retained its own default headers.

| Static HTTP profile | Diagnostic HTTP protocol | Normalized matches | Failed targets recovered |
| --- | --- | --- | --- |
| Undici, default headers | HTTP/1.1 | 2/14 | 0/12 |
| Undici, browser headers | HTTP/1.1 | 2/14 | 0/12 |
| Undici, browser headers, H2 enabled | HTTP/2 | 2/14 | 0/12 |
| curl_cffi, Chrome 152, same explicit headers | HTTP/2 | 2/14 | 0/12 |

All eight GitHub/arXiv control observations passed. None of Lowe's, Safeway,
American Airlines, Macy's, Home Depot, Neiman Marcus, G2, StockX, WSJ, CarGurus,
LinkedIn or Crunchbase gained a normalized match. One default-Undici American
Airlines response matched the raw HTML phrase only in non-content markup; the
frozen normalized grader correctly remained a failure. Neiman Marcus and
LinkedIn had transport failures, so those observations do not establish a WAF
denial or identify its cause.

The diagnostic endpoint observed different TLS and HTTP/2 fingerprints for curl
and Undici, and confirmed the intended H1/H2 negotiation. All three Undici
profiles sent an empty Cookie header there; curl did not. Header ordering,
cookies, library and OS bundles therefore remain confounds: this compares client
bundles and does not isolate TLS as a cause. The sanitized diagnostic receipts
retain protocol/fingerprint/header names without the diagnostic endpoint's IP
fields. These differences produced no selected-site coverage gain.

Each logical request used a fresh client/cookie jar, one attempt, a shared
15-second deadline across redirects, an 8 MiB decoded-body cap, TLS verification,
and the same local pinned-DNS filtering proxy with direct VN egress. No upstream
proxy, JavaScript, consent actions, readiness workflow, retained session,
expected-text hint or hosted API call was used. Maximum concurrency was four,
one request per profile, below the user's limit of eight. Caller browser controls
were not exposed by this static prototype and production routing was not changed.

The [curl security guidance](https://curl-cffi.readthedocs.io/en/latest/security.html)
warns that unrestricted automatic redirects can reach private destinations.
This prototype followed redirects manually through the existing destination
filter. Every profile passed direct-private HTTP and public-to-private HTTP/HTTPS
negative controls, with zero connections reaching the owned private fixture.
The initial adapter attempt converted JSON header pairs incorrectly and stopped
at GitHub: its four control observations are excluded, with source/logs and its
container cleanup retained separately. The corrected run replayed all 56 hashes
and scores with valid timing. Peak sampled memory was 95 MiB, all observed
memory-boundary/OOM/PID counters were zero, and final active requests were zero.

No new transport dependency or default was adopted. The latest full API result
remains 55/100; the earlier actual hosted result remains 81/100 on its own source
and deployment. Neither was rerun by this static experiment, and hosted parity
remains unproven.

Both HTTP lab containers and both prototype images were removed. Eighteen exact
task build-cache records were pruned, with Docker reporting 307.9 MB; physical
disk reclamation was not independently measured. The pre-existing image set,
59 shared cache records, nine unrelated running services and all 114 volumes
were preserved. The [cleanup receipt](../apps/playwright-service-ts/benchmarks/http-transport-cleanup-results-2026-11-04.json)
records inventories, exact removals and evidence hashes. No global prune was used.

## Parsed-document and rendered-body capture repair (November 4)

Inspection of the earlier eBay failure found a concrete capture issue. Firefox
could return a roughly 12 KB document whose product phrase was in metadata,
while its body contained only a bootstrap script. The browser service sometimes
called that ready; the API's Markdown quality check correctly rejected it.
The [diagnosis and verification receipt](../apps/playwright-service-ts/benchmarks/rendered-body-verification-results-2026-11-04.json)
keeps those measures separate instead of promoting metadata into product content.

A before-change follow-up kept the same page open after two captures. The
document was still `loading` in one immediate follow-up, then became
`interactive` with over 8,000 rendered characters roughly half a second later.
The initial diagnostic's bounded Docker log rotated before its first captures
were copied; that incomplete attempt is excluded. The corrected diagnostic
retains all three captures, twelve follow-ups and context-close events.

Mozilla documents that [`innerText` can fall back to `textContent` when an
element is not rendered](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/innerText),
and that [`readyState: loading` means the HTML parser is still working](https://developer.mozilla.org/en-US/docs/Web/API/Document/readyState).
Source `4c3e920a9c628285ba63f9a14d93cd03edfb1252` now prevents hidden/unrendered
body fallback text from satisfying body readiness. Automatic readiness also
waits for the current document to leave the parsing state, then evaluates the
existing rendered-body and busy-region conditions. The final capture rechecks
that state. Explicit body-text readiness uses the same rendered-text check;
title scope and visible `display: contents` children retain their contracts.

The existing five-second default readiness allowance, caller timeout, retries,
navigation cap and proxy policy are unchanged. A stream that remains open can
exhaust that allowance and return explicitly unready partial content. The fix
does not require `readyState: complete`, image completion or network idle.

### Matched Firefox capture experiment

Two headful Linux ARM64 Firefox owners used the same parent/browser bundle,
2 CPUs/3 GiB each, one page each, direct VN egress, fresh contexts, consent
rejection, automatic workflow, 30-second request/navigation deadlines and the
same five-second readiness budget. Five eBay rounds counterbalanced dispatch
order, followed by GitHub/arXiv controls. No expected phrase was sent to either
owner. All fourteen hashes and scores replayed.

| Five eBay observations per image | Before | Repaired |
| --- | --- | --- |
| Frozen normalized HTML marker matches | 3/5 | 5/5 |
| Exact phrase in captured rendered body text | 2/5 | 5/5 |
| GitHub/arXiv controls, two per image | 2/2 | 2/2 |

The two metrics differ because HTML title/metadata matches do not establish
rendered product content. The repaired captures took 5.1–5.7 seconds, including
the needed body load; prematurely returned before-change captures could finish
sooner. This selected experiment is not a general latency or WAF-vendor claim.
Peak sampled memory was 1,387/1,502 MiB; memory-boundary/OOM/PID and socket event
counters were zero, and both owners ended with zero pages/sessions.

Three functional regressions failed before the fix: streaming navigation,
hidden-body hydration and a permanently hidden script-only body. After repair,
the native browser suite passed twelve checks and the Linux Chromium/Firefox
suite passed ten. Three real API/queue/browser cases passed, with nine unrelated
cases skipped: streamed/hidden-body success and script-only failure, existing
unresolved-busy partial content, and explicit readiness forwarding. Tested file
hashes match the committed candidate. [Browser CI](https://github.com/toreleon/firecrawl/actions/runs/41705531222)
passed build, 60 helper checks, 115 integration checks and the production
dependency audit on this source. Broader server/SDK jobs remained queued.

### Full API rerun and loss inspection

The [full API receipt](../apps/playwright-service-ts/benchmarks/rendered-body-full-api-results-2026-11-04.json)
records 200 fresh API requests on the unchanged 100-target fixture: baseline
without alternate-engine recovery and adaptive with it. Both explicitly capped
initial navigation at 30 seconds. Four global HTTP workers/two per policy used
one Chromium primary and two Firefox alternates with the prior 6.5 GiB aggregate
browser limit. No upstream proxy or hosted API call was used.

| Current full API outcomes, 100 targets/policy | Baseline | Adaptive |
| --- | --- | --- |
| Raw HTML substring matches | 46 | 56 |
| Screened matches | 44 | 54 |
| Normalized matches | 45 | 55 |

All 45 baseline normalized matches also matched with fallback; ten were
adaptive-only and 45 matched neither. All 200 payload/hash/score records replayed
with valid timing and concurrency bounds. Logs account for 200 primary calls
and 51 alternate calls, split 25/26, with no alternate URL repeated. eBay
returned HTTP 200 and matching Markdown in both policies; the adaptive capture
contained 28,869 Markdown characters and an `interactive`, ready document.

Adaptive coverage stayed at 55/100 versus the preceding navigation-cap run.
eBay and Reddit gained matches; Amazon and Zoopla lost them. The Amazon alternate
returned a continuation/verification form, already `interactive`, instead of the
requested product. Zoopla returned Cloudflare HTTP 403 documents on both engines;
its primary did not enter automatic readiness. These observed failures were not
parser-budget expirations. The source and live epoch differ, so the aggregate
changes do not isolate a code effect or establish a stable gain.

The subsequent visibility review below found the Cloudflare success label in a
hidden template. Its presence in HTML/Markdown did not establish clearance.

The two-policy run took 352.3 seconds versus 337.9 previously. Peak sampled
memory was 1,316/1,137/1,380 MiB, with zero memory-boundary/OOM/PID-limit events.
One Firefox owner recorded 147 socket-throttling events, separately from OOM.
All owners ended healthy with zero pages/sessions. The latest source has a
verified capture repair, but overall coverage remains below the earlier actual
hosted 81/100 result; hosted was not refreshed and parity remains unproven.

### Cleanup

Nine task containers were removed across diagnostics, tests and benchmarks;
the three task infrastructure services were stopped. Eight exact new build-cache
records were pruned, with Docker reporting 626.8 kB. The small verified production
candidate and its pinned bases were retained. Image accounting remained 28.92 GB;
59 baseline cache records remain with zero reclaimable bytes. Nine unrelated
running services and all 114 volume names were preserved. The [cleanup receipt](../apps/playwright-service-ts/benchmarks/rendered-body-cleanup-results-2026-11-04.json)
retains inventories and actual stop/removal results, including expected SIGTERM
exit 143 for explicitly stopped serving owners. No global prune was used.

## Cloudflare visibility, time-zone and native-platform experiments (November 4)

Production implementation stayed at `4c3e920a9`; source/evidence parent was
`91a817350`. The [combined receipt](../apps/playwright-service-ts/benchmarks/profile-platform-experiments-results-2026-11-04.json)
records 106 fresh browser-service requests plus a separate four-visit same-tab
observation. These selected experiments produced no deployment change or new
full API result. All frozen graders, original denominators and expected-text
isolation were preserved. No upstream proxies or hosted calls were used.

### A hidden success message is not clearance

The saved Zoopla HTTP 403 page contained a verification-success label inside
`display: none` markup. Treating that template string as a completed verification
would be incorrect. Cloudflare's [challenge overview](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/)
distinguishes JavaScript-only processing from managed/interactive escalation;
its [troubleshooting guidance](https://developers.cloudflare.com/cloudflare-challenges/troubleshooting/challenge-solve-issues/)
also warns that individual challenge-resource responses are not sufficient to
identify a blocking cause.

Two existing headful browser engines visited Zoopla and GitHub in fresh contexts
and kept each tab open for follow-ups at approximately zero, one, five and ten
seconds after capture. Chromium retrieved Zoopla immediately and stayed allowed.
Firefox stayed on HTTP 403 after more than ten seconds; the success label remained
hidden. Its challenge resources returned HTTP 200, so resource-download success
did not establish destination access. No click, answer, reload or cookie transfer
was performed. Both GitHub controls passed.

The receipt scores four initial and four final direct renderer captures, sharing
four document visits; these are not eight independent fresh requests or API
responses. Sixteen follow-ups retain status, visibility and content hashes.
Missing/blank frame controls do not prove a challenge is noninteractive. No
blanket Cloudflare wait was added: this observation established no delayed
recovery and corrected the earlier inference from hidden template text.

### Process/browser time-zone comparison

The default Linux browser reported UTC despite direct VN egress. An owned blank
page probe verified that `TZ=Asia/Ho_Chi_Minh` changes both main-thread and Web
Worker offsets from zero to -420 minutes in Chromium and Firefox. Chromium used
the equivalent `Asia/Saigon` alias. Camoufox documents [GeoIP/time-zone configuration](https://camoufox.com/python/geoip/),
but this experiment used the OS `TZ` setting with the existing `geoip: false`
deployment; no location API, locale change or external target was needed for
the four initial blank-page probes.

Each engine then compared UTC and Vietnam time on the same image, direct egress,
controls and request budgets, with two rounds over eight selected targets.
Owners verified main/worker offsets before serving requests. Fresh contexts,
one page per owner, 2 CPUs/3 GiB per owner and two global workers were used.

| Selected normalized matches, sixteen observations/profile | UTC | Vietnam time |
| --- | --- | --- |
| Chromium | 7/16 | 6/16 |
| Firefox | 5/16 | 4/16 |

GitHub/arXiv controls passed in both rounds for every profile. The Vietnam-time
profile added no match. UTC's extra matches were intermittent Amazon retrievals;
this does not establish that UTC is universally preferable or that time zone
caused any particular denial. All 64 payload hashes and scores replayed with
valid timing. The production time-zone setting remains unchanged.

### Native macOS Chromium and Google Chrome

The next comparison used the same Rebrowser 1.64.101 driver and scrape source
across Linux ARM64 bundled Chromium 156.0.8078.4, native macOS ARM64 bundled
Chromium at that version, and installed Google Chrome 156.0.8078.80. All were
headful and used the same public egress IP, existing destination filter, fresh
contexts, consent/workflow controls and 30-second request/navigation budgets.
The two native workers used fresh temporary user-data directories; personal
browser profiles were not loaded.

| Fourteen selected targets, one observation/profile | Container Chromium | Native Chromium | Native Google Chrome |
| --- | --- | --- | --- |
| Normalized matches | 5/14 | 4/14 | 4/14 |
| GitHub/arXiv controls | 2/2 | 2/2 | 2/2 |
| Exclusive native matches | — | 0 | 0 |

All profiles retrieved Zoopla and Amazon in this live round. The container also
retrieved the public LinkedIn company page; both native profiles failed that
visit. Roblox timed out on all three. Runtime probes confirmed SwiftShader in
the container and the actual Apple M4 Pro Metal renderer in both native workers.
Neither native bundle added selected coverage.

The container had 2 CPUs/3 GiB; native workers had no cgroup cap and their process
tree RSS was sampled. Those memory measures differ and shared native pages may
be counted more than once. OS, hardware, browser patch version and network stack
differ, so the experiment does not isolate GPU or branding and supports no
equal-resource performance claim. All 42 payload hashes and scores replayed with
valid timing and at most three global workers, below the user's limit of eight.

### Saved Markdown audit and cleanup

A read-only review replayed 200 saved API payload hashes and output metrics,
with no new network requests. Of the earlier hosted 81 normalized HTML matches,
75 also had the supplementary Markdown marker; the current fork had 52 of 55.
The epochs and deployments differ. This review preserves the frozen HTML score,
does not establish extraction F1 or CSS visibility, and does not remove the
substantial observed retrieval gap. Current full API coverage remains 55/100;
hosted parity is unproven.

The [cleanup receipt](../apps/playwright-service-ts/benchmarks/profile-platform-cleanup-results-2026-11-04.json)
verifies eleven task containers removed, both native services exited, and both
temporary native browser profiles removed. No process referenced those owned
profile directories afterward. No image or build cache was created, so none
needed pruning. Existing image IDs, 59 cache records, nine unrelated running
services and all 114 volume names were preserved. No global prune was used.

No production code changed in this iteration; the focused suites and browser CI
on `4c3e920a9` remain the implementation verification. They were not rerun for
this evidence/documentation update. The results do not support hard-coding a
Vietnam time zone, migrating to native browsers or treating a hidden success
label as clearance.

## Refreshed actual hosted comparison on the repaired source (November 4)

The earlier hosted 81/100 reference predated the navigation and rendered-body
repairs. A fresh comparison now uses evidence/source head `89887a22b`, whose
production implementation is unchanged from `4c3e920a9`, and the existing
`cbff34eac` browser image. The [current comparison receipt](../apps/playwright-service-ts/benchmarks/fresh-current-hosted-api-results-2026-11-04.json)
records all 100 frozen targets once against the fork and once against the actual
hosted API, with fresh rawHTML/Markdown and no expected-text hint.

The fork stayed on direct VN egress. Hosted routing and internal attempts remain
provider controlled. Firecrawl documents its [default managed proxy strategy](https://docs.firecrawl.dev/features/enhanced-mode);
that provider default was left in place for the hosted control, without adding
a proxy to the fork. The user's subsequent instruction to keep local/fork tests
proxy-free is preserved. Hosted response routing labels are retained verbatim;
they do not expose physical egress IPs or establish why a target succeeded.

Four global HTTP workers, two slots per profile and seven-second per-profile
dispatch pacing capped the run at 200 scrape requests, including at most 100
hosted requests. There was no client retry. Both profiles used the same
85-second API request timeout; the fork additionally used its existing
30-second initial-navigation cap and opt-in alternate-engine recovery. Its one
Chromium primary and two Firefox alternates retained the 6.5 GiB aggregate
browser limit. Hosted capacity/routing and backend attempts are not matched.

| Fresh API outcomes, 100 targets/profile | Direct-egress fork | Hosted |
| --- | --- | --- |
| Raw HTML substring matches | 57 | 82 |
| Screened matches | 55 | 81 |
| Normalized matches | 56 | 82 |
| Normalized matches also containing the supplementary Markdown marker | 53 | 76 |

There were 45 common normalized matches, 37 hosted-only, eleven fork-only and
seven matching neither. Ten explicit hosted unsupported-site responses remain
failures in the original denominator. No API-level HTTP 429 occurred; target
HTTP 429 remains a separate failure. Among hosted-only cases, the fork returned
sixteen recognized challenge failures, thirteen other HTTP 403 responses, three
target rate limits, one each of HTTP 405/406/417, one missing marker and one
timeout. Those observations do not identify a single causal failure mechanism.

All 200 payload hashes, scores and output metrics replayed with valid timing and
concurrency bounds. Owner logs account for 100 primary calls and 49 alternate
calls, split 24/25, without repeating an alternate target. Ninety-nine fork
records returned fallback metadata; Roblox's timeout did not, so that record's
returned recovery details remain unknown. Nine reported backend recoveries
produced eight normalized marker matches.

On the 45 common normalized successes, nearest-rank p50/p95 was 3.34/9.01 seconds
for the fork and 7.58/31.78 seconds for hosted. The complete run took 814.0 seconds,
including deliberate dispatch pacing and the final pending hosted request.
These are cohort-specific observations on different infrastructure; they do not
establish an equal-resource speed advantage. Fork memory peaked at
732/923/1,157 MiB, with zero observed memory-boundary/OOM/PID or socket-throttling
events. All owners ended healthy with zero pages/sessions.

Hosted metadata reported `basic` on 82 responses (78 normalized matches),
`stealth` on four (four matches), and no routing value on fourteen (zero matches).
The fork's legacy `basic` output label does not mean it used an upstream proxy;
direct operation was verified from configuration and network preflights. The
actual hosted routing implementation is unknown. The hosted account balance
decreased by 116 credits; 86 responses reported 115 credits in total. Balance
changes can include concurrent account activity and are not an exact invoice.
Absolute account balances remain private.

The previous actual comparison was fork 54/100 versus hosted 81/100 on
`da4bb50c9`. Source, browser identities, topology, navigation policy and live
epoch differ, so the change to 56/82 is not a controlled code-gain estimate.
The repaired source's earlier fork-only result of 55/100 also used different
pacing. The current direct-egress fork remains below actual hosted coverage;
neither a new score definition nor a reduced denominator is used to claim parity.

The [cleanup receipt](../apps/playwright-service-ts/benchmarks/fresh-current-hosted-cleanup-results-2026-11-04.json)
verifies all three created browser containers removed and task infrastructure
stopped. The temporary hosted credential, its private directory and location
file were removed, and retained artifacts passed credential-redaction checks.
No image or build cache was created. Existing image/cache IDs, nine unrelated
running services and all 114 volume names were preserved. No global prune was
used. Production code was unchanged, so focused source suites were not repeated
for this live-comparison/evidence update.

## Late answer-free continuation repair and proxy-free rerun (November 4)

The earlier Amazon failure returned a supported continuation form with no
workflow step. That observation suggested a timing gap, without proving the
cause of that live failure. An owned, offline browser fixture reproduced a
specific defect: a loading shell inserts the strict answer-free GET form after
800 ms, after the initial workflow probe has already finished. Automatic
readiness then recognizes verification and returns without applying the recipe.
Three functional expectations failed before the repair; the other five cases
already passed. The failing parent brings the original test report to four
failures among nine checks.

Playwright documents that [dynamic content can arrive after navigation events](https://playwright.dev/docs/navigations)
and that [click actionability checks](https://playwright.dev/docs/actionability)
apply when a click is actually requested. Here the earlier empty form probe
prevented the existing click recipe from being requested at all.

Production source `0c2c07695` now checks the same recipe once when automatic
readiness discovers verification on the original Amazon product. It requires
no earlier workflow step, no caller actions, no retained/continuing session and
remaining readiness allowance. All existing form, origin and ASIN restrictions
remain. It never answers a puzzle or submits the same form twice. Resumed
readiness uses the remaining original polling allowance; the recipe's existing
navigation/settle work stays under the original scrape deadline. Explicit
readiness does not request this late interaction. No default timeout, retry
count, upstream proxy or other site's workflow changed.

The new regression and related workflows/readiness contracts passed 38 focused
native checks. Linux Chromium/Firefox each passed all nine new checks, with
runtime/compiled hashes matching the candidate. Tests include successful late
continuation, visible answer fields, a different-product redirect, an unresolved
form, caller actions, retained tabs, disabled workflows and an exhausted
readiness allowance. [Browser CI](https://github.com/toreleon/firecrawl/actions/runs/41735378161)
passed build, 60 helper checks, 124 integration checks and the production
dependency audit. Broader server/SDK jobs remain separate. No API source changed;
the earlier API snips are historical verification, not new tests of this repair.

The [fresh full API receipt](../apps/playwright-service-ts/benchmarks/late-continuation-full-api-results-2026-11-04.json)
records all 100 frozen targets once per primary-only/fallback policy, 200 requests
for fresh rawHTML/Markdown, four global HTTP workers/two per policy and
seven-second per-policy dispatch pacing. Both policies use direct VN egress,
no expected-text hint, no client retries, a 30-second initial-navigation cap and
the original 85-second scrape deadline. There were no hosted requests. The
existing one-primary/two-alternate topology retained its 6.5 GiB aggregate
browser limit. Image `ba13d7322` contains the candidate source/compiled repair.
The first single-profile configuration was rejected before target dispatch;
its three browser containers were removed before the supported paired run.

| Full v2 API, 100 targets/policy | Primary only | Opt-in fallback |
| --- | --- | --- |
| Raw HTML substring matches | 48 | 54 |
| Screened matches | 46 | 53 |
| Normalized matches | 47 | 54 |
| Normalized matches also containing the supplementary Markdown marker | 44 | 51 |

There were 46 common normalized matches, eight fallback-only, one primary-only
and 45 matching neither. All 200 payload hashes, scores, output metrics and
lifecycle/concurrency records replayed. Owner logs account for 200 primary and
50 alternate calls, split 25/25. Returned fallback metadata covers 98 records;
LinkedIn and Roblox omitted it. Forty-eight returned records report an alternate
attempt, with seven recoveries and seven normalized matches. Missing returned
metadata is not inferred from a successful or failed score.

Both Amazon policies submitted the answer-free continuation once, returned to
the original ASIN and retrieved matching product Markdown. The live step does
not distinguish initial versus late application, so this live success cannot
be attributed specifically to the new timing path. The controlled fixture is
the proof of that repair.

The new fallback score is 54/100 versus 56/100 in the preceding actual comparison.
Zoopla gained a match; Indeed returned a challenge, Louis Vuitton returned HTTP
403 and LinkedIn lost its match with connection errors. Owner logs record
Chromium `ERR_CONNECTION_CLOSED` and Firefox `NS_ERROR_NET_RESET` for LinkedIn.
Only the Amazon recipe changed. Source/live epoch and the added primary-only
traffic differ, so the aggregate drop is not a controlled estimate of a code
regression. Against the earlier 45/55 paired run, the new result is 47/54;
Amazon/Zoopla gained and Indeed/Expedia/eBay lost fallback matches. That run had
different dispatch pacing as well.

The run took 727.6 seconds. On the 46 common normalized successes, primary
p50/p95 was 3.35/7.36 seconds and fallback 3.37/7.77 seconds. Memory peaked at
1,262/1,064/1,131 MiB. All observed memory-boundary/OOM/PID/socket-throttling
counters stayed zero, and all owners ended healthy with zero pages/sessions.
These are measured deployment observations, not an equal-resource speed claim.
The last actual hosted reference remains 82/100 on the preceding source; it was
not rerun for this candidate. Hosted coverage parity remains unproven.

The [cleanup receipt](../apps/playwright-service-ts/benchmarks/late-continuation-cleanup-results-2026-11-04.json)
verifies seven task containers removed across the Linux tests, rejected
configuration and full run. Eleven exact new cache records were pruned
(Docker-reported 628.5 kB). The verified image and all pre-existing images and
59 cache records were retained. Task infrastructure is stopped; nine unrelated
running services, all 114 volumes and raw evidence were preserved. No global
prune was used. Focused tests were not repeated for the subsequent evidence edit.

## Main content readiness and workflow recovery (November 4)

The saved Temu response exposed a recovery gap: its rendered puzzle produced
`HUMAN_REQUIRED`, but the optional alternate was skipped because the older
`botDetection` field was absent. Controlled API fixtures reproduced both that
missed recovery and promotion of an HTTP 200 alternate declaring an unresolved
workflow state. Before the change, ten unit checks and eleven full API protocol
checks failed. Production source `70ff6e17a` now treats `HUMAN_REQUIRED` and
`VERIFICATION_REQUIRED` as eligible failed captures under the existing completed
attempt, closed-page, matching-owner and shared-deadline requirements. A supplied
alternate state must be `CONTENT_READY` to count as recovered content. Older
owners omitting state still pass through the other existing response checks.
Retained sessions, actions, uncertain outcomes and extra attempts keep their
existing restrictions. No puzzle answers are submitted.

An eight-request, direct-egress browser-service probe used three Temu visits and
one GitHub control per Chromium/Firefox engine. Neither engine matched Temu
(0/3 each); both controls passed. The saved probes contained off-document sample
text consistent with font measurement, footer labels below an empty main area,
or format-only content. Five of the six Temu samples were marked ready despite
returning only sample/footer text. This was not a successful access experiment.

Owned fixtures reproduced premature capture from off-document spans and from
footer text outside an empty main landmark. The repaired automatic check now
samples rendered main text when available and body text otherwise, excluding
text wholly outside the document's negative bounds. The bounded walk samples
at most 20,000 text nodes and 4,096 characters. It preserves ordinary below-fold
text, `display: contents`, explicit caller readiness and returned body text.
Segmented loading labels remain loading. A temporarily absent document root
during passive navigation stays an empty observation rather than throwing.

This design uses the [main element's documented content role](https://html.spec.whatwg.org/multipage/grouping-content.html#the-main-element)
and [text-range rectangles](https://developer.mozilla.org/en-US/docs/Web/API/Range/getClientRects).
Document coordinates account for [horizontal scroll offsets, including negative RTL offsets](https://developer.mozilla.org/en-US/docs/Web/API/Window/scrollX).
These choices improve readiness heuristics; they are not proof of complete
extraction or CSS visibility throughout the document.

Verification passed 36 API unit checks, fourteen real API/queue/worker checks
with controlled browser-protocol owners, 36 focused native browser/helper checks,
eighteen Linux Chromium/Firefox checks and four real API/queue/browser snips.
The protocol checks are not real-browser or public-site evidence. The real
browser cases cover delayed content behind samples/footer labels, bounded
failure, streaming/hidden bodies, partial busy output and explicit readiness.
The initial Linux prototype exposed a missing-root race; its source and compiled
files were exported before the obsolete image was removed. Final Linux tests
passed after the guard was added.

The [new full API receipt](../apps/playwright-service-ts/benchmarks/primary-text-full-api-results-2026-11-04.json)
uses browser image `5003f3d1d` and source `70ff6e17a`. It retains the preceding
paired run's 100 frozen targets per policy, one request per target/policy,
four global HTTP workers/two per policy, seven-second per-policy pacing, an
85-second request deadline and a 30-second initial-navigation cap. The one
Chromium primary/two Firefox alternate topology retains a 6.5 GiB aggregate
browser limit. No client retries, expected-text hints, upstream proxies or
hosted requests were added.

| Full v2 API, 100 targets/policy | Primary only | Opt-in fallback |
| --- | --- | --- |
| Raw HTML substring matches | 46 | 55 |
| Screened matches | 45 | 55 |
| Normalized matches | 46 | 56 |
| Normalized matches also containing the supplementary Markdown marker | 44 | 53 |

All 46 primary matches also matched with fallback; ten were fallback-only and
44 matched neither. Owner logs account for 200 primary and 52 alternate calls,
split 26/26. Returned fallback metadata covers 96 records, with ten reported
recoveries and ten normalized matches. Canada Goose, Verizon, LinkedIn and
Roblox omitted returned recovery metadata; their details are not inferred from
scores. Both Temu responses returned login pages and lacked the frozen product
marker. Their `CONTENT_READY` interaction label was incorrect; the later
authentication-route repair below corrects classification. No Temu coverage
gain is claimed.

Against the preceding 47/54 paired run on `0c2c07695`, fallback gained Indeed,
GoodRx and Google Search, and lost Apartments.com. The new 46/56 result does
not isolate a code effect: source/browser identities, live epoch and shared-host
activity differ. The last actual hosted comparison remains 56/82 on the earlier
source; hosted was not refreshed. Coverage parity remains unproven.

All 200 payload hashes, scores and output metrics replayed. The run took 746.9
seconds. On the 46 common normalized successes, primary p50/p95 was 3.17/7.31
seconds and fallback 2.98/8.55 seconds.
Across all attempts, p95 was 15.11 seconds for primary and 21.74 seconds for
fallback, versus 8.57/10.50 seconds in the preceding paired run. Tail
latency therefore increased in this observation.

Sampled owner memory peaked at 1,219/1,037/1,219 MiB, with zero observed
memory-boundary/OOM/PID events.
Socket-throttling counters were 3,068/7/1. The kernel documents this as a
[separate network-socket throttling counter](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).
An unrelated OpenGTM build overlapped 23:50:20–23:51:20 UTC; throttling had
already been observed before that interval. Neither observation establishes a
particular failure's cause. There is no isolated code-gain or speed claim.

### Benchmark deadline hardening and final CI

Initial CI passed 60 helper and 127 integration checks, with one benchmark-client
timeout test cancelled. That test passed in isolated Linux Node 22. Its CI root
cause was not isolated. A separate owned stream deliberately ignoring abort
proved the client could remain pending after its deadline. Commit `9e2a939ac`
now settles the deadline independently and cancels the body reader. Fixture
teardown also follows the [Node HTTP close ordering](https://github.com/nodejs/node/blob/v22.x/doc/api/http.md#servercloseallconnections).
Three benchmark-client checks passed on macOS and Linux Node 22. Final
[browser CI](https://github.com/toreleon/firecrawl/actions/runs/41743254194)
passed build, 60 helper checks, 129 integration checks and the production
dependency audit. Broader server/SDK jobs are separate and not verified passed.

This harness-only repair followed the completed 200-request run. Its historical
runner source was preserved, request construction/metric source text was proved
unchanged and all 200 saved observations replayed again without network calls.
The nineteen recorded production source files are byte-equivalent between the
measured and CI revisions; the intervening diff contains only benchmark client
and integration-harness files. No historical receipt is relabelled as a new run.

The [cleanup receipt](../apps/playwright-service-ts/benchmarks/primary-text-cleanup-results-2026-11-04.json)
verifies twelve task containers removed, one obsolete prototype image removed
after exporting its source/compiled files, and nineteen exact task cache records
pruned (Docker-reported 1.3 MB). Cache ownership used the two build records,
non-overlapping build windows, before/after inventories and parent-chain checks.
All 59 baseline cache records, 69 concurrent unrelated cache records, pinned
images, nine unrelated running services and all 114 volumes were preserved.
The verified image and raw evidence remain; task infrastructure is stopped.
No global prune was used. Source suites were not repeated for this evidence edit.

### Shared owner budgets and authentication routes (November 4)

The [selected-target topology receipt](../apps/playwright-service-ts/benchmarks/memory-pool-api-results-2026-11-04.json)
records 80 fresh full-API requests across 20 frozen targets. Separate and pooled
owners each visited every selected target twice, in separate/pooled/pooled/separate
phase order with forward/reverse/forward/reverse target order. Every phase started
fresh browser owners. Two HTTP workers, seven-second dispatch spacing, the same
opt-in engine fallback, one browser attempt, original request deadlines and direct
VN egress were retained. There were no client retries, expected-text hints,
upstream proxies or hosted calls.

All phases used API source `c87e7d7bd` and the existing `5003f3d1…` image, whose
production browser source is `70ff6e17a`. Both deployments had an aggregate six
CPU quota, 6,656 MiB memory cap and 2/1/1 page slots. The pooled experiment placed
the Chromium owner and two Firefox owners in three separate Node processes with
distinct boot IDs, sharing one container's CPU/memory budget and Xvfb display.
This also changes isolation and failure domains; it is not a single-variable
memory experiment.

| Selected-target result | Separate owners | Shared budget |
| --- | ---: | ---: |
| Normalized successes, 40 observations each | 16 | 17 |
| Successes by phase, 20 targets each | 9 / 7 | 9 / 8 |
| All-attempt p95 | 20.93 s | 23.19 s |
| Common-success cohort p50, six targets visited twice each | 3.75 s | 3.72 s |
| Common-success cohort p95 | 5.85 s | 5.57 s |

The first paired phases had one exclusive success in each direction; the second
had two pooled-only and one separate-only. Backend logs account for 80 primary
and 54 alternate dispatches, with exactly 27 alternates per topology. All 80
payload hashes, frozen scores, Markdown metrics, dispatch spacing and concurrency
replayed. Returned fallback receipts were checked separately from backend
dispatches. These repeated observations of 20 selected targets are not a new
100-target score. One extra success and mixed latency results do not establish a
deployment improvement, so pooled owners were not adopted. The last full run
remains 46/56, and the earlier hosted reference remains 82; neither was rerun for
this experiment or the subsequent classification repair.

In the first separate phase, one Firefox owner reached its 2-GiB cap and recorded
1,542 memory-boundary events. Socket-throttling counters were 671/134/84; in the
last separate phase only one Firefox owner recorded 344. The shared-budget phases
recorded zero memory-boundary/socket-throttling events, with cgroup peaks of
3,871 and 3,714 MiB. OOM, OOM-kill and PID-limit counters remained zero throughout.
The upstream Linux v7.0 [socket-pressure check](https://github.com/torvalds/linux/blob/v7.0/include/net/sock.h)
also examines ancestor pressure, and [reclaim efficiency](https://github.com/torvalds/linux/blob/v7.0/mm/vmpressure.c)
can set that pressure marker. These sources explain why a socket counter alone
does not establish that a browser hit its own cap or that a target failure was
caused by memory pressure. The measured Docker kernel was `7.0.12-linuxkit`;
upstream source review is not verification of every LinuxKit patch. Build-history
snapshots were unchanged across each phase, but nine unrelated services remained
running. Live epoch, identities, target-rate effects and other host activity
remain comparison limits.

Reviewing the saved Temu responses exposed a separate classification defect: both
landed on `/login.html` with an email-first sign-in prompt, while reporting
`CONTENT_READY`. The old route expression also inspected query/fragment text and
matched partial names such as `login-guide`. Three of four focused regression
cases failed before the fix. Authentication hints now use the final URL's
[pathname](https://developer.mozilla.org/en-US/docs/Web/API/URL/pathname), with
segment boundaries for the existing routes and a rendered sign-in prompt for
root login/sign-in HTML routes. All four regressions now pass; 13 focused native
checks and 19 Linux Node 22 checks, including both browser engines, passed.
The repair followed the completed topology experiment. It classifies returned
documents and does not automate login or establish additional target coverage.

The initial browser CI passed 63 helper and 139 integration checks, but one
Camoufox request lacked page-close confirmation within the existing cleanup
window; its parent tests also failed. Its classification assertions passed.
The root cause was not isolated. Integration test-file concurrency is now
explicitly bounded at two, retaining the close assertion and including
diagnostics on failure. No production cleanup timeout was changed. The following
[browser CI](https://github.com/toreleon/firecrawl/actions/runs/41751982029), on
`8160af325`, passed build, 63 helper checks, 142 integration checks and the
production dependency audit. That test-only follow-up leaves the production
runtime byte-equivalent to authentication repair `30244c3ab`. A passing run does
not by itself prove the earlier failure's cause. Broader server/SDK jobs are
separate and have not been verified passed.

Cleanup verified all eleven task containers absent: eight topology containers,
two short-lived resource samplers and the auto-removed Linux contract container.
Task API/owner ports are closed and PostgreSQL/Redis/RabbitMQ are stopped. The
same nine unrelated containers and all 114 volume names were preserved, as were
the reusable image and raw evidence. No images were built or removed, and no
cache or global prune was performed in this experiment.

### Contained WebKit prototype (November 4)

The [prototype receipt](../apps/playwright-service-ts/benchmarks/webkit-prototype-results-2026-11-04.json)
records a useful site-specific lead: WebKit retrieved the expected rendered Saks
product content in **five of five** matched fresh-context visits. Chromium and
Firefox each passed **zero of five**; all six GitHub controls passed. These are
browser-service observations, not full Firecrawl API results. The earlier
sixteen-target comparison tied at three successes for each engine. WebKit's
default user agent subsequently scored four of sixteen, while Linux-platform
and pinned-upstream GLib-format variants each scored three; the extra Saks
success prompted the matched replication. These measurements support further
integration work, not an aggregate coverage or hosted-parity claim.

All three bundles ran headful Linux ARM64 on the same prototype image, with two
CPU quota, 2 GiB and one page slot each. Three HTTP workers, one per owner, used
direct VN egress, enabled page JavaScript, fresh contexts, one service attempt,
30-second navigation/service deadlines and a 35-second client deadline. No
client retries, expected-text hints, upstream proxies or hosted calls were used.
Each matched Saks batch followed a fifteen-second wait and rotated engine order.
Independent replay checked all 117 completed payload hashes, frozen scores,
rendered markers, backend dispatches, owner boot IDs and page-close proofs.
The reused pacer reserves a slot before starting fetch: per-profile minimum
observed gaps were 6.991–7.001 seconds, so its seven-second configuration is not
an exact dispatch floor. All three experiments reached concurrency three;
OOM, OOM-kill and PID-limit counters remained zero.

The candidate uses Playwright 1.64.1, WebKit 27.2/revision 2370, Chromium
156.0.8078.4 and Camoufox 158.0.1-beta.41. Playwright documents that its
[WebKit build](https://playwright.dev/docs/browsers) is patched upstream WebKit,
not installed Safari. The pinned
[upstream configuration](https://github.com/microsoft/playwright/blob/v1.64.1/browser_patches/webkit/UPSTREAM_CONFIG.sh)
and [GLib user-agent source](https://github.com/WebKit/WebKit/blob/56453fdfe0b0ca6258c23e6453b34f70b885d13f/Source/WebCore/platform/glib/UserAgentGLib.cpp)
informed the UA variants; changing those strings did not establish an improvement.
The default UA describes macOS while this runtime reports a Linux platform.
Engine identity, time, rate effects, host load and different network containment
remain confounders; this is a comparison of bundles, not an isolated driver test.

Owned probes showed that uncontained WebKit sent three STUN UDP packets and
opened one TURN TCP connection outside the HTTP filtering proxy. A native macOS
sandbox wrapper also failed owned loopback/RTC checks and was not used against
public benchmark targets. The Linux candidate instead runs its browser as UID
1000 with zero effective capabilities and NoNewPrivs, while a trusted root
service with container-scoped NET_ADMIN installs IPv4/IPv6 UID rules allowing
only TCP to the local destination-filtering proxy. Owned HTTP/HTTPS allowances,
private-address rejection and page JavaScript passed; RTC probes then observed
zero UDP packets and zero TCP connections. The IPv6 rule was installed, but no
actual IPv6 packet negative test is claimed. This experimental privilege model
still needs production design, child-environment isolation and focused tests.

Three initial GitHub control calls exposed a missing system CA bundle: Chromium
and Firefox passed while WebKit rejected the certificate. The run stopped before
comparison targets. Installing standard `ca-certificates` repaired the candidate;
verification stayed enabled, and an owned untrusted certificate was still
rejected. This image setup defect does not explain historical engine failures.
The public-request accounting is **120 RPCs**: those three aborted controls plus
48 engine comparisons, 48 UA comparisons and 21 matched-replication calls.
Ancillary geolocation checks and a Node TLS diagnostic are separate.

All 26 measured runtime source/compiled files match checkout `ac870a06f`.
Only private experimental bootstrap/launch code changed; WebKit has not yet
been added to the production API or fallback policy. Next work is explicit
engine/port configuration, a least-privilege network boundary, session/fallback
compatibility and focused happy/failure tests, followed by a bounded proxy-free
hundred-target evaluation. The last full run remains primary 46/fallback 56;
the historical hosted reference remains 82. Neither was rerun here.

Cleanup verified 24 task containers absent, two obsolete task images removed,
29 exact task cache records pruned (Docker-reported 696 MB), and the unused
302,570,601-byte native browser cache removed after retaining executable hashes.
The working experimental image `8ea3f825…`, production image `5003f3d1…`, raw
evidence, all 128 baseline cache records, nine unrelated running services and all
114 volumes were preserved. Build windows, parent chains and an exact-ID preview
bounded cache removal. Shared browser caches were untouched; no global prune was
used. No production source changed, so the prior 205-check browser CI remains
production-runtime evidence, not validation of the experimental WebKit launcher.

### Opt-in WebKit integration and full API evaluation (November 4)

The [implementation receipt](benchmarks/webkit-implementation-api-results-2026-11-04.json)
records the production integration and a fresh hundred-target run. WebKit is now
an explicit optional engine, installed with `INSTALL_WEBKIT=true`. Its ordinary
container entrypoint installs the UID network policy before serving requests,
then removes NET_ADMIN/NET_RAW from the trusted service's capability bounding
set. Browser children use UID 1000, zero capabilities and NoNewPrivs, with a
restricted environment that excludes service credentials and loader overrides.
Root ownership protects the application and executable. The configured filter
port must match the listening SSRF proxy. This mode requires a dedicated Docker
network namespace; it is not supported on the host or in a shared namespace.
[Deployment details](browser-workflows.md#optional-alternative-browser) describe
the remaining trusted-root capability requirements. Chromium remains the default.

The API's existing generic owner discovery and distinct-engine/boot guards work
with WebKit. Focused checks passed for page/worker scripts, headers, redirects,
cookie isolation, retained-context deletion, denials, timeout cleanup and the
network boundary. Owned IPv4/IPv6 STUN/TURN constructions sent no packets, and a
same-UID IPv6 TCP attempt was rejected after a successful trusted-UID control.
Two full API snips passed through `pnpm harness`, using actual Chromium/WebKit
owners: consent/readiness forwarding recovered a closed primary denial; opt-out
sent no alternate request and unresolved alternate denial remained a failure.
The harness command returned zero and terminated its processes, but its extract
worker logged `IllegalOperationError: Channel closing` during teardown. These
receipts do not prove clean worker shutdown.

[Browser CI on the measured source](https://github.com/toreleon/firecrawl/actions/runs/41765568461)
passed build, 65 helper checks, 142 ordinary integration checks and the production
dependency audit. Two optional WebKit parent tests are skipped in that ordinary
suite. The separate WebKit job built the full optional Docker image, passed all
nine checks including parent/child tests, and refused startup without the
required UID or startup capability. The local ARM64 image was built by an
overlay on the retained prototype, with source/compiled hashes checked; CI also
verified the committed Dockerfile from scratch. Early local failures and their
repairs are retained separately, including unsafe old binary ownership and two
incorrect test expectations. Broader server/SDK jobs are not verified here.

| Fresh full API policy: WebKit primary, optional Firefox alternate | Result |
| --- | ---: |
| Normalized HTML marker matches | 56 / 100 |
| Screened matches | 55 / 100 |
| Normalized matches also containing the supplementary Markdown marker | 53 / 100 |
| Successful-request p50 / p95 | 4.93 s / 8.42 s |
| All-request p95 | 9.74 s |

The run made 100 API requests and **153 backend captures**: 100 WebKit, 27 and
26 on the two Firefox owners. There were four HTTP workers, one API request per frozen
target, no client retries, expected-text hints, upstream proxies or hosted calls.
Direct VN egress, the original 85-second API deadline, 30-second navigation cap,
automatic workflow, consent policy and aggregate 6,656-MiB browser cap were kept.
The configured seven-second reservation pacer recorded a minimum actual gap of
6.999 seconds. Source `4106cb18e` differs from runtime `2fef32b3e` only in
single-profile benchmark validation and its tests; six focused harness checks
passed. An initial two-profile validation rejection stopped before any target
request and was archived before the repaired run.

All hundred payload hashes and scores replayed, and backend URL logs accounted
for every capture. Ninety-four API responses returned fallback diagnostics,
including 145 closed-attempt proofs. Six responses lacked those diagnostics.
Backend logs show 53 alternate dispatches while 51 returned fallback receipts;
these are recorded separately. Sixteen returned alternates were internally
accepted as recovered, of which fifteen matched the frozen target text. Final
owners were healthy with zero pages/sessions. OOM, OOM-kill and PID-limit counters
were zero. Socket-throttling counters were 199/2,902/656; these do not establish a
target failure's cause or that an individual owner reached its own memory cap.

The total equals the historical Chromium/Firefox fallback score of 56. Four
targets succeeded only in this run (Louis Vuitton, Expedia, eBay, Apartments.com),
while four historical successes failed (Alibaba, GoodRx, Capterra, YouTube).
Different live epoch and engine bundles prevent a causal comparison. No new
primary-only score is inferred from these fallback responses, and hosted 82
remains a separate historical reference. WebKit stays opt-in; an overall
improvement and hosted parity remain unproven. The earlier five Saks contexts
shared one browser owner, not five independent browser boots. Saks failed with
a connection-termination error in this fresh full API run.

Saved logs identified two navigation connection-termination errors, a separate
non-proper TLS termination, a page-process crash and 32 blocked blob resource
requests. Upstream [libsoup 3.2.3](https://github.com/GNOME/libsoup/blob/3.2.3/libsoup/http2/soup-client-message-io-http2.c)
uses the observed connection-termination wording for HTTP/2 EOF; the installed
package reports `3.2.3-0+deb12u2`, without a downstream-patch audit. The
[File API blob model](https://w3c.github.io/FileAPI/#url-model) defines browser
store and origin restrictions. Next work is controlled regression coverage for
these errors and valid blob resources, preserving certificate validation and
private-destination checks. Those observations do not prove that either repair
will recover a public target.

Cleanup verified all nineteen task containers absent and task infrastructure
stopped, with task ports closed. Two overwritten prototype image references
were already absent, so no explicit image removal was needed. Thirty exact task
cache records were pruned (Docker-reported 1.017 GB); all 128 baseline cache
records, working image `032721e8…`, prior images, nine unrelated services, all
114 volumes and raw evidence were preserved. No global prune was used.

### Blob resources, navigation termination and a controlled follow-up (November 4)

The [repair receipt](benchmarks/webkit-resource-api-results-2026-11-04.json)
records two fixes at `46e27e429`. Non-navigation blob resources with an HTTP/HTTPS
origin now use that origin for the existing private-destination and ad checks,
then resolve in the browser's store. Worker network requests retain the
destination filter and UID policy. Top-level blob input/navigation, opaque/file
origins and private origins remain blocked. The [File API model](https://w3c.github.io/FileAPI/#url-model)
distinguishes browser-store resolution from an outbound network connection.
Only the exact WebKit `page.goto: Connection terminated unexpectedly` first line
is now typed as `NETWORK_ERROR` / `WEBKIT_CONNECTION_TERMINATED`. Existing
closure/owner guards can then permit bounded fallback. Certificate errors,
other TLS termination, page crashes and evaluation exceptions are not covered
by that mapping.

Before the repair, the owned blob worker never became ready and a real
navigation termination was classified as `BROWSER_ERROR`. Top-level blob
rejection and certificate rejection already passed. All four leaf cases now
pass, along with the existing WebKit containment checks: fourteen parent/child
checks in total. Fifteen focused native helper checks passed. The initial
transport fixture required HTTP/2 and failed at ALPN before receiving a request;
it was repaired to accept HTTP/1.1 and HTTP/2 before the EOF regression. The
observed wording alone does not establish a public target's HTTP version.
Three full API snips passed through `pnpm harness`, exercising actual blob
rendering, one WebKit-to-Firefox recovery after EOF, opt-out, certificate
rejection and forbidden top-level blob input. An explicit TLS exception reaches
the EOF path only for that owned self-signed fixture; the negative test and all
public benchmark requests retain certificate verification. The harness again
logged the separate extract-worker channel-closing error during shutdown while
returning zero and terminating its processes; clean worker shutdown is unproven.

[CI on the measured source](https://github.com/toreleon/firecrawl/actions/runs/41768035733)
passed build, 67 helper checks, 146 ordinary integration checks and the production
dependency audit. The ordinary suite skips three optional WebKit parents; the
separate Docker job passes all fourteen WebKit checks. Blob rendering is also
covered on Playwright, Patchright, Rebrowser and Camoufox. The local final image's
compiled runtime is byte-equivalent to the image used for owned and full API
checks; only source formatting and additional fixture coverage followed those
checks. Measured source/compiled hashes were verified on every benchmark owner.
Broader server/SDK jobs are not verified here.

The fresh full API WebKit/Firefox policy produced **53/100 normalized matches**,
52 screened matches and 50 matches also containing the supplementary Markdown
marker. Successful-request p50/p95 were 4.95/8.37 seconds; all-request p95 was
9.13 seconds. It made 100 API requests and 153 captures: 100 WebKit and 53 Firefox.
Four HTTP workers, the same controls/deadlines, seven-second reservation pacing,
one API request per target, direct VN egress and the 6,656-MiB browser cap were
retained. There were no client retries, expected-text hints, upstream proxies or
hosted calls. All hundred hashes/scores replayed. Ninety-six responses returned
fallback diagnostics with 148 closed-attempt proofs; four lacked diagnostics.
Backend logs show 53 alternate dispatches and 52 returned alternate receipts.
Thirteen internally accepted recoveries included twelve frozen-text matches.
Final owners were healthy with zero pages/sessions; OOM, memory-boundary,
socket-throttling and PID-limit counters were zero. The minimum observed dispatch
gap was 6.999 seconds, preserving the known reservation-versus-dispatch limit.

The previous policy scored 56. Saks now passed on WebKit without fallback, while
Louis Vuitton, Google Search, Best Buy and Zoopla failed after earlier successes.
Louis Vuitton changed from primary success to denials on both engines. Best Buy
lost a primary success; Google and Zoopla lost prior Firefox recoveries. These
are observed stage changes, not proof that the two repairs caused the drop.
The primary log recorded one connection termination, and Allegro returned a
primary `NETWORK_ERROR` receipt without a normalized recovery. Blocked blob
request logs fell from 32 in the prior full run to zero, but American Airlines
still failed the content-marker check. Returned fallback receipts do not retain
all primary network aliases/document diagnostics, limiting finer attribution.

A further **twenty direct browser-service captures** compared the previous and
repaired WebKit images on ten identical targets. Selection took GitHub/arXiv
controls, the five full-run disagreements, then prior failure cases to fill ten.
Each image had two CPU quota, 2 GiB, one page slot, the production UID policy and
identical request controls. Two workers alternated dispatch order; contexts were
fresh and no client retries or proxies were used. All twenty payload hashes,
scores, owner identities, closed attempts and backend dispatches replayed.
Both variants passed **3/10**, on exactly the same targets (GitHub, arXiv, Saks),
and had the same failure outcomes on the other seven. All four normalized
control observations passed. No OOM or PID-limit events occurred.

This small selected comparison did not reproduce a primary WebKit outcome
regression. It does not rule out regressions elsewhere or compare Firefox
fallback, and its 30-second service deadline differs from the full API deadline.
It is not a powered causal test or another population score. The full result
remains 53/100; the previous 56 and hosted 82 remain separately dated references.
The combined public-capture count was **173**, within the 200-capture limit.
Neither the owned fixes nor this diagnostic cohort establish a coverage gain.

Cleanup removed eleven task containers, the intermediate `633c8e8a…` image and
33 exact task cache records (Docker-reported 328.5 MB). Working image
`9a711a26…`, prior images, all 128 baseline cache records, nine unrelated services,
all 114 volumes and raw evidence were preserved. Task infrastructure is stopped
and task ports are closed; no global prune was used. Next work is controlled
renderer-crash/TLS-termination investigation and preserving primary diagnostics
through API receipts before making further recovery claims.

## Confirmed renderer crashes and queued failure receipts

Measured production source: `dae1f2016293958a446c73986d0b4de8da453a66`. The service now observes the
[Playwright Page crash event](https://playwright.dev/docs/api/class-page#page-event-crash),
types a generic operation failure as `PAGE_CRASHED` only after that event, and
leaves explicit deadline/cancellation failures intact. The existing opt-in
stateless alternate requires the crash flag, one closed page, matching boot, a
distinct engine and remaining original budget. It does not add a service-internal
crash retry or enable replay for retained sessions, caller actions or unknown outcomes.

An owned pending-navigation fixture killed only the single UID1000, zero-capability
renderer inside a dedicated Docker PID namespace. Both headless WPE and headful
GTK returned generic `BROWSER_ERROR` before the repair despite confirmed page
closure. Afterward both returned `PAGE_CRASHED` with the observed event flag,
closed their pages and served a fresh subsequent request. Two earlier predicate
development runs found no renderer and injected no fault; those are not before evidence.

Closed-attempt engine/network/document receipts now survive queue error
serialization and failed HTTP responses. Recognized document fields are bounded;
diagnostic URLs omit user information, query and fragment. Both known failures
remain visible. A lost/unconfirmed alternate preserves only known completion
and reports `outcomeUnknown`, without inventing proof or dispatching again.
Generic `BROWSER_ERROR` does not become eligible for fallback.

| Same frozen 100 targets, WebKit with optional Firefox alternate | Result |
| --- | ---: |
| Normalized HTML content-marker matches | 52/100 |
| Screened matches | 51/100 |
| Normalized matches also containing supplementary Markdown marker | 49/100 |
| Successful-request p50 / p95 | 5.15 s / 12.26 s |
| All-request p95 | 12.26 s |

The run used 100 API requests and 162 browser captures, four HTTP
workers, one request per target, no client retries, no upstream proxy and no hosted
calls. The seven-second reservation pacing, 85-second API deadline, 30-second
navigation cap, consent/workflow settings and aggregate 6,656-MiB browser cap
match the previous full policy. All hundred payload hashes and scores replayed;
backend URL logs account for every capture. Returned closed-attempt proofs:
161 across 100 responses,
including 4 failed HTTP responses.

The previous live run matched 53/100. New-only matches: YouTube, Best Buy, Zoopla.
Previous-only matches: saksfifthavenue, autotrader, target, SeatGeek. These are different live epochs, not a paired
old-code comparison. The historical hosted reference remains 82/100 and was not
refreshed. Aggregate causal improvement and hosted parity remain unproven.

Public targets with observed crash-event/closed-page proof: YouTube.
Their complete per-attempt outcomes are retained in the receipt; a crash event
or HTTP 200 alone does not establish a content match. In particular, inspect
the normalized outcome alongside `engineFallback.recovered`.

Final owners had zero active pages/sessions. OOM, memory-boundary and PID-limit
counters remained zero. Socket-throttling event maxima were
primary-a=0, fallback-a=304, fallback-b=138. The
[kernel documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#memory-interface-files)
defines that counter separately from OOM. This is a resource caveat, not proof
of a target-specific failure or a measured timing effect. No resources or
kernel settings changed mid-run. Point-in-time pressure/socket observations
are retained with the regular resource ledger.

Validation: five owned full-API snips passed through `pnpm harness`, including
actual renderer recovery exactly once and opt-out error diagnostics without
replay. Forty-one fallback unit checks cover invalid crash/boot/closure proof,
redaction/bounds, queue round trip, both-engine errors, unknown alternate outcomes
and unavailable distinct backends. API type checking, 67 helper checks and 16
local contained WebKit checks passed. [CI on the measured code](https://github.com/toreleon/firecrawl/actions/runs/41772317567)
passed build, 67 helpers, 146 ordinary integration checks, production dependency
audit and all 16 checks in a separately built contained WebKit image. Five
optional WebKit parents are skipped in the ordinary suite. Broader server/SDK
workflows are not claimed. Harness commands exited zero and reported processes
terminated, but extract-worker teardown still logged a channel-closing error;
clean shutdown is not established.

Scoped cleanup removed 11 task containers, one obsolete task image and
36 exact task cache records. It retained the measured image, baseline
images/cache, nine unrelated services, all 114 volumes and raw evidence. Task
infrastructure is stopped and ports are closed; no global prune or volume removal.

Remaining investigations include non-proper TLS termination and unconfirmed
alternate completion. Neither should be promoted to a renderer crash from
error prose. Access denials, verification, marker-only markup and rate limits
still need separate treatment under the proxy-free constraint.

[Complete result, per-target receipts, source/image hashes, validation and cleanup](benchmarks/renderer-recovery-api-results-2026-11-04.json).
