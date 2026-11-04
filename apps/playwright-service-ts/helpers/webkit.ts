import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const WEBKIT_POLICY_PATH = '/run/firecrawl-webkit/policy.json';
export const BROWSER_SERVICE_ROOT = path.resolve(
  __dirname,
  __filename.endsWith('.ts') ? '..' : '../..',
);

export const webkitFilterPort = (value = '3004'): number => {
  if (
    !/^[1-9][0-9]{3,4}$/.test(value) ||
    Number(value) < 1024 ||
    Number(value) > 65535
  )
    throw new Error('BROWSER_FILTER_PORT must be an unprivileged TCP port');
  return Number(value);
};

// The browser receives display/locale settings, never service credentials,
// NODE_OPTIONS, loader overrides, proxy secrets or the parent's environment.
export const webkitChildEnvironment = (
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
  const child: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    FIRECRAWL_WEBKIT_EXECUTABLE: executable,
  };
  for (const key of ['DISPLAY', 'LANG', 'LC_ALL', 'TZ'])
    if (env[key]) child[key] = env[key]!;
  return child;
};

export const assertWebkitContainment = (port: number): void => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0)
    throw new Error(
      'WebKit requires the Linux UID-filter container entrypoint',
    );
  const policyStat = statSync(WEBKIT_POLICY_PATH);
  if (policyStat.uid !== 0 || (policyStat.mode & 0o077) !== 0)
    throw new Error('WebKit policy receipt must be root-owned and private');
  const policy = JSON.parse(readFileSync(WEBKIT_POLICY_PATH, 'utf8'));
  if (
    policy.version !== 1 ||
    policy.browserUid !== 1000 ||
    policy.filterPort !== port
  )
    throw new Error('WebKit policy does not match the listening SSRF filter');
  const status = readFileSync('/proc/self/status', 'utf8');
  const capabilities = status.match(/^CapBnd:\s*([a-f0-9]+)$/m)?.[1];
  if (
    !capabilities ||
    (BigInt('0x' + capabilities) & (BigInt(1) << BigInt(12))) !== BigInt(0)
  )
    throw new Error(
      'WebKit service must drop NET_ADMIN after installing its policy',
    );
  // The privileged launcher and application bundle cannot be modified by the
  // browser UID. The image must retain these ownership/mode requirements.
  for (const filename of [
    BROWSER_SERVICE_ROOT,
    path.join(BROWSER_SERVICE_ROOT, 'scripts'),
    __dirname,
    path.join(BROWSER_SERVICE_ROOT, 'scripts', 'webkit-launcher.sh'),
    path.join(
      __dirname,
      __filename.endsWith('.ts') ? 'browser.ts' : 'browser.js',
    ),
  ]) {
    const stat = statSync(filename);
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0)
      throw new Error(
        'WebKit runtime and launcher must be root-owned and not writable by the browser',
      );
  }
};
