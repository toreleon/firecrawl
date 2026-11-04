import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPageProtection } from './page-readiness';
import { interactionState } from './workflows';
import {
  autotraderBlock,
  ordinaryAutotrader,
} from '../integration/fixtures/autotrader';

test('the observed HTTP 200 Autotrader block shape is denied rather than ready or answer-required', () => {
  const p = detectPageProtection(autotraderBlock());
  assert.deepEqual(p, {
    provider: 'autotrader',
    reason: 'Autotrader unavailability block document',
    denied: true,
  });
  assert.equal(
    interactionState(
      'Blocked page with contact verification',
      'https://fixture.test/vehicle',
      false,
      200,
      true,
      false,
      p?.denied,
    ),
    'ACCESS_DENIED',
  );
});

test('maintenance text, incident references, vendor paths or a contact CAPTCHA alone are insufficient', () => {
  const page = autotraderBlock();
  for (const sample of [
    ordinaryAutotrader(),
    page.replace('atcform', 'contact-form'),
    page.replace('Incident Number:', 'Support ticket:'),
    page.replace('/akamai-block/block-images/css/app.css', '/ordinary/app.css'),
    page.replace(
      '/akamai-block/block-images/js/app.js',
      'https://attacker.test/akamai-block/block-images/js/app.js',
    ),
    page.replace(
      "We're sorry for any inconvenience, but the site is currently unavailable.",
      'Original public vehicle 42',
    ),
    '<title>Maintenance</title><main>The site is currently unavailable.</main>',
    '<title>Contact</title><form id="atcform"><div class="g-recaptcha"></div></form>',
  ])
    assert.equal(detectPageProtection(sample), undefined);
});

test('quoted and commented block-page samples do not deny a normal document', () => {
  const p = autotraderBlock();
  for (const sample of [
    `<title>Autotrader - page unavailable</title><main>Documentation</main><!--${p}-->`,
    `<title>Autotrader - page unavailable</title><main>Documentation</main><script>const example=${JSON.stringify(p).replace(/</g, '\\u003c')}</script>`,
    `<title>Autotrader - page unavailable</title><pre>${p.replace(/</g, '&lt;')}</pre>`,
  ])
    assert.equal(detectPageProtection(sample), undefined);
});
