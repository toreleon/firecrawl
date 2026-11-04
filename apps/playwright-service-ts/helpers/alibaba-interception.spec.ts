import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPageProtection } from './page-readiness';
import {
  alibabaInterception,
  ordinaryAlibabaAssets,
} from '../integration/fixtures/alibaba';

test('large observed Alibaba interception structure is interactive rather than ready product content', () => {
  const html = alibabaInterception();
  assert.ok(html.length > 65536);
  assert.deepEqual(
    detectPageProtection(html, {}, 'https://fixture.test/product'),
    {
      provider: 'alibaba',
      reason: 'Alibaba CAPTCHA interception document',
      interactive: true,
    },
  );
});

test('a CAPTCHA SDK, title, text or partial document alone does not establish interception', () => {
  const html = alibabaInterception(0);
  for (const ordinary of [
    ordinaryAlibabaAssets(),
    html.replace('baxia-punish', 'product-record'),
    html.replace('nc-verify-form', 'contact-form'),
    html.replace('/_____tmd_____/verify/', '/contact/'),
    html.replace(
      'Sorry, we have detected unusual traffic from your network.',
      'Original public record 42',
    ),
    html.replace('g.alicdn.com/AWSC', 'g.alicdn.com.attacker.test/AWSC'),
    html.replace(
      'g.alicdn.com/bsop-static',
      'g.alicdn.com.attacker.test/bsop-static',
    ),
    html.replace(
      '/product/_____tmd_____/verify/',
      'https://attacker.test/product/_____tmd_____/verify/',
    ),
  ])
    assert.equal(
      detectPageProtection(ordinary, {}, 'https://fixture.test/product'),
      undefined,
    );
});

test('quoted examples, comments and escaped source do not become runtime challenges', () => {
  const html = alibabaInterception(0);
  for (const example of [
    `<title>Captcha Interception</title><main>Documentation</main><script>const sample=${JSON.stringify(html).replace(/</g, '\\u003c')}</script>`,
    `<title>Captcha Interception</title><main>Documentation</main><!--${html}-->`,
    `<title>Captcha Interception</title><pre>${html.replace(/</g, '&lt;')}</pre>`,
  ])
    assert.equal(detectPageProtection(example), undefined);
});

test('oversized pages and large normal body content stay outside the bounded interception signature', () => {
  assert.equal(detectPageProtection(alibabaInterception(270000)), undefined);
  assert.equal(
    detectPageProtection(
      alibabaInterception(0).replace(
        '</body>',
        '<article>' +
          'Normal product description. '.repeat(200) +
          '</article></body>',
      ),
    ),
    undefined,
  );
});
