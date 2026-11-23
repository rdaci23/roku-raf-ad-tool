#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function runNodeScript(scriptPath, passArgs) {
  const res = spawnSync(process.execPath, [scriptPath, ...passArgs], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(res.status ?? 1);
}

// `npx roku-raf-ad-tool mcp` -> launch MCP stdio server
if (args[0] === 'mcp') {
  const distMcp = join(pkgRoot, 'dist', 'mcp', 'server.js');
  if (existsSync(distMcp)) {
    runNodeScript(distMcp, args.slice(1));
  }
  const tsxCli = join(pkgRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  runNodeScript(tsxCli, [join(pkgRoot, 'src', 'mcp', 'server.ts'), ...args.slice(1)]);
}

// `npx roku-raf-ad-tool` (no subcommand, `serve`, `start`, or `--port ...`) -> launch Web Workbench & Mock Server
if (args.length === 0 || args[0] === 'serve' || args[0] === 'start' || args[0].startsWith('--port')) {
  const flagArgs = args[0] === 'serve' || args[0] === 'start' ? args.slice(1) : args;
  for (let i = 0; i < flagArgs.length; i++) {
    if (flagArgs[i] === '--port' && flagArgs[i + 1]) {
      process.env.PORT = flagArgs[i + 1];
    } else if (flagArgs[i].startsWith('--port=')) {
      process.env.PORT = flagArgs[i].slice('--port='.length);
    }
  }
  const distServer = join(pkgRoot, 'dist', 'server', 'index.js');
  if (existsSync(distServer)) {
    runNodeScript(distServer, []);
  }
  const tsxCli = join(pkgRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  runNodeScript(tsxCli, [join(pkgRoot, 'src', 'server', 'index.ts')]);
}

// Otherwise delegate to `raf` CLI (`npx roku-raf-ad-tool scan-repo ...`, `--help`, etc.)
const distCli = join(pkgRoot, 'dist', 'cli', 'index.js');
if (existsSync(distCli)) {
  runNodeScript(distCli, args);
}
const tsxCli = join(pkgRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
runNodeScript(tsxCli, [join(pkgRoot, 'src', 'cli', 'index.ts'), ...args]);
