import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZipFromDirectory } from '../shared/zipBuilder.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_CHANNEL_DIR = join(ROOT, 'roku-channel');

/**
 * Cross-platform (Linux, macOS, Windows) Roku channel .zip builder using pure Node zlib,
 * baking the current LAN server URL (`raf_tool_server_url=...`) directly into `manifest`.
 */
export function buildRokuChannelZip(serverBaseUrl: string): Buffer {
  const stageDir = mkdtempSync(join(tmpdir(), 'roku-raf-channel-'));

  try {
    const workChannel = join(stageDir, 'channel');
    cpSync(SOURCE_CHANNEL_DIR, workChannel, { recursive: true });

    const manifestPath = join(workChannel, 'manifest');
    let manifest = readFileSync(manifestPath, 'utf8');
    if (/^raf_tool_server_url=/m.test(manifest)) {
      manifest = manifest.replace(/^raf_tool_server_url=.*$/m, `raf_tool_server_url=${serverBaseUrl}`);
    } else {
      manifest += `\nraf_tool_server_url=${serverBaseUrl}\n`;
    }
    writeFileSync(manifestPath, manifest, 'utf8');

    return createZipFromDirectory(workChannel, ['manifest', 'source', 'components', 'images']);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}
