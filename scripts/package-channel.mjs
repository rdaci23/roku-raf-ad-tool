#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ZIP = join(ROOT, 'roku-raf-harness.zip');

spawnSync(process.execPath, [join(ROOT, 'scripts', 'generate-media.mjs')], { stdio: 'inherit' });

// Run via tsx so pure Node zipBuilder works on Windows, macOS, and Linux without /usr/bin/zip
const res = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'tsx',
    '-e',
    `import { writeFileSync } from 'node:fs'; import { buildRokuChannelZip } from './src/server/channelPackager.ts'; import { detectLanIp } from './src/server/networkInfo.ts'; const buf = buildRokuChannelZip('http://' + detectLanIp() + ':4321'); writeFileSync(${JSON.stringify(OUT_ZIP)}, buf); console.log('Packaged cross-platform Roku channel (' + buf.length + ' bytes) -> ' + ${JSON.stringify(OUT_ZIP)});`,
  ],
  { cwd: ROOT, stdio: 'inherit' }
);

if (res.status !== 0) {
  writeFileSync; // keep import used
  process.exit(res.status ?? 1);
}
