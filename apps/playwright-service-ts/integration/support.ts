import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net, { AddressInfo } from 'node:net';
import path from 'node:path';

export const listen = async (server: net.Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

export const closeServer = (server: http.Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  });

export const startService = async (env: NodeJS.ProcessEnv = {}) => {
  const reservation = net.createServer();
  const port = await listen(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = spawn(process.execPath, ['--import', 'tsx', 'api.ts'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PROXY_SERVER: '',
      PROXY_USERNAME: '',
      PROXY_PASSWORD: '',
      PORT: String(port),
      ALLOW_LOCAL_WEBHOOKS: 'true',
      BROWSER_HEADLESS: 'true',
      BROWSER_CHANNEL: 'chromium',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', (chunk) => {
    logs = (logs + chunk.toString()).slice(-20000);
  });
  child.stderr?.on('data', (chunk) => {
    logs = (logs + chunk.toString()).slice(-20000);
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  };
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Service exited during startup:\n${logs}`);
      }
      try {
        const response = await fetch(`${baseUrl}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) return { baseUrl, child, stop, logs: () => logs };
      } catch {
        /* Wait for the service's browser to start. */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Service startup timed out:\n${logs}`);
  } catch (error) {
    await stop();
    throw error;
  }
};

export const scrape = async (
  baseUrl: string,
  url: string,
  options: Record<string, unknown> = {},
) => {
  const response = await fetch(`${baseUrl}/scrape`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url,
      timeout: 10000,
      wait_after_load: 300,
      ...options,
    }),
    signal: AbortSignal.timeout(
      Number(options.timeout ?? 10000) +
        Number(options.wait_after_load ?? 300) +
        10000,
    ),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
};

export const startFixtures = async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.test');
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/gate') {
      res.end(`<!doctype html><title>Automation diagnostic fixture</title>
        <body><div id="pending">Checking browser</div><script>
        const worker = new Worker('/worker.js');
        worker.onmessage = ({data}) => {
          const probe = {
            webdriver: navigator.webdriver,
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            workerUserAgent: data.userAgent,
            workerPlatform: data.platform,
            playwrightGlobals: Object.keys(window).filter(k => /^__pw/.test(k)),
          };
          document.body.innerHTML = '<pre id="diagnostics">' + JSON.stringify(probe) + '</pre>' +
            (probe.webdriver ? '<div id="blocked">Automation detected</div>' :
              '<main id="protected-content">Protected company record</main>');
        };
        </script></body>`);
    } else if (url.pathname === '/worker.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(
        'postMessage({userAgent: navigator.userAgent, platform: navigator.platform})',
      );
    } else if (url.pathname === '/challenge') {
      res.end(
        '<!doctype html><title>Just a moment...</title><div id="cf-chl-widget">Checking your browser</div><script src="/cdn-cgi/challenge-platform/check.js"></script>',
      );
    } else if (url.pathname === '/ordinary') {
      res.end(
        '<!doctype html><title>Company contact</title><main>Contact our company</main><div class="cf-turnstile" data-sitekey="public-contact-form"></div>',
      );
    } else if (url.pathname === '/json') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          company: 'Fixture Ltd',
          header: req.headers['x-fixture'],
          userAgent: req.headers['user-agent'],
          cookie: req.headers.cookie ?? null,
        }),
      );
    } else if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/json' });
      res.end();
    } else if (url.pathname === '/set-cookie') {
      res.setHeader('set-cookie', 'session=private-fixture; Path=/');
      res.end('Cookie set');
    } else if (url.pathname === '/status') {
      res.statusCode = Number(url.searchParams.get('code') ?? 403);
      res.end('Denied by the target');
    } else {
      res.statusCode = 404;
      res.end('Not found');
    }
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, close: () => closeServer(server) };
};

export const readProbe = (content: string): Record<string, any> => {
  const json = content.match(/<pre id="diagnostics">([^<]+)<\/pre>/)?.[1];
  if (!json)
    throw new Error('The browser did not complete the diagnostic fixture');
  return JSON.parse(json.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
};
