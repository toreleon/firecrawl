import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { apiOutputMetrics, sha256 } from '../helpers/api-benchmark';
import { scoreObservation, summarizeAttempts } from '../helpers/waf-benchmark';

async function main() {
  const arg = process.argv.find((s) => s.startsWith('--run='));
  if (!arg)
    throw new Error('Expected --run=<completed API benchmark directory>');
  const root = path.resolve(arg.slice(6));
  const report = JSON.parse(
    await readFile(path.join(root, 'report.json'), 'utf8'),
  );
  const fixtureBytes = await readFile(path.join(root, 'fixtures.json'));
  assert.equal(sha256(fixtureBytes), report.fixtureSha256);
  assert.equal(report.status, 'complete');
  assert.equal(report.timingIntegrity.valid, true);
  const fixtures = JSON.parse(fixtureBytes.toString());
  const log = (await readFile(path.join(root, 'attempts.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  const order = (a: any, b: any) =>
    `${a.profile}/${a.target}/${a.attempt}`.localeCompare(
      `${b.profile}/${b.target}/${b.attempt}`,
    );
  assert.deepEqual([...log].sort(order), [...report.attempts].sort(order));
  assert.equal(log.length, report.expectedRequests);
  const expected = new Set<string>();
  for (const p of report.profiles)
    for (const name of report.targets)
      for (let i = 1; i <= report.attemptsPerTarget; i++)
        expected.add(`${p.name}/${name}/${i}`);
  assert.equal(expected.size, log.length);
  for (const row of log) {
    assert.ok(
      expected.delete(`${row.profile}/${row.target}/${row.attempt}`),
      'Unexpected or duplicate profile/target/attempt',
    );
    const target = fixtures.targets.find((t: any) => t.name === row.target);
    assert.equal(target.url, row.url);
    assert.ok(/^evidence\/[a-zA-Z0-9_-]+\.json$/.test(row.evidenceFile));
    const evidence = JSON.parse(
      await readFile(path.join(root, row.evidenceFile), 'utf8'),
    );
    assert.equal(sha256(JSON.stringify(evidence.payload)), row.payloadSha256);
    for (const [key, value] of Object.entries({
      ...scoreObservation(target, evidence.observation),
      ...apiOutputMetrics(evidence.payload, target.containsText),
    }))
      assert.deepEqual(row[key], value, `${row.profile}/${row.target}/${key}`);
  }
  assert.equal(expected.size, 0);
  for (const p of report.profiles) {
    const rows = log.filter((r) => r.profile === p.name);
    const scores = summarizeAttempts(rows);
    assert.deepEqual(scores.overall, report.byProfile[p.name].overall);
    assert.deepEqual(scores.byWafLabel, report.byProfile[p.name].byWafLabel);
  }
  for (const [file, hash] of Object.entries(report.sourceHashes))
    assert.equal(
      sha256(await readFile(path.resolve(__dirname, '..', file))),
      hash,
      `Source changed since run: ${file}`,
    );
  const result = {
    status: 'complete',
    attempts: log.length,
    uniquePairs: true,
    allEvidenceHashesMatch: true,
    allScoresReplay: true,
    sourceHashesMatch: true,
    networkRequests: 0,
  };
  await writeFile(
    path.join(root, 'score-replay-audit.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result));
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
