import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldBlockAdRequest } from './resource-policy';

test('content CDN scripts are allowed while unrelated advertising is blocked', () => {
  assert.equal(
    shouldBlockAdRequest(
      'https://static.xx.fbcdn.net/rsrc.php/app.js',
      'https://www.facebook.com/NASA',
      false,
    ),
    false,
  );
  assert.equal(
    shouldBlockAdRequest(
      'https://connect.facebook.net/en_US/fbevents.js',
      'https://example.com/product',
      false,
    ),
    true,
  );
  assert.equal(
    shouldBlockAdRequest(
      'https://ad.doubleclick.net/ad',
      'https://example.com/product',
      false,
    ),
    true,
  );
  assert.equal(
    shouldBlockAdRequest(
      'https://doubleclick.net.example.com/app.js',
      'https://example.com',
      false,
    ),
    false,
  );
});

test('ad filtering preserves requested documents and first-party application resources', () => {
  assert.equal(
    shouldBlockAdRequest(
      'https://www.googletagmanager.com/',
      'about:blank',
      true,
    ),
    false,
  );
  assert.equal(
    shouldBlockAdRequest(
      'https://www.googletagmanager.com/app.js',
      'https://www.googletagmanager.com/',
      false,
    ),
    false,
  );
  assert.equal(
    shouldBlockAdRequest(
      'https://ad.doubleclick.net/frame',
      'https://example.com',
      false,
    ),
    true,
  );
  assert.equal(
    shouldBlockAdRequest('https://ad.doubleclick.net/ad', 'about:blank', false),
    true,
  );
});
