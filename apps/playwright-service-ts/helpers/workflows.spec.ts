import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countryDestination,
  validActions,
  interactionState,
} from './workflows';

test('country navigation preserves origin, product path and SKU', () => {
  const url = 'https://www.bestbuy.com/site/product/123.p?skuId=123';
  assert.equal(
    countryDestination(url, url + '&intl=nosplash'),
    url + '&intl=nosplash',
  );
  for (const next of [
    'https://evil.example/site/product/123.p?skuId=123&intl=nosplash',
    'https://www.bestbuy.com/?skuId=123&intl=nosplash',
    url.replace('skuId=123', 'skuId=456') + '&intl=nosplash',
  ])
    assert.equal(countryDestination(url, next), null);
});
test('interactive commands reject broad clicks, code execution and retry-shaped malformed inputs', () => {
  assert.equal(validActions([{ type: 'click', selector: '#specific' }]), true);
  assert.equal(
    validActions([{ type: 'click', selector: 'button', all: true }]),
    false,
  );
  assert.equal(
    validActions([
      { type: 'executeJavascript', script: 'fetch("http://private")' },
    ]),
    false,
  );
  assert.equal(
    validActions([{ type: 'wait', milliseconds: 10, selector: 'main' }]),
    false,
  );
  assert.equal(
    interactionState(
      'Sorry not available in your location',
      'https://example.com',
      false,
      200,
      false,
    ),
    'REGION_UNAVAILABLE',
  );
  assert.equal(
    interactionState(
      'Verify you are human',
      'https://example.com',
      true,
      200,
      false,
    ),
    'HUMAN_REQUIRED',
  );
});
