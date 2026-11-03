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
