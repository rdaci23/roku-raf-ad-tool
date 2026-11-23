#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distCli = join(pkgRoot, 'dist', 'cli', 'index.js');

if (existsSync(distCli)) {
  const res = spawnSync(process.execPath, [distCli, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(res.status ?? 1);
}

const tsxCli = join(pkgRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntry = join(pkgRoot, 'src', 'cli', 'index.ts');

const res = spawnSync(process.execPath, [tsxCli, cliEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

process.exit(res.status ?? 1);
