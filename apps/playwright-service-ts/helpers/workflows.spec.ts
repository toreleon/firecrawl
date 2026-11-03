import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countryDestination,
  validActions,
  interactionState,
  amazonContinuationAllowed,
  amazonProductIdentity,
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
test('Amazon continuation permits only the observed answer-free GET form on the requested product', () => {
  const url = 'https://www.amazon.com/Test/dp/B000000042';
  const valid = {
    action: '/errors_page/validateCaptcha',
    method: 'get',
    formCount: 1,
    buttonCount: 1,
    prompt: true,
    shortPage: true,
    otherControls: false,
    inputs: [
      { name: 'amzn', type: 'hidden' },
      { name: 'amzn-r', type: 'hidden' },
      { name: 'field-keywords', type: 'hidden' },
    ],
  };
  assert.equal(amazonProductIdentity(url), 'B000000042');
  assert.equal(amazonProductIdentity('not a URL'), null);
  assert.equal(amazonContinuationAllowed(url, valid), true);
  assert.equal(amazonProductIdentity('https://www.amazon.com/cart'), null);
  for (const broken of [
    { ...valid, method: 'post' },
    { ...valid, formCount: 2 },
    { ...valid, buttonCount: 2 },
    { ...valid, prompt: false },
    { ...valid, otherControls: true },
    { ...valid, action: 'https://evil.example/errors_page/validateCaptcha' },
    { ...valid, action: 'http://%' },
    { ...valid, action: '/errors_page/validateCaptcha?redirect=elsewhere' },
    {
      ...valid,
      inputs: valid.inputs.map((i) =>
        i.name === 'field-keywords' ? { ...i, type: 'text' } : i,
      ),
    },
  ])
    assert.equal(amazonContinuationAllowed(url, broken), false);
  assert.equal(
    amazonContinuationAllowed(
      url.replace('amazon.com', 'amazon.com.evil.example'),
      valid,
    ),
    false,
  );
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
