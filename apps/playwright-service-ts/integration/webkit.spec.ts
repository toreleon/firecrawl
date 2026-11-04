import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import { readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Server } from 'proxy-chain';
import { browserConfiguration, launchBrowser } from '../helpers/browser';
import { webkitFilterPort } from '../helpers/webkit';
import { pinnedLookup, ssrfPrepareRequest } from '../helpers/ssrf';
import {
  closeServer,
  listen,
  readProbe,
  scrape,
  startFixtures,
  startService,
} from './support';

const enabled = process.env.TEST_WEBKIT === 'true';
const filterPort = webkitFilterPort(process.env.BROWSER_FILTER_PORT);

test(
  'contained WebKit preserves the HTTP contract and retained-context isolation',
  { skip: !enabled, timeout: 60000 },
  async (t) => {
    const fixtures = await startFixtures();
    const base = fixtures.url.replace('127.0.0.1', 'webkit-fixture.test');
    const service = await startService({
      BROWSER_ENGINE: 'webkit',
      BROWSER_CHANNEL: '',
    }).catch(async (error) => {
      await fixtures.close();
      throw error;
    });
    try {
      await t.test(
        'page scripts, worker identity and explicit headers survive',
        async () => {
          const health = await (
            await fetch(service.baseUrl + '/health')
          ).json();
          assert.equal(health.browserEngine, 'webkit');
          const result = await scrape(service.baseUrl, base + '/gate', {
            check_selector: '#diagnostics',
          });
          assert.equal(result.status, 200);
          const probe = readProbe(result.body.content);
          assert.match(probe.userAgent, /AppleWebKit\//);
          assert.equal(probe.userAgent, probe.workerUserAgent);
          assert.equal(probe.platform, probe.workerPlatform);
          assert.equal(result.body.diagnostics.attempts[0].pageClosed, true);
          const redirect = await scrape(service.baseUrl, base + '/redirect', {
            headers: {
              'X-Fixture': 'preserved',
              'User-Agent': 'Explicit-Client/1.0',
              Cookie: 'session=caller',
            },
          });
          assert.equal(redirect.body.url, base + '/json');
          const body = JSON.parse(redirect.body.content);
          assert.equal(body.header, 'preserved');
          assert.equal(body.userAgent, 'Explicit-Client/1.0');
          assert.match(body.cookie, /session=caller/);
          const next = await scrape(service.baseUrl, base + '/json');
          assert.equal(JSON.parse(next.body.content).cookie, null);
        },
      );
      await t.test(
        'a retained context keeps its own cookies until explicitly deleted',
        async () => {
          const created = await scrape(service.baseUrl, base + '/set-cookie', {
            create_session: true,
          });
          assert.equal(created.status, 200);
          assert.match(created.body.sessionId, /^[a-f0-9]{64}$/);
          const continued = await scrape(service.baseUrl, base + '/json', {
            session_id: created.body.sessionId,
          });
          assert.match(
            JSON.parse(continued.body.content).cookie,
            /session=private-fixture/,
          );
          const independent = await scrape(service.baseUrl, base + '/json');
          assert.equal(JSON.parse(independent.body.content).cookie, null);
          assert.equal(
            (
              await fetch(
                service.baseUrl + '/sessions/' + created.body.sessionId,
                { method: 'DELETE' },
              )
            ).status,
            204,
          );
        },
      );
      await t.test(
        'denials, unresolved verification and timeout cleanup remain failures',
        async () => {
          const challenge = await scrape(service.baseUrl, base + '/challenge');
          assert.equal(
            challenge.body.interaction.state,
            'VERIFICATION_REQUIRED',
          );
          assert.ok(challenge.body.pageError);
          for (const status of [403, 429]) {
            const result = await scrape(
              service.baseUrl,
              base + '/status?code=' + status,
            );
            assert.equal(result.body.pageStatusCode, status);
            assert.ok(result.body.pageError);
          }
          const timeout = await scrape(service.baseUrl, base + '/ordinary', {
            check_selector: '#absent',
            timeout: 250,
            wait_after_load: 0,
          });
          assert.equal(timeout.status, 500);
          assert.equal(timeout.body.diagnostics.attempts[0].pageClosed, true);
          const health = await (
            await fetch(service.baseUrl + '/health')
          ).json();
          assert.equal(health.activePages, 0);
          assert.equal(health.browserSessions, 0);
        },
      );
    } finally {
      await service.stop();
      await fixtures.close();
    }
  },
);

test(
  'WebKit UID policy blocks private destinations and IPv4/IPv6 RTC paths',
  { skip: !enabled, timeout: 45000 },
  async (t) => {
    let hits = 0,
      udp4 = 0,
      udp6 = 0,
      tcp4 = 0,
      tcp6 = 0,
      checks = 0,
      allow = true;
    const server = http.createServer((_req, res) => {
      hits++;
      res.setHeader('content-type', 'text/html');
      res.end(
        '<main>Owned fixture</main><script>document.documentElement.dataset.executed="true"</script>',
      );
    });
    const port = await listen(server);
    const udp = [dgram.createSocket('udp4'), dgram.createSocket('udp6')];
    const tcp = [
      net.createServer((socket) => {
        tcp4++;
        socket.destroy();
      }),
      net.createServer((socket) => {
        tcp6++;
        socket.destroy();
      }),
    ];
    udp[0].on('message', () => udp4++);
    udp[1].on('message', () => udp6++);
    await new Promise<void>((resolve) => udp[0].bind(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => udp[1].bind(0, '::1', resolve));
    await listen(tcp[0]);
    await new Promise<void>((resolve) => tcp[1].listen(0, '::1', resolve));
    const deny = ssrfPrepareRequest({
      allowLocal: false,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    const proxy = new Server({
      port: filterPort,
      host: '127.0.0.1',
      prepareRequestFunction: async (args) => {
        checks++;
        return allow
          ? { dnsLookup: pinnedLookup([{ address: '127.0.0.1', family: 4 }]) }
          : deny(args);
      },
    });
    await proxy.listen();
    let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
    try {
      browser = await launchBrowser(
        browserConfiguration({
          BROWSER_ENGINE: 'webkit',
          BROWSER_HEADLESS: 'true',
          BROWSER_FILTER_PORT: String(filterPort),
        }),
        { ssrfProxyPort: filterPort },
      );
      await t.test(
        'trusted service has no NET_ADMIN; browser processes have no privileges',
        () => {
          const current = readFileSync('/proc/self/status', 'utf8');
          const bound = current.match(/^CapBnd:\s*([a-f0-9]+)$/m)![1];
          assert.equal(
            BigInt('0x' + bound) & (BigInt(1) << BigInt(12)),
            BigInt(0),
          );
          const processes = readdirSync('/proc')
            .filter((name) => /^[0-9]+$/.test(name))
            .flatMap((pid) => {
              try {
                const status = readFileSync('/proc/' + pid + '/status', 'utf8');
                return /^Name:\s*(MiniBrowser|WebKit)/m.test(status)
                  ? [status]
                  : [];
              } catch {
                return [];
              }
            });
          assert.ok(processes.length > 0);
          for (const status of processes) {
            assert.match(status, /^Uid:\s*1000\s+1000\s+1000\s+1000$/m);
            assert.match(status, /^CapEff:\s*0+$/m);
            assert.match(status, /^CapBnd:\s*0+$/m);
            assert.match(status, /^NoNewPrivs:\s*1$/m);
          }
        },
      );
      const context = await browser.newContext({
        proxy: { server: 'http://127.0.0.1:' + filterPort },
        serviceWorkers: 'block',
      });
      try {
        const page = await context.newPage();
        await t.test(
          'allowed HTTP executes scripts; private HTTP cannot bypass filter',
          async () => {
            await page.goto(`http://public-fixture.test:${port}`, {
              waitUntil: 'domcontentloaded',
            });
            assert.equal(
              await page.evaluate(
                () => document.documentElement.dataset.executed,
              ),
              'true',
            );
            assert.equal(hits, 1);
            assert.ok(checks > 0);
            allow = false;
            for (const target of [
              `http://127.0.0.1:${port}`,
              `http://private-fixture.test:${port}`,
            ]) {
              await page
                .goto(target, { timeout: 3000, waitUntil: 'domcontentloaded' })
                .catch(() => {});
              assert.equal(hits, 1);
            }
          },
        );
        await t.test(
          'IPv4 and IPv6 STUN/TURN are constructed but send no packets',
          async () => {
            await page.setContent('<main>Owned transport probe</main>');
            for (const [index, host] of ['127.0.0.1', '[::1]'].entries()) {
              for (const protocol of ['stun', 'turn']) {
                const port =
                  protocol === 'stun'
                    ? udp[index].address().port
                    : (tcp[index].address() as net.AddressInfo).port;
                const constructed = await page.evaluate(
                  async ({ host, port, protocol }) => {
                    const peer = new RTCPeerConnection({
                      iceServers: [
                        {
                          urls: `${protocol}:${host}:${port}${protocol === 'turn' ? '?transport=tcp' : ''}`,
                          ...(protocol === 'turn'
                            ? { username: 'owned', credential: 'owned' }
                            : {}),
                        },
                      ],
                    });
                    try {
                      peer.createDataChannel('owned');
                      await peer.setLocalDescription(await peer.createOffer());
                      await new Promise((resolve) => setTimeout(resolve, 1200));
                      return true;
                    } finally {
                      peer.close();
                    }
                  },
                  { host, port, protocol },
                );
                assert.equal(constructed, true);
              }
            }
            assert.deepEqual(
              { udp4, udp6, tcp4, tcp6 },
              { udp4: 0, udp6: 0, tcp4: 0, tcp6: 0 },
            );
          },
        );
        await t.test(
          'same-UID direct IPv6 TCP is rejected by kernel policy',
          async () => {
            // First prove the owned IPv6 listener works from the trusted UID.
            const before = tcp6;
            await new Promise<void>((resolve, reject) => {
              const socket = net.connect({
                host: '::1',
                port: (tcp[1].address() as net.AddressInfo).port,
              });
              socket.once('connect', () => {
                socket.destroy();
                resolve();
              });
              socket.once('error', reject);
            });
            assert.equal(tcp6, before + 1);
            const code = `const n=require('node:net'),s=n.connect({host:'::1',port:${(tcp[1].address() as net.AddressInfo).port}});s.on('connect',()=>process.exit(2));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(3),2000);`;
            const child = spawn(
              'setpriv',
              [
                '--reuid=1000',
                '--regid=1000',
                '--clear-groups',
                '--no-new-privs',
                '--bounding-set=-all',
                '--inh-caps=-all',
                '--ambient-caps=-all',
                process.execPath,
                '-e',
                code,
              ],
              { stdio: 'inherit' },
            );
            assert.equal(
              await new Promise<number | null>((resolve) =>
                child.once('exit', resolve),
              ),
              0,
            );
            assert.equal(tcp6, before + 1);
          },
        );
      } finally {
        await context.close();
      }
      assert.equal(browser.contexts().length, 0);
    } finally {
      await browser?.close();
      await proxy.close(true);
      await closeServer(server);
      for (const socket of udp) socket.close();
      await Promise.all(
        tcp.map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
    }
  },
);
