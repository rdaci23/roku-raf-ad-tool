#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distMcp = join(pkgRoot, 'dist', 'mcp', 'server.js');

if (existsSync(distMcp)) {
  const res = spawnSync(process.execPath, [distMcp, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(res.status ?? 1);
}

const tsxCli = join(pkgRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const srcMcp = join(pkgRoot, 'src', 'mcp', 'server.ts');
const res = spawnSync(process.execPath, [tsxCli, srcMcp, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(res.status ?? 1);
