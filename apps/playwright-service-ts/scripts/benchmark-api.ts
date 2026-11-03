import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  validateProfiles,
  redact,
  requestApiScrape,
  apiOutputMetrics,
  apiRequestBody,
  sha256,
} from '../helpers/api-benchmark';
import {
  scoreObservation,
  summarizeAttempts,
  WafTarget,
  WafAttempt,
} from '../helpers/waf-benchmark';
import { BenchmarkTiming } from '../helpers/benchmark-timing';

const arg = (name: string, fallback: string) =>
  process.argv
    .find((x) => x.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
const integer = (name: string, fallback: string, min: number, max: number) => {
  const value = Number(arg(name, fallback));
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Invalid --${name}; expected ${min}..${max}`);
  return value;
};
let credentialValues: string[] = [];

async function main() {
  const profileBytes = await readFile(
    arg('profiles', 'benchmarks/api-profiles.example.json'),
  );
  const profiles = validateProfiles(JSON.parse(profileBytes.toString()));
  const fixtureBytes = await readFile(
    arg('fixtures', 'benchmarks/frontier-2026-10-30.json'),
  );
  const dataset = JSON.parse(fixtureBytes.toString());
  const filter = arg('targets', '').split(',').filter(Boolean);
  if (!Array.isArray(dataset.targets))
    throw new Error('Missing target fixtures');
  const targets: WafTarget[] = dataset.targets.filter(
    (t: WafTarget) => !filter.length || filter.includes(t.name),
  );
  if (
    !targets.length ||
    new Set(targets.map((t) => t.name)).size !== targets.length ||
    filter.some((x) => !targets.some((t) => t.name === x))
  )
    throw new Error('Empty, duplicate or unknown targets');
  for (const t of targets) {
    if (
      !t.name ||
      typeof t.containsText !== 'string' ||
      !t.containsText.trim() ||
      !['https:', 'http:'].includes(new URL(t.url).protocol)
    )
      throw new Error('Invalid target');
  }
  const attemptsPerTarget = integer('attempts', '1', 1, 20);
  const concurrency = integer('concurrency', '2', 1, 8);
  const timeoutMs = integer('timeout', '90000', 1000, 120000);
  const delayMs = integer('delay', '500', 0, 10000);
  const maxRequests = integer('max-requests', '40', 1, 10000);
  const maxPerProfile = integer('max-requests-per-profile', '20', 1, 2000);
  const expectedRequests = targets.length * attemptsPerTarget * profiles.length;
  if (
    expectedRequests > maxRequests ||
    targets.length * attemptsPerTarget > maxPerProfile
  )
    throw new Error(
      'Request budget exceeded before dispatch; raise explicit request limits or reduce target/attempt count',
    );
  const keys = new Map(
    profiles.map((p) => {
      const key = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
      if (p.apiKeyEnv && !key)
        throw new Error(
          `Missing API credential environment variable for ${p.name}`,
        );
      return [p.name, key];
    }),
  );
  const secrets = [...keys.values()].filter((x): x is string => !!x);
  credentialValues = secrets;
  const output = path.resolve(
    arg(
      'out',
      `../../_local/anti-bot/api-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    ),
  );
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output, { recursive: false });
  await mkdir(path.join(output, 'evidence'));
  const save = (file: string, value: unknown) =>
    writeFile(path.join(output, file), redact(value, secrets) + '\n', {
      mode: 0o600,
    });
  const startedAt = new Date().toISOString();
  const manifest = {
    startedAt,
    fixtureSha256: sha256(fixtureBytes),
    profilesSha256: sha256(profileBytes),
    dataset: dataset.name,
    source: dataset.source,
    sourceCommit: dataset.sourceCommit,
    targets: targets.map((t) => t.name),
    profiles,
    attemptsPerTarget,
    concurrency,
    timeoutMs,
    delayMs,
    expectedRequests,
    maxRequests,
    maxRequestsPerProfile: maxPerProfile,
    clientRetries: 0,
    commonRequest: apiRequestBody(
      { name: 'common', baseUrl: 'https://unused.invalid' },
      '<target URL>',
      timeoutMs,
    ),
    scheduling:
      'Round-major, target-major; rotate profile order by target and round. At most concurrency HTTP requests in flight.',
    sourceHashes: Object.fromEntries(
      await Promise.all(
        [
          'helpers/api-benchmark.ts',
          'helpers/waf-benchmark.ts',
          'helpers/bot-detection.ts',
          'scripts/benchmark-api.ts',
        ].map(async (file) => [
          file,
          sha256(await readFile(path.resolve(__dirname, '..', file))),
        ]),
      ),
    ),
    limits: [
      'Fresh API results only; maxAge=0 and storeInCache=false. Returned cache metadata is retained when provided.',
      'Fork egress and hosted infrastructure may differ; this is an outcome comparison, not a causal proxy or browser experiment.',
      'Missing target status or rawHtml is not inferred as success. Markdown marker presence is supplementary, not extraction F1.',
      'WAF categories are fixture publisher labels, not proof of a live WAF rule.',
      'Request limits bound dispatch count, not provider credits; provider-side retries and charges can differ.',
    ],
  };
  // Preserve original fixture bytes for the manifest digest.
  await writeFile(path.join(output, 'fixtures.json'), fixtureBytes, {
    mode: 0o600,
  });
  await save('manifest.json', { ...manifest, status: 'running' });
  const log = await open(path.join(output, 'attempts.jsonl'), 'wx', 0o600);
  const tasks = Array.from({ length: attemptsPerTarget }, (_, round) =>
    targets.flatMap((target, index) =>
      profiles.map((_, offset) => ({
        target,
        attempt: round + 1,
        profile: profiles[(offset + round + index) % profiles.length],
      })),
    ),
  ).flat();
  type Row = WafAttempt &
    ReturnType<typeof apiOutputMetrics> & {
      profile: string;
      payloadSha256: string;
    };
  const rows: Row[] = [];
  const timing = new BenchmarkTiming();
  const timer = setInterval(() => timing.sample(), 1000);
  let cursor = 0;
  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (cursor < tasks.length) {
          const taskIndex = cursor++;
          const { target, attempt, profile } = tasks[taskIndex];
          if (delayMs)
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          const start = Date.now();
          const result = await requestApiScrape(
            profile,
            target.url,
            timeoutMs,
            keys.get(profile.name),
          );
          // Sanitize before hashing, grading, logging or retaining provider data.
          const evidence = JSON.parse(redact(result, secrets));
          const row: Row = {
            profile: profile.name,
            target: target.name,
            url: target.url,
            wafLabel: target.antibot ?? 'unclassified',
            attempt,
            startedAt: new Date(start).toISOString(),
            latencyMs: Date.now() - start,
            ...scoreObservation(target, evidence.observation),
            ...apiOutputMetrics(evidence.payload, target.containsText),
            payloadSha256: sha256(JSON.stringify(evidence.payload)),
            evidenceFile: `evidence/${String(taskIndex + 1).padStart(4, '0')}-${profile.name}.json`,
          };
          await save(row.evidenceFile!, evidence);
          rows.push(row);
          await log.appendFile(JSON.stringify(row) + '\n');
          console.log(
            `${rows.length}/${expectedRequests} ${profile.name}/${target.name}/${attempt}: normalized=${row.normalizedPass} ${row.failureReason ?? 'success'} ${row.latencyMs}ms`,
          );
        }
      }),
    );
    const byProfile = Object.fromEntries(
      profiles.map((p) => {
        const selected = rows.filter((r) => r.profile === p.name);
        return [
          p.name,
          {
            ...summarizeAttempts(selected),
            apiSuccesses: selected.filter((r) => r.apiSuccess).length,
            markdownMarkerPasses: selected.filter(
              (r) => r.markdownMarkerPresent,
            ).length,
            returnedCreditsUsed: selected.reduce(
              (sum, r) => sum + (r.creditsUsed ?? 0),
              0,
            ),
            unknownCreditsCount: selected.filter((r) => r.creditsUsed === null)
              .length,
            cacheStateCounts: selected.reduce<Record<string, number>>(
              (counts, r) => {
                counts[r.cacheState] = (counts[r.cacheState] ?? 0) + 1;
                return counts;
              },
              {},
            ),
          },
        ];
      }),
    );
    const finishedAt = new Date().toISOString();
    const report = {
      ...manifest,
      status: 'complete',
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      timingIntegrity: timing.snapshot(),
      byProfile,
      attempts: rows,
    };
    await save('report.json', report);
    await save('manifest.json', {
      ...manifest,
      status: 'complete',
      finishedAt,
      timingIntegrity: report.timingIntegrity,
    });
    console.log(
      redact(
        {
          report: path.join(output, 'report.json'),
          byProfile,
          timingIntegrity: report.timingIntegrity,
        },
        secrets,
      ),
    );
  } finally {
    clearInterval(timer);
    await log.close();
  }
}
main().catch((error) => {
  console.error(
    `API benchmark failed: ${JSON.parse(redact(String(error), credentialValues))}`,
  );
  process.exitCode = 1;
});
