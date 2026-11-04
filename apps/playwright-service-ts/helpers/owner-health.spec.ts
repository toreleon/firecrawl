import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OwnerHealthProbe } from './owner-health';

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
class Context extends EventEmitter {
  closeCalls = 0;
  async close() {
    this.closeCalls++;
    this.emit('close');
  }
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('concurrent health checks share disposal, with no completed-result cache', async () => {
  const gate = deferred();
  const contexts: Context[] = [];
  const health = new OwnerHealthProbe(async (scope) => {
    const context = new Context();
    contexts.push(context);
    scope.adopt(context);
    await gate.promise;
    return contexts.length;
  });
  const checks = Array.from({ length: 8 }, () => health.check());
  await turn();
  assert.equal(contexts.length, 1);
  gate.resolve();
  assert.deepEqual(await Promise.all(checks), Array(8).fill(1));
  assert.equal(contexts[0].closeCalls, 1);
  await turn();
  assert.equal(await health.check(), 2);
  assert.equal(contexts[1].closeCalls, 1);
});

test('late allocation is adopted and closed before another probe may allocate', async () => {
  const allocation = deferred();
  const context = new Context();
  let calls = 0,
    pageAllocations = 0;
  const health = new OwnerHealthProbe(async (scope) => {
    calls++;
    await allocation.promise;
    scope.adopt(context);
    pageAllocations++;
  }, 30);
  const first = health.check();
  await assert.rejects(first, /health probe timed out/);
  await assert.rejects(health.check(), /health probe timed out/);
  assert.equal(calls, 1);
  allocation.resolve();
  await turn();
  assert.equal(context.closeCalls, 1);
  assert.equal(pageAllocations, 0);
});

test('an unfinished page allocation retains the context until that operation drains', async () => {
  const page = deferred();
  const context = new Context();
  let calls = 0;
  const health = new OwnerHealthProbe(async (scope) => {
    calls++;
    scope.adopt(context);
    await page.promise;
    scope.check();
  }, 30);
  await assert.rejects(health.check(), /health probe timed out/);
  assert.equal(context.closeCalls, 0);
  await assert.rejects(health.check(), /health probe timed out/);
  assert.equal(calls, 1);
  page.resolve();
  await turn();
  assert.equal(context.closeCalls, 1);
});

test('missing close proof keeps health unhealthy without starting more probes', async () => {
  const closing = deferred();
  const contexts: Context[] = [];
  const health = new OwnerHealthProbe(async (scope) => {
    const context = new Context();
    contexts.push(context);
    if (contexts.length === 1)
      context.close = async () => {
        context.closeCalls++;
        await closing.promise;
        context.emit('close');
      };
    scope.adopt(context);
  }, 30);
  await assert.rejects(health.check(), /health probe timed out/);
  await assert.rejects(health.check(), /health probe timed out/);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].closeCalls, 1);
  closing.resolve();
  await turn();
  assert.equal(await health.check(), undefined);
  assert.equal(contexts.length, 2);
  assert.equal(contexts[1].closeCalls, 1);
});

test('observed context closure is sufficient when the close acknowledgement is lost', async () => {
  const context = new Context();
  context.close = () => {
    context.closeCalls++;
    context.emit('close');
    return new Promise(() => {});
  };
  const health = new OwnerHealthProbe(async (scope) => {
    scope.adopt(context);
    return 'ready';
  }, 100);
  assert.equal(await health.check(), 'ready');
  assert.equal(context.closeCalls, 1);
});

test('preparation failure disposes the adopted context and permits a fresh probe', async () => {
  const contexts: Context[] = [];
  const health = new OwnerHealthProbe(async (scope) => {
    const context = new Context();
    contexts.push(context);
    scope.adopt(context);
    if (contexts.length === 1) throw new Error('routing preparation failed');
  });
  await assert.rejects(health.check(), /routing preparation failed/);
  assert.equal(contexts[0].closeCalls, 1);
  await turn();
  await health.check();
  assert.equal(contexts[1].closeCalls, 1);
});

test('a rejected close without a close event cannot report healthy or accumulate contexts', async () => {
  const context = new Context();
  let calls = 0;
  context.close = async () => {
    context.closeCalls++;
    throw new Error('close outcome unknown');
  };
  const health = new OwnerHealthProbe(async (scope) => {
    calls++;
    scope.adopt(context);
  }, 30);
  await assert.rejects(health.check(), /health probe timed out/);
  await assert.rejects(health.check(), /health probe timed out/);
  assert.equal(calls, 1);
  assert.equal(context.closeCalls, 1);
  // An independently observed close releases the owned allocation.
  context.emit('close');
  await turn();
});
