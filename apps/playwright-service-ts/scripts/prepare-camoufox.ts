import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { CAMOUFOX_BROWSER_BUILD } from '../helpers/browser';

async function main() {
  const cli = path.join(
    path.dirname(require.resolve('camoufox')),
    '__main__.js',
  );
  const result = spawnSync(
    process.execPath,
    [cli, 'fetch', CAMOUFOX_BROWSER_BUILD],
    {
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Pinned Camoufox download failed');
  const { launchOptions } = await import('camoufox');
  // Fetch the pinned identity model at provisioning time, before serving work.
  await launchOptions({
    browser: CAMOUFOX_BROWSER_BUILD,
    os:
      process.platform === 'darwin'
        ? 'macos'
        : process.platform === 'win32'
          ? 'windows'
          : 'linux',
    headless: true,
    geoip: false,
    block_webrtc: true,
    exclude_addons: ['UBO'],
  });
  console.log(`Prepared ${CAMOUFOX_BROWSER_BUILD}`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
