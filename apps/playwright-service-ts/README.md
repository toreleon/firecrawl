# Browser scrape service

The existing Firecrawl Playwright HTTP adapter can use three open-source drivers:

| `BROWSER_ENGINE`      | Driver                          | Use                                                                       |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| `rebrowser` (default) | `rebrowser-playwright` 1.64.101 | Patched Chromium automation, including CDP and storage-partitioning fixes |
| `patchright`          | Patchright 1.64.2               | Alternative patched Chromium driver                                       |
| `playwright`          | Playwright 1.64.1 (lockfile)    | Stock driver for compatibility and comparison                             |

The service keeps a native browser identity instead of generating a random
Safari/mobile user-agent on desktop Chromium. It uses full Chromium, a native
viewport, isolated request contexts, and the existing SSRF-checking proxy.
Explicit caller-supplied headers and user-agents are still honored. A custom UA
can contradict the browser's platform and client hints; omit it for the default
coherent identity.

Known challenge interstitials produce `pageError` and `botDetection`, including
when the target returns HTTP 200. Ordinary contact forms containing CAPTCHA
widgets are not treated as interstitials. This classifier recognizes specific
signals; it does not identify every possible challenge.

## Install and run locally

Use Node >=22.13 and the pinned pnpm 11.4.0 from this directory:

```sh
pnpm install --frozen-lockfile
node node_modules/playwright/cli.js install chromium
node node_modules/patchright/cli.js install chromium
node node_modules/rebrowser-playwright/cli.js install chromium
pnpm dev
```

Both Playwright packages publish the same CLI binary name, so the explicit paths
above ensure each driver's browser dependencies are installed.

Local processes default to `BROWSER_HEADLESS=true`. If Chrome is already
installed, use the native headful browser for fewer headless signals:

```sh
BROWSER_ENGINE=rebrowser BROWSER_HEADLESS=false BROWSER_CHANNEL=chrome pnpm dev
```

`BROWSER_CHANNEL` defaults to `chromium`. The `chrome` channel requires a separate
Chrome installation. Invalid engine/headless values fail at startup.

## Docker and Firecrawl

The Docker image and root Compose service default to Rebrowser with headful
Chromium under Xvfb (`BROWSER_HEADLESS=false`). Compose sets `init: true` for
signal handling and process reaping. Include `--init` with a standalone image:

```sh
docker build -t firecrawl-browser apps/playwright-service-ts
docker run --rm --init -e PORT=3000 -p 127.0.0.1:3003:3000 firecrawl-browser
```

The existing Compose `PLAYWRIGHT_MICROSERVICE_URL` already points to this
service. For a host-based Firecrawl API, set
`PLAYWRIGHT_MICROSERVICE_URL=http://localhost:3003/scrape` in `apps/api/.env`.
No Fire-engine subscription is needed for these browser drivers.
`BROWSER_ENGINE` selects a driver; the API's `proxy: "stealth"` option selects a
different Fire-engine capability and does not enable this integration.

Existing `PROXY_SERVER`, `PROXY_USERNAME`, and `PROXY_PASSWORD` settings remain
supported. Browser patching and network exit reputation are separate factors.

## HTTP contract

```sh
curl -X POST http://localhost:3003/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","wait_after_load":1000,"timeout":15000}'
```

Optional fields include `headers`, `check_selector`, and
`skip_tls_verification`. Results keep `content`, `pageStatusCode`, `contentType`,
`url`, and optional `pageError`. Additional diagnostics are `browserEngine` and
optional `botDetection`. `/health` includes the engine, headless mode, and
active-page count.

## Verify

```sh
pnpm build
pnpm test
pnpm test:integration
pnpm benchmark:bots --output=../../_local/anti-bot/controlled.json
pnpm benchmark:bots --live --headful --channel=chrome --output=../../_local/anti-bot/live.json
```

Integration tests run the actual HTTP service and real browsers with all three
drivers. Test-only local fixtures explicitly enable `ALLOW_LOCAL_WEBHOOKS` in
their child processes; a separate case verifies default private-target denial.
Production retains private-address, redirect/subresource and pinned-DNS checks.
An upstream proxy must also enforce its own egress restrictions.

Public diagnostics are optional network experiments, not CI assertions. The
benchmark records failed requests and remaining detection signals. The Rebrowser
page is loaded passively, matching this scraper's API usage; four checks requiring
extra evaluate/init-script/exposed-function calls remain untriggered and are not
counted as passes.

See [the research and verification record](../../docs/anti-bot-research.md) for
the selection evidence and limits. These tests do not establish universal WAF
or CAPTCHA bypass, or a success rate on production target websites.
