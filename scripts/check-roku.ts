import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { AppDatabase } from '../src/server/db.js';
import { detectLanIp } from '../src/server/networkInfo.js';
import { discoverRokuDevices, queryRokuDeviceInfo, queryRokuMediaPlayer } from '../src/server/rokuBridge.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');

function loadEnvRokuIp(): string {
  if (!existsSync(ENV_PATH)) return '';
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('ROKU_IP=')) {
      return t.slice('ROKU_IP='.length).trim().replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true });

async function checkPort(host: string, port: number, timeoutMs = 2500): Promise<{ open: boolean; banner?: string; error?: string }> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let banner = '';
    let done = false;

    const finish = (res: { open: boolean; banner?: string; error?: string }) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(res);
    };

    sock.setTimeout(timeoutMs);
    sock.once('connect', () => {
      // Wait 300ms to see if port 8085 sends an immediate prompt/banner
      setTimeout(() => finish({ open: true, banner: banner.trim() || undefined }), 300);
    });
    sock.on('data', (chunk) => {
      banner += chunk.toString('utf8');
    });
    sock.once('error', (err) => finish({ open: false, error: err.message }));
    sock.once('timeout', () => finish({ open: false, error: 'timeout' }));
  });
}

async function main() {
  let ip = process.argv[2] || process.env.ROKU_IP || loadEnvRokuIp();
  if (!ip) {
    const discovered = await discoverRokuDevices(1800).catch(() => []);
    ip = discovered[0]?.ip || '';
  }
  if (!ip) {
    console.error('Usage: npm run check:roku -- <roku-lan-ip> (or set ROKU_IP in .env)');
    process.exit(1);
  }
  const lanIp = detectLanIp();
  console.log(`=== Roku RAF Device Diagnostic ===`);
  console.log(`Target Roku IP : ${ip}`);
  console.log(`Local Host IP  : ${lanIp}`);
  console.log('');

  // 1. ECP Device Info (:8060)
  console.log('--- 1. ECP Device Info (:8060/query/device-info) ---');
  const devInfo = await queryRokuDeviceInfo(ip);
  if (!devInfo.reachable) {
    console.log(`FAIL: Could not reach ECP on http://${ip}:8060 -> ${devInfo.error}`);
  } else {
    console.log(`PASS: Reachable!`);
    console.log(`  Friendly Name    : ${devInfo.friendlyName}`);
    console.log(`  Model            : ${devInfo.modelName} (${devInfo.modelNumber})`);
    console.log(`  Serial Number    : ${devInfo.serialNumber}`);
    console.log(`  Software Version : ${devInfo.softwareVersion}`);
    console.log(`  Developer Mode   : ${devInfo.developerEnabled ? 'ENABLED' : 'DISABLED'}`);
    console.log(`  Advertising ID   : ${devInfo.AdvertisingId ?? '(not exposed over unauthenticated ECP on this Roku OS)'}`);

    if (devInfo.rawXml) {
      const doc = parser.parse(devInfo.rawXml) as Record<string, Record<string, unknown>>;
      const raw = doc['device-info'] ?? {};
      console.log(`  UI Resolution    : ${raw['ui-resolution'] ?? 'unknown'}`);
      console.log(`  Max Video Res    : ${raw['max-video-resolution'] ?? raw['video-Mode'] ?? 'unknown'}`);
      console.log(`  Network Type     : ${raw['network-type'] ?? 'unknown'} (MAC: ${raw['wifi-mac'] ?? raw['ethernet-mac'] ?? 'n/a'})`);
      console.log(`  ECP Setting      : ${raw['ecp-setting-mode'] ?? 'default (enabled)'}`);
      console.log(`  Ad Tracking Dis. : ${raw['is-ad-tracking-disabled'] ?? raw['limit-ad-tracking'] ?? 'n/a'}`);
    }

    // Save/update in local SQLite roster so Web UI has it ready
    const db = new AppDatabase();
    const existing = db.listDevices().find((d) => d.ip === ip);
    db.upsertDevice({
      id: existing?.id ?? `roku-${ip.replace(/\./g, '-')}`,
      name: devInfo.friendlyName || `Roku (${ip})`,
      ip,
      username: existing?.username ?? 'rokudev',
      password: existing?.password ?? '',
      modelName: `${devInfo.modelName ?? ''} ${devInfo.modelNumber ?? ''}`.trim(),
      softwareVersion: devInfo.softwareVersion,
      serialNumber: devInfo.serialNumber,
      lastSeenAt: new Date().toISOString(),
    });
    db.close();
  }
  console.log('');

  // 2. Active App & Installed Dev Channel Check
  console.log('--- 2. Active App, Installed Dev Channel & Media Player (:8060) ---');
  try {
    const [activeResp, appsResp, playerState] = await Promise.all([
      fetch(`http://${ip}:8060/query/active-app`, { signal: AbortSignal.timeout(3000) }),
      fetch(`http://${ip}:8060/query/apps`, { signal: AbortSignal.timeout(3000) }),
      queryRokuMediaPlayer(ip).catch(() => null),
    ]);

    if (activeResp.ok) {
      const activeDoc = parser.parse(await activeResp.text()) as Record<string, Record<string, unknown>>;
      const app = activeDoc['active-app']?.app;
      console.log(`  Active App       : ${typeof app === 'object' ? JSON.stringify(app) : app}`);
    } else {
      console.log(`  Active App       : HTTP ${activeResp.status}`);
    }

    if (appsResp.ok) {
      const appsXml = await appsResp.text();
      const hasDevApp = /id="dev"/i.test(appsXml);
      const appMatches = appsXml.match(/<app\b[^>]*>[\s\S]*?<\/app>/gi) ?? [];
      console.log(`  Installed Apps   : ${appMatches.length} total | Sideloaded "dev" slot occupied: ${hasDevApp ? 'YES' : 'NO'}`);
      if (hasDevApp) {
        const devLine = appMatches.find((l) => /id="dev"/i.test(l));
        console.log(`  Current Dev App  : ${devLine}`);
      }
    }

    if (playerState) {
      console.log(
        `  Media Player     : state=${playerState.state ?? 'none'} | pos=${playerState.position ?? 'n/a'} | dur=${playerState.duration ?? 'n/a'} | live=${playerState.isLive ?? false}`
      );
    }
  } catch (err) {
    console.log(`  Warning querying active-app/apps: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log('');

  // 3. Developer Web Server (:80/plugin_install)
  console.log('--- 3. Developer Installer Web Server (:80/plugin_install) ---');
  try {
    const instResp = await fetch(`http://${ip}/plugin_install`, { signal: AbortSignal.timeout(3000) });
    const wwwAuth = instResp.headers.get('www-authenticate');
    console.log(`  HTTP Status      : ${instResp.status}`);
    console.log(`  WWW-Authenticate : ${wwwAuth ?? '(none)'}`);
    if (instResp.status === 401 && wwwAuth) {
      console.log(`  PASS: Developer installer active & protected by HTTP Digest Auth (ready for sideloading).`);
    } else if (instResp.status === 200) {
      console.log(`  PASS: Developer installer reachable (HTTP 200).`);
    }
  } catch (err) {
    console.log(`  FAIL/CLOSED: Port 80 installer unreachable (${err instanceof Error ? err.message : String(err)}). Developer Mode may be disabled.`);
  }
  console.log('');

  // 4. BrightScript / RAF Debug Console (:8085)
  console.log('--- 4. BrightScript & RAF Debug Console (:8085) ---');
  const p8085 = await checkPort(ip, 8085);
  if (p8085.open) {
    console.log(`  PASS: TCP port 8085 is OPEN and accepting debug console connections!`);
    if (p8085.banner) console.log(`  Console Banner   : ${p8085.banner.slice(0, 160)}`);
  } else {
    console.log(`  CLOSED: Port 8085 did not accept connection (${p8085.error}).`);
  }
}

main().catch((err) => {
  console.error('Fatal diagnostic error:', err);
  process.exit(1);
});
