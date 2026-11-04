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

const arg = (name: string, fallback: string) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;

async function main() {
  const bytes = await readFile('benchmarks/frontier-2026-10-30.json');
  const dataset = JSON.parse(bytes.toString());
  const names = arg(
    'targets',
    'arxiv,github,etsy,canadagoose,aa,booking.com,mouser,Reddit,Skyscanner,temu,marketwatch,TikTok',
  ).split(',');
  const targets: WafTarget[] = names.map((name) => {
    const target = dataset.targets.find((row: WafTarget) => row.name === name);
    if (!target) throw new Error(`Unknown target ${name}`);
    return target;
  });
  if (new Set(names).size !== names.length)
    throw new Error('Duplicate targets');
  const timeout = Number(arg('timeout', '30000'));
  const rounds = Number(arg('attempts', '2'));
  if (
    !Number.isInteger(timeout) ||
    timeout < 10000 ||
    timeout > 90000 ||
    !Number.isInteger(rounds) ||
    rounds < 2 ||
    rounds > 5
  )
    throw new Error('Invalid timeout/attempt count');
  const profiles = [
    {
      name: 'legacy',
      url: arg('legacy', 'http://127.0.0.1:33039'),
      ready: false,
      sessions: false,
    },
    {
      name: 'revised_compatible',
      url: arg('revised', 'http://127.0.0.1:33040'),
      ready: false,
      sessions: false,
    },
    {
      name: 'revised_readiness',
      url: arg('revised', 'http://127.0.0.1:33040'),
      ready: true,
      sessions: false,
    },
    {
      name: 'revised_no_adblock',
      url: arg('unfiltered', 'http://127.0.0.1:33041'),
      ready: true,
      sessions: false,
    },
    {
      name: 'revised_sessions',
      url: arg('unfiltered', 'http://127.0.0.1:33041'),
      ready: true,
      sessions: true,
    },
  ];
  const health: Record<string, unknown> = {};
  for (const url of new Set(profiles.map((profile) => profile.url))) {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Unhealthy service ${url}`);
    health[url] = await response.json();
  }
  const output = path.resolve(
    arg('out', `../../_local/anti-bot/reliability-${Date.now()}`),
  );
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  await mkdir(path.join(output, 'evidence'));
  await writeFile(path.join(output, 'fixtures.json'), bytes);
  const manifest = {
    startedAt: new Date().toISOString(),
    sourceCommit: dataset.sourceCommit,
    fixtureSha256: createHash('sha256').update(bytes).digest('hex'),
    targets: names,
    rounds,
    timeoutMs: timeout,
    serviceTimeoutMs: timeout - 6000,
    concurrency: 2,
    profiles,
    health,
    clientRetries: 0,
    serviceMaxAttempts: 1,
    evidence: 'all service responses, session capability tokens omitted',
    ordering:
      'For each round/target rotate profile order by (round index + target index) modulo five. Two workers. Same current scorer for all profiles.',
    caveats: [
      'Diagnostic subset selected for observed failures plus successful controls; not a new overall 100-site success rate.',
      'Session profile is cold on first visit and reused on later rounds, without a separate cookie warm-up.',
      'All profiles share direct host egress and may influence site rate limits. Rotating order reduces but does not eliminate this interference.',
      'Readiness compares a combined DOMContentLoaded/text strategy with legacy load/2-second wait.',
      'No commercial provider or CAPTCHA-solving API is called.',
    ],
  };
  await writeFile(
    path.join(output, 'manifest.json'),
    JSON.stringify({ ...manifest, status: 'running' }, null, 2),
  );
  const tasks = Array.from({ length: rounds }, (_, round) =>
    targets.flatMap((target, index) =>
      profiles.map((_, j) => ({
        target,
        profile: profiles[(j + round + index) % profiles.length],
        attempt: round + 1,
      })),
    ),
  ).flat();
  const tokens = new Map<string, string>();
  const timing = new BenchmarkTiming();
  const timer = setInterval(() => {
    if (timing.sample()) console.error('Timing gap detected');
  }, 1000);
  const log = await open(path.join(output, 'attempts.jsonl'), 'wx');
  const results: (WafAttempt & { profile: string; sessionReused: boolean })[] =
    [];
  let cursor = 0;
  try {
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        while (cursor < tasks.length) {
          const index = cursor++;
          const { target, profile, attempt } = tasks[index];
          await new Promise((resolve) => setTimeout(resolve, 500));
          const token = profile.sessions ? tokens.get(target.name) : undefined;
          const start = Date.now();
          const observation = await requestScrape(
            profile.url,
            target,
            timeout,
            profile.ready ? 0 : 2000,
            {
              wait_until: profile.ready ? 'domcontentloaded' : 'load',
              max_attempts: 1,
              ...(profile.ready && {
                wait_for_text: target.containsText,
                readiness_timeout: 5000,
              }),
              ...(profile.sessions &&
                (token ? { session_id: token } : { create_session: true })),
            },
            timeout - 6000,
          );
          if (
            profile.sessions &&
            typeof observation.body.sessionId === 'string'
          )
            tokens.set(target.name, observation.body.sessionId);
          const scored = scoreObservation(target, observation);
          const evidenceFile = `evidence/${String(index + 1).padStart(3, '0')}.json`;
          const { sessionId, ...safeBody } = observation.body;
          await writeFile(
            path.join(output, evidenceFile),
            JSON.stringify({ ...observation, body: safeBody }),
          );
          const result = {
            target: target.name,
            url: target.url,
            wafLabel: target.antibot ?? 'unclassified',
            profile: profile.name,
            sessionReused: !!token,
            attempt,
            startedAt: new Date(start).toISOString(),
            latencyMs: Date.now() - start,
            evidenceFile,
            ...scored,
          };
          results.push(result);
          await log.appendFile(JSON.stringify(result) + '\n');
          console.log(
            `${results.length}/${tasks.length} ${target.name} ${profile.name}: raw=${result.frontierPass} normalized=${result.normalizedPass} ${result.failureReason ?? 'success'}`,
          );
        }
      }),
    );
    const report = {
      ...manifest,
      status: 'complete',
      finishedAt: new Date().toISOString(),
      timingIntegrity: timing.snapshot(),
      byProfile: Object.fromEntries(
        profiles.map((profile) => [
          profile.name,
          summarizeAttempts(
            results.filter((row) => row.profile === profile.name),
          ).overall,
        ]),
      ),
      attempts: results,
    };
    await writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(report, null, 2),
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
      ),
    );
    console.log(
      JSON.stringify(
        {
          report: path.join(output, 'report.json'),
          timingIntegrity: report.timingIntegrity,
          byProfile: report.byProfile,
        },
        null,
        2,
      ),
    );
  } finally {
    clearInterval(timer);
    await log.close();
    await Promise.allSettled(
      [...tokens.values()].map((token) =>
        fetch(`${profiles[4].url}/sessions/${token}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(3000),
        }),
      ),
    );
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
