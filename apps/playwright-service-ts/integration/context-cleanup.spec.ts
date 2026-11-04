import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  browserConfiguration,
  launchBrowser,
  BrowserEngine,
} from '../helpers/browser';
import { closeScrapePage } from '../helpers/page-cleanup';
import { closeServer, listen } from './support';

// Only owned loopback HTML is visited. This native helper test deliberately
// stalls the page-close command; it adds no production fault-injection hook.
test(
  'terminal context cleanup closes actual owned pages despite a stalled page-close RPC',
  { timeout: 45000 },
  async (t) => {
    const fixture = http.createServer((_req, res) =>
      res.end('<main>Owned context cleanup record 42</main>'),
    );
    const port = await listen(fixture);
    try {
      for (const engine of [
        'playwright',
        'patchright',
        'rebrowser',
        ...(process.env.TEST_CAMOUFOX === 'true' ? ['camoufox'] : []),
      ]) {
        await t.test(engine, async () => {
          const browser = await launchBrowser(
            browserConfiguration({
              BROWSER_ENGINE: engine as BrowserEngine,
              BROWSER_HEADLESS: 'true',
            }),
          );
          try {
            const context = await browser.newContext();
            const page = await context.newPage();
            await page.goto(`http://127.0.0.1:${port}`);
            const popup = await context.newPage();
            await popup.goto(`http://127.0.0.1:${port}`);
            let pageCommands = 0,
              contextClosed = false;
            context.once('close', () => {
              contextClosed = true;
            });
            const result = await closeScrapePage(
              {
                close: () => {
                  pageCommands++;
                  return new Promise(() => {});
                },
                isClosed: () => page.isClosed(),
              },
              context,
            );
            assert.equal(result.contextClosed, true);
            assert.equal(result.pageClosed, true);
            assert.equal(contextClosed, true);
            assert.equal(popup.isClosed(), true);
            assert.equal(context.pages().length, 0);
            assert.equal(pageCommands, 0);
          } finally {
            await browser.close();
          }
        });
      }
    } finally {
      await closeServer(fixture);
    }
  },
);
