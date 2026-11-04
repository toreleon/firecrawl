import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeScrapePage } from './page-cleanup';

test('terminal context disposal confirms closure without waiting on a stuck page-close command', async () => {
  let closed = false,
    pageCloses = 0;
  const result = await closeScrapePage(
    {
      close: () => {
        pageCloses++;
        return new Promise(() => {});
      },
      isClosed: () => closed,
    },
    {
      close: async () => {
        closed = true;
      },
    },
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
      { close },
      20,
    );
    assert.equal(result.pageClosed, false);
    assert.equal(result.contextClosed, false);
  }
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
