import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { closeScrapePage, contextDisposal } from './page-cleanup';

test('terminal context disposal confirms closure without waiting on a stuck page-close command', async () => {
  let closed = false,
    pageCloses = 0;
  const context = Object.assign(new EventEmitter(), {
    close: async () => {
      closed = true;
      context.emit('close');
    },
  });
  const result = await closeScrapePage(
    {
      close: () => {
        pageCloses++;
        return new Promise(() => {});
      },
      isClosed: () => closed,
    },
    context,
    20,
  );
  assert.equal(pageCloses, 0);
  assert.equal(result.pageClosed, true);
  assert.equal(result.contextClosed, true);
});

test('an unfinished/rejected context command never invents a page-close observation', async () => {
  for (const close of [
    () => new Promise<void>(() => {}),
    async () => {
      throw new Error('protocol closed');
    },
  ]) {
    const result = await closeScrapePage(
      { close: () => new Promise(() => {}), isClosed: () => false },
      Object.assign(new EventEmitter(), { close }),
      20,
    );
    assert.equal(result.pageClosed, false);
    assert.equal(result.contextClosed, false);
    assert.equal(result.cleanupFinished, false);
  }
});

test('a fulfilled command without the context-close event is not disposal proof', async () => {
  const context = Object.assign(new EventEmitter(), { close: async () => {} });
  const result = await closeScrapePage(
    { close: async () => {}, isClosed: () => true },
    context,
    20,
  );
  assert.equal(result.pageClosed, true);
  assert.equal(result.contextClosed, false);
  assert.equal(result.cleanupFinished, false);
});

test('a context-close event during the page fallback is included in the receipt', async () => {
  let closed = false;
  const context = Object.assign(new EventEmitter(), {
    close: () => new Promise<void>(() => {}),
  });
  const result = await closeScrapePage(
    {
      close: async () => {
        closed = true;
        context.emit('close');
      },
      isClosed: () => closed,
    },
    context,
    20,
  );
  assert.equal(result.pageClosed, true);
  assert.equal(result.contextClosed, true);
  assert.equal(result.cleanupFinished, true);
});

test('all cleanup callers share one disposal command and its actual close event', async () => {
  let commands = 0;
  const context = Object.assign(new EventEmitter(), {
    close: async () => {
      commands++;
      throw new Error('lost acknowledgement');
    },
  });
  const disposal = contextDisposal(context);
  assert.equal(contextDisposal(context), disposal);
  const first = disposal.close();
  assert.equal(disposal.close(), first);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commands, 1);
  assert.equal(disposal.confirmed, false);
  context.emit('close');
  await first;
  assert.equal(disposal.confirmed, true);
  await disposal.close();
  assert.equal(commands, 1);
});

test('retained and nonterminal cleanup closes only the supplied page', async () => {
  let closed = false;
  const result = await closeScrapePage(
    {
      close: async () => {
        closed = true;
      },
      isClosed: () => closed,
    },
    undefined,
    20,
  );
  assert.equal(result.pageClosed, true);
  assert.equal(result.contextClosed, undefined);
});
