import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lowesProductIdentity } from './lowes-search';

test('identifier search accepts only a canonical product on the observed storefront', () => {
  assert.deepEqual(
    lowesProductIdentity(
      'https://www.lowes.com/pd/Product/5010000042?from=search#details',
    ),
    { origin: 'https://www.lowes.com', id: '5010000042' },
  );
  for (const url of [
    'https://www.lowes.com/',
    'https://www.lowes.com/search?searchTerm=5010000042',
    'https://www.lowes.com.evil.example/pd/Product/5010000042',
    'https://evil.example/pd/Product/5010000042',
    'http://www.lowes.com/pd/Product/5010000042',
    'https://user@www.lowes.com/pd/Product/5010000042',
    'https://www.lowes.com:8443/pd/Product/5010000042',
    'https://www.lowes.com/pd/Product/not-a-product-id',
    'https://www.lowes.com/pd/Product/5010000042/other',
  ])
    assert.equal(lowesProductIdentity(url), null, url);
});
