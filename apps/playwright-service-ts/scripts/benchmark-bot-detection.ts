import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  startFixtures,
  startService,
  scrape,
  readProbe,
} from '../integration/support';

async function main() {
  const engineArg = process.argv.find((arg) => arg.startsWith('--engines='));
  const engines = (
    engineArg?.split('=')[1] ?? 'playwright,patchright,rebrowser'
  ).split(',');
  const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
  const output = outputArg?.slice('--output='.length);
  const live = process.argv.includes('--live');
  const headful = process.argv.includes('--headful');
  const channel =
    process.argv.find((arg) => arg.startsWith('--channel='))?.split('=')[1] ??
    'chromium';
  const fixtures = await startFixtures();
  const results: Record<string, unknown>[] = [];
  try {
    for (const engine of engines) {
      const service = await startService({
        BROWSER_ENGINE: engine,
        BROWSER_HEADLESS: headful ? 'false' : 'true',
        BROWSER_CHANNEL: channel,
      });
      try {
        const start = Date.now();
        const result = await scrape(service.baseUrl, `${fixtures.url}/gate`);
        const probe = readProbe(result.body.content ?? '');
        results.push({
          engine,
          apiStatus: result.status,
          pageStatus: result.body.pageStatusCode,
          protectedContentRetrieved: result.body.content.includes(
            'id="protected-content"',
          ),
          latencyMs: Date.now() - start,
          probe,
        });
        if (live) {
          for (const url of [
            'https://bot.sannysoft.com/',
            'https://bot-detector.rebrowser.net/',
          ]) {
            const liveStart = Date.now();
            try {
              const result = await scrape(service.baseUrl, url, {
                timeout: 25000,
                wait_after_load: 4000,
              });
              const html = result.body.content ?? '';
              const renderedHtml = html.replace(
                /<script\b[^>]*>[\s\S]*?<\/script>/gi,
                '',
              );
              const rows = [
                ...renderedHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi),
              ]
                .map((row) => {
                  const cells = [
                    ...row[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi),
                  ];
                  return cells.length >= 2
                    ? {
                        name: cells[0][2].replace(/<[^>]*>/g, '').trim(),
                        result: cells[1][2]
                          .replace(/<[^>]*>/g, '')
                          .replace(/\s+/g, ' ')
                          .trim()
                          .slice(0, 500),
                        class: cells[1][1].match(/class="([^"]*)"/)?.[1],
                      }
                    : null;
                })
                .filter(Boolean);
              const detections = html.match(
                /<[^>]+id="detections-json"[^>]*>([\s\S]*?)<\//,
              )?.[1];
              results.push({
                engine,
                url,
                apiStatus: result.status,
                pageStatus: result.body.pageStatusCode,
                pageError: result.body.pageError,
                landedUrl: result.body.url,
                latencyMs: Date.now() - liveStart,
                rows,
                detections,
                note: url.includes('rebrowser')
                  ? 'Passive page load through the service; checks requiring exposeFunction/addInitScript/evaluate are not triggered.'
                  : undefined,
              });
            } catch (error) {
              results.push({
                engine,
                url,
                error: String(error),
                latencyMs: Date.now() - liveStart,
              });
            }
          }
        }
      } finally {
        await service.stop();
      }
    }
  } finally {
    await fixtures.close();
  }
  const report = {
    recordedAt: new Date().toISOString(),
    headless: !headful,
    channel,
    scope:
      'Controlled browser service HTTP test and optional public diagnostics; not a general anti-bot bypass benchmark',
    results,
  };
  if (output) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
