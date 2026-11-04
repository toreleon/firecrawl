import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { BenchmarkTiming } from '../helpers/benchmark-timing';
import {
  requestScrape,
  scoreObservation,
  summarizeAttempts,
  WafAttempt,
  WafTarget,
} from '../helpers/waf-benchmark';

const argument = (name: string, fallback: string) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
const positive = (name: string, fallback: string, maximum: number) => {
  const value = Number(argument(name, fallback));
  if (!Number.isInteger(value) || value < 1 || value > maximum)
    throw new Error(`Invalid --${name}; expected 1..${maximum}`);
  return value;
};

async function main() {
  const fixtureFile = argument(
    'fixtures',
    'benchmarks/frontier-2026-10-30.json',
  );
  const fixtureBytes = await readFile(fixtureFile);
  const dataset = JSON.parse(fixtureBytes.toString()) as {
    name: string;
    source: string;
    sourceCommit: string;
    targets: WafTarget[];
  };
  const targetFilter = argument('targets', '').split(',').filter(Boolean);
  const targets = dataset.targets.filter(
    (target) => !targetFilter.length || targetFilter.includes(target.name),
  );
  if (
    !targets.length ||
    new Set(targets.map((target) => target.name)).size !== targets.length
  )
    throw new Error('Empty or duplicate target set');
  for (const target of targets) {
    if (
      !target.name ||
      !target.containsText ||
      !['http:', 'https:'].includes(new URL(target.url).protocol)
    )
      throw new Error('Invalid target fixture');
  }
  if (
    targetFilter.some((name) => !targets.some((target) => target.name === name))
  )
    throw new Error('Unknown --targets name');
  const attemptsPerTarget = positive('attempts', '1', 20);
  const concurrency = positive('concurrency', '2', 8);
  const timeoutMs = positive('timeout', '90000', 120000);
  const waitMs = Number(argument('wait', '2000'));
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs >= timeoutMs / 2)
    throw new Error('Invalid --wait');
  const serviceUrl = argument('service', 'http://127.0.0.1:3003');
  const readiness = argument('readiness', 'none');
  if (!['none', 'text'].includes(readiness))
    throw new Error('Invalid --readiness');
  const readinessTimeout = positive('readiness-timeout', '5000', 30000);
  const waitUntil = argument('wait-until', 'load');
  if (!['load', 'domcontentloaded'].includes(waitUntil))
    throw new Error('Invalid --wait-until');
  const maxAttempts = positive('max-attempts', '1', 3);
  const consent = argument('consent', 'off');
  if (!['off', 'rejectNonEssential', 'acceptAll'].includes(consent))
    throw new Error('Invalid --consent');
  const workflow = argument('workflow', 'none');
  if (!['none', 'auto', 'bestbuy-us@1', 'product-details@1'].includes(workflow))
    throw new Error('Invalid --workflow');
  const evidence = argument('evidence', 'failures');
  if (!['all', 'failures'].includes(evidence))
    throw new Error('Invalid --evidence');
  const healthResponse = await fetch(`${serviceUrl}/health`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!healthResponse.ok) throw new Error('Browser service is unhealthy');
  const health = await healthResponse.json();
  if (
    (consent !== 'off' && !health.capabilities?.consent) ||
    (workflow !== 'none' && !health.capabilities?.workflows?.includes(workflow))
  )
    throw new Error(
      'Browser service does not advertise the requested workflow capabilities',
    );
  const startedAt = new Date().toISOString();
  const output = path.resolve(
    argument(
      'out',
      `../../_local/anti-bot/waf-${startedAt.replace(/[:.]/g, '-')}`,
    ),
  );
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output, { recursive: false });
  await mkdir(path.join(output, 'evidence'));
  await writeFile(path.join(output, 'fixtures.json'), fixtureBytes);
  const attemptsFile = await open(path.join(output, 'attempts.jsonl'), 'wx');
  const manifest = {
    startedAt,
    dataset: dataset.name,
    source: dataset.source,
    sourceCommit: dataset.sourceCommit,
    fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'),
    profile: argument('profile', 'unspecified'),
    imageId: argument('image-id', 'unspecified'),
    serviceUrl,
    serviceHealth: health,
    attemptsPerTarget,
    concurrency,
    timeoutMs,
    waitMs,
    targetCount: targets.length,
    expectedRequests: targets.length * attemptsPerTarget,
    clientRetries: 0,
    serviceMaxAttempts: maxAttempts,
    consent,
    workflow,
    readiness,
    readinessTimeoutMs: readinessTimeout,
    waitUntil,
    delayBeforeEachRequestMs: 500,
    evidencePolicy: evidence,
    freshContextPerRequest: true,
    scoring: {
      frontier:
        'Service 2xx + target 2xx + expected case-insensitive raw-body substring.',
      screened:
        'Frontier pass plus no reported error/challenge and marker in text after removing script/style/noscript/comments. This is not a CSS visibility or field-accuracy test.',
      normalized:
        'Service 2xx + target 2xx + normalized text marker, no reported error or recognized challenge. Independent of raw substring; not a CSS visibility or field-accuracy test.',
    },
    caveats: [
      'WAF groups are publisher labels, not proof a live challenge was active.',
      'One attempt per site is a pilot, not a five-attempt reproduction.',
      'No inference of an unknown transport/service error as a WAF block.',
      'No commercial API calls are made by this runner.',
    ],
  };
  await writeFile(
    path.join(output, 'manifest.json'),
    JSON.stringify({ ...manifest, status: 'running' }, null, 2) + '\n',
  );
  const tasks = Array.from({ length: attemptsPerTarget }, (_, index) =>
    targets.map((target) => ({ target, attempt: index + 1 })),
  ).flat();
  const results: WafAttempt[] = [];
  const timing = new BenchmarkTiming();
  const timingTimer = setInterval(() => {
    if (timing.sample())
      console.error(
        'Timing gap detected: do not compare this run with uninterrupted runs.',
      );
  }, 1000);
  let cursor = 0;
  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (cursor < tasks.length) {
          const taskIndex = cursor++;
          const { target, attempt } = tasks[taskIndex];
          await new Promise((resolve) => setTimeout(resolve, 500));
          const start = Date.now();
          const observation = await requestScrape(
            serviceUrl,
            target,
            timeoutMs,
            waitMs,
            {
              wait_until: waitUntil,
              max_attempts: maxAttempts,
              consent,
              workflow,
              ...(readiness === 'text' && {
                wait_for_text: target.containsText,
                readiness_timeout: readinessTimeout,
              }),
            },
          );
          const result: WafAttempt = {
            target: target.name,
            url: target.url,
            wafLabel: target.antibot ?? 'unclassified',
            attempt,
            startedAt: new Date(start).toISOString(),
            latencyMs: Date.now() - start,
            ...scoreObservation(target, observation),
          };
          if (evidence === 'all' || !result.screenedPass) {
            const evidenceFile = `evidence/${String(taskIndex + 1).padStart(3, '0')}-${target.name.replace(/[^a-z0-9_-]/gi, '_')}-${attempt}.json`;
            await writeFile(
              path.join(output, evidenceFile),
              JSON.stringify(observation, null, 2) + '\n',
            );
            result.evidenceFile = evidenceFile;
          }
          results.push(result);
          await attemptsFile.appendFile(JSON.stringify(result) + '\n');
          console.log(
            `${results.length}/${tasks.length} ${target.name}: frontier=${result.frontierPass} screened=${result.screenedPass} ${result.failureReason ?? 'success'} ${result.latencyMs}ms`,
          );
        }
      }),
    );
    const report = {
      ...manifest,
      status: 'complete',
      finishedAt: new Date().toISOString(),
      timingIntegrity: timing.snapshot(),
      ...summarizeAttempts(results),
      attempts: results,
    };
    await writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    await writeFile(
      path.join(output, 'manifest.json'),
      JSON.stringify(
        {
          ...manifest,
          status: 'complete',
          finishedAt: report.finishedAt,
          timingIntegrity: report.timingIntegrity,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      JSON.stringify(
        {
          report: path.join(output, 'report.json'),
          timingIntegrity: report.timingIntegrity,
          ...summarizeAttempts(results),
        },
        null,
        2,
      ),
    );
  } finally {
    clearInterval(timingTimer);
    await attemptsFile.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
