import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cookieScope } from './cookies';

test('cookie scope respects multi-label and private public suffixes', () => {
  assert.deepEqual(cookieScope('https://app.example.co.uk/'), {
    domain: '.example.co.uk',
    path: '/',
  });
  assert.deepEqual(cookieScope('https://shop.tenant.github.io/'), {
    domain: '.tenant.github.io',
    path: '/',
  });
  assert.deepEqual(cookieScope('https://app.example.com/'), {
    domain: '.example.com',
    path: '/',
  });
});
test('IP addresses and single-label hosts use host-only cookies', () => {
  for (const url of [
    'http://127.0.0.1:1234/',
    'http://[::1]:1234/',
    'http://localhost/',
  ])
    assert.deepEqual(cookieScope(url), { url });
});
