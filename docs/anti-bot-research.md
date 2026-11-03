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
attempts failed before navigation with network errors. The delayed country prompt
and asynchronously rewritten product link have controlled browser regressions.
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
