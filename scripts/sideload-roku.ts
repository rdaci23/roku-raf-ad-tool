import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRokuChannelZip } from '../src/server/channelPackager.js';
import { detectLanIp } from '../src/server/networkInfo.js';
import { discoverRokuDevices, queryRokuDeviceInfo, sideloadChannelToRoku } from '../src/server/rokuBridge.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');

function loadEnvFile(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

async function main() {
  const env = loadEnvFile();
  let ip = process.argv[2] || process.env.ROKU_IP || env.ROKU_IP || '';
  if (!ip) {
    const discovered = await discoverRokuDevices(1800).catch(() => []);
    ip = discovered[0]?.ip || '';
  }
  if (!ip) {
    console.error('Missing Roku IP. Pass as arg, set ROKU_IP in .env, or ensure Roku is discoverable via SSDP.');
    process.exit(1);
  }
  const password = process.argv[3] || process.env.ROKU_DEV_PASSWORD || env.ROKU_DEV_PASSWORD || '';
  const username = process.env.ROKU_DEV_USER || env.ROKU_DEV_USER || 'rokudev';
  const port = process.env.PORT || env.PORT || '4321';
  const serverBaseUrl = `http://${detectLanIp()}:${port}`;
  const localApiUrl = `http://127.0.0.1:${port}`;

  if (!password) {
    console.error('Missing Roku developer password. Pass as arg or set ROKU_DEV_PASSWORD in .env');
    process.exit(1);
  }

  console.log(`Packaging roku-channel/ with LAN server URL ${serverBaseUrl} ...`);
  const zipBuffer = buildRokuChannelZip(serverBaseUrl);
  console.log(`Archive ready (${zipBuffer.length} bytes). Sideloading to http://${ip}/plugin_install ...`);

  const res = await sideloadChannelToRoku({
    ip,
    username,
    password,
    zipBuffer,
  });

  console.log(`Sideload result [HTTP ${res.status}]: ${res.message}`);
  if (!res.ok) {
    process.exit(1);
  }

  // Update saved device credentials & attach port 8085 console on running local server if up
  const devInfo = await queryRokuDeviceInfo(ip);
  await fetch(`${localApiUrl}/api/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: `roku-${ip.replace(/\./g, '-')}`,
      name: devInfo.friendlyName || `Roku (${ip})`,
      ip,
      username,
      password,
      modelName: `${devInfo.modelName ?? ''} ${devInfo.modelNumber ?? ''}`.trim(),
      softwareVersion: devInfo.softwareVersion,
      serialNumber: devInfo.serialNumber,
    }),
  }).catch(() => {});

  await fetch(`${localApiUrl}/api/roku/console/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip, sessionId: 'roku-tv' }),
  }).catch(() => {});

  // Wait briefly for Roku OS to boot the newly installed dev channel and verify active-app
  await new Promise((r) => setTimeout(r, 2000));
  const activeResp = await fetch(`http://${ip}:8060/query/active-app`, {
    signal: AbortSignal.timeout(3000),
  });
  console.log(`Active App on ${ip}:\n${(await activeResp.text()).trim()}`);
}

main().catch((err) => {
  console.error('Sideload error:', err);
  process.exit(1);
});
