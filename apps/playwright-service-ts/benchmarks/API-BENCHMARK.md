# Fresh full-API comparisons

The browser-backend Frontier runs measure `/scrape` in the Playwright service.
They do not establish full Firecrawl API parity. This runner calls `/v2/scrape`
on two or more deployments, retaining HTML, Markdown, target HTTP status,
reported cache state and returned credit usage. It uses the same HTML grader as
the browser benchmark. A missing target status or missing `rawHtml` fails the
HTML checks; an API-level `success: true` does not override this.

Copy `api-profiles.example.json` to a local configuration. It names environment
variables for credentials; it must not contain key values. Configure
`HOSTED_FIRECRAWL_API_KEY` in the runner's environment when using the hosted
profile. Self-hosted deployments
with authentication can set their own `apiKeyEnv` too. All URLs are API base
URLs, without `/v2/scrape`. HTTPS is required for credentials except on loopback.
HTTP redirects are not followed.

From `apps/playwright-service-ts`:

```sh
pnpm benchmark:api \
  --profiles=/absolute/path/to/api-profiles.json \
  --targets=github,arxiv \
  --attempts=1 --concurrency=2 \
  --max-requests=4 --max-requests-per-profile=2 \
  --out=/absolute/path/to/new-run-directory

pnpm benchmark:api:audit --run=/absolute/path/to/new-run-directory
```

The defaults cap dispatch at 40 total requests and 20 per deployment. Requests
above either limit are rejected before dispatch. These are **request budgets**;
provider retries and credit charges may differ. The runner never retries a
failed request. Missing credit usage stays unknown, rather than becoming zero
cost. Retained evidence redacts the configured credential values even when a
provider echoes them. Evidence files are created with mode `0600`; keep the
containing directory private because page contents may be sensitive.

Both APIs receive `formats: ["rawHtml", "markdown"]`, `onlyMainContent: false`,
`maxAge: 0`, `storeInCache: false` and `waitFor: 0`. Expected marker text is
**not** sent as a readiness hint. Fork-only `browserControls`, if configured,
are explicit in the manifest; Cloud receives only the common request. Hosted
network routing and internal retries remain provider-controlled. A direct
self-hosted deployment and Cloud therefore give a product outcome comparison,
not a causal browser or proxy experiment.

Profile order rotates by target and round. Concurrency is the maximum total
HTTP requests in flight, from 1 through 8. The manifest records fixture and
grader hashes. `attempts.jsonl` is append-only during a run; `report.json` is
written after all expected attempts finish. The offline audit checks exact
profile/target/attempt coverage, retained payload and content hashes, replayed
HTML and Markdown marker checks, summary metrics and source hashes without
making network requests.

Set a profile's `minIntervalMs` to pace its dispatches across all workers. For
example, `7000` stays below ten requests per minute; give both profiles this
interval for a paced comparison. Pacing wait is recorded separately from HTTP
latency. Provider HTTP status and account rate-limit counts are also recorded:
an API-level 429 is not a target-site WAF failure. Failed attempts remain in the
denominator and are not silently retried. A run limited by account quotas must
not be presented as a retrieval-capability comparison.

Set `maxConcurrentRequests` on a profile to enforce its account limit (integer
1 through 8). For an account reporting two simultaneous jobs, use
`"maxConcurrentRequests": 2` alongside `"minIntervalMs": 7000`. Each profile
has its own slots; the global worker limit still applies. Slot queue wait and
pacing wait are recorded separately and excluded from HTTP latency. Dispatch
and response completion carry a monotonic lifecycle order, so the offline
audit can verify actual overlap without ambiguity from millisecond ties.
Profiles without this option retain the global concurrency behavior.

For a local-only policy experiment, two profiles can use the same API URL and
credentials. Keep all options equal except the policy under test, for example:

```json
[
  {
    "name": "baseline",
    "baseUrl": "http://127.0.0.1:3002",
    "maxConcurrentRequests": 2,
    "browserControls": {
      "waitUntil": "domcontentloaded",
      "workflow": "auto",
      "consent": "rejectNonEssential",
      "maxAttempts": 1,
      "engineFallback": false
    }
  },
  {
    "name": "adaptive",
    "baseUrl": "http://127.0.0.1:3002",
    "maxConcurrentRequests": 2,
    "browserControls": {
      "waitUntil": "domcontentloaded",
      "workflow": "auto",
      "consent": "rejectNonEssential",
      "maxAttempts": 1,
      "engineFallback": true
    }
  }
]
```

The adaptive profile requires a separately configured, healthy alternate engine
pool; see [configuration and constraints](../../../docs/browser-workflows.md#optional-alternative-browser).
No hosted credential or billing call is needed for local-only profiles. Count
alternate browser dispatches separately from API requests and disclose the extra
owner resources. `recovered` metadata is a backend content check, not the frozen
marker score. Missing diagnostics on API failures remain unknown; retain owner
logs for dispatch accounting. Preserve incomplete runs as excluded evidence.

This measures retrieval and one expected snippet per target. A Markdown marker
match does not establish extraction recall, precision, table fidelity, field
accuracy, crawl discovery or production availability. Those need additional
evaluation before claiming comparable hosted performance. Compare fresh and
cached workloads separately: Cloud documents a two-day default cache and warns
that forcing fresh retrieval changes latency and reliability.

Sources checked November 3, 2026:

- [Firecrawl v2 Scrape API](https://docs.firecrawl.dev/api-reference/endpoint/scrape)
- [Firecrawl caching and freshness](https://docs.firecrawl.dev/features/fast-scraping)
- [Open-source and Cloud operating model](https://docs.firecrawl.dev/contributing/open-source-or-cloud)
