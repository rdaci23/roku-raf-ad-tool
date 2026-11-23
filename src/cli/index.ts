#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateBrightScriptSnippet } from '../shared/brsCodeGenerator.js';
import { importHarArchive } from '../shared/harImporter.js';
import { inspectStreamManifest } from '../shared/manifestInspector.js';
import { validateAdTag } from '../shared/rafValidator.js';
import { scanRokuChannelRepo } from '../shared/repoScanner.js';
import {
  DEFAULT_RAF_RUNTIME_PREFS,
  type ChaosFaultMode,
  type MockScenarioType,
  type RafPlaybackMode,
  type RokuAdPolicyContext,
  type RokuMediaType,
} from '../shared/types.js';
import { auditVendorAdRequestUrl } from '../shared/vendorTemplates.js';
import { buildRokuChannelZip } from '../server/channelPackager.js';
import { detectLanIp } from '../server/networkInfo.js';
import {
  captureRokuScreenshot,
  discoverRokuDevices,
  launchExternalChannelOnRoku,
  queryRokuDeviceInfo,
  queryRokuPerformance8080,
  sideloadChannelToRoku,
} from '../server/rokuBridge.js';
import { fetchAndUnwrapAdTag } from '../server/tagProxy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_PATH = join(ROOT, '.env');

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx > 0) {
        out[t.slice(0, idx).trim()] = t.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      }
    }
  }
  return { ...out, ...(process.env as Record<string, string>) };
}

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function output(data: unknown, asJson: boolean, humanFormatter?: () => string): void {
  if (asJson || process.env.RAF_OUTPUT === 'json') {
    console.log(JSON.stringify(data, null, 2));
  } else if (humanFormatter) {
    console.log(humanFormatter());
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

function printHelp(): void {
  console.log(`Roku RAF Ad Tool CLI (Human & AI Agent Ready)

Usage:
  raf <command> [options] [--json]
  npm run raf -- <command> [options] [--json]

Commands:
  serve [--port 4321]                           Start the 5-tab Web Workbench & Mock Ad Server
  mcp                                           Start the 13-tool Model Context Protocol (MCP) stdio server
  status [--ip <roku-ip>]                       Server, LAN URL & Roku device status
  perf [--ip <roku-ip>]                         Query :8080 Channel RAM, CPU %, Texture VRAM & SG nodes
  scan-repo [channel-dir]                       Statically scan BrightScript/SceneGraph channel for RAF issues
  validate <url-or-xml-file>                    Validate VAST/VMAP/SmartXML tag & Roku Ad-Load policies
      --media-type <type>       movie | episode | shortFormVideo | live
      --content-length <sec>    Content duration in seconds for midroll policy checks
  inspect-manifest <url-or-manifest-file>       Inspect HLS (.m3u8) or DASH (.mpd) + SCTE-35 cues
  audit-url <ad-request-url>                    Audit GAM/DAI/SpringServe/Publica/FreeWheel URL params
  brs --mode <mode> --url <tag-url>             Generate BrightScript Roku_Ads.brs integration snippet
  chaos --mode <fault> [--delay <ms>]           Inject proxy/mock faults (none | http-503 | corrupt-xml | timeout-hang | ...)
  cue-live [--session <id>] [--duration <sec>]  Cue an immediate SCTE-35 ad break on Live HLS stream
  sideload [--ip <roku-ip>] [--password <pw>]   Package & sideload roku-channel/ to Roku device
  attach [options]                              Launch/deep-link YOUR OWN channel in dev without sideloading
      --channel <id>            Channel ID (default: dev)
      --content-id <id>         Deep-link contentId (default: ep-101)
      --media-type <type>       movie | episode | shortFormVideo | live
      --hot                     Send warm /input event instead of cold /launch
      --duration <sec>          Seconds to monitor :8085 & :8080 (default: 12)
  screenshot [--ip <roku-ip>] [--out <file>]    Capture Roku TV screenshot via /plugin_inspect
  run [options]                                 Run end-to-end ad test on physical Roku & audit beacons
      --ip <roku-ip>            Target Roku IP (default from .env or SSDP)
      --scenario <slug>         Built-in mock scenario (e.g. single-preroll, pod-3-ads, ssai-hls)
      --tag <url>               Explicit ad tag / stream URL (overrides --scenario)
      --proxy                   Instrument & forward external ad tags through local /proxy/tag
      --mode <raf-mode>         csai | csai-stitched | csai-skippable | ssai | ssai-live | google-dai
      --timeout <sec>           Max wait seconds (default: 28)
      --screenshot              Capture mid-playback Roku screenshot
  suite [--ip <ip>] [--simulate] [--cases a,b]  Run 20-case Certification Suite & print scorecard
  har <file.har> [--name <label>]               Import & audit Charles / mitmproxy .har capture

Global Flags:
  --json                                        Emit strict machine-readable JSON to stdout
`);
}

async function main() {
  const env = loadEnv();
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const cmd = positional[0] || 'help';
  const asJson = Boolean(flags.json);
  const port = String(flags.port || env.PORT || '4321');
  const apiBase = String(flags.server || `http://127.0.0.1:${port}`);
  const lanBase = `http://${detectLanIp()}:${port}`;
  let defaultIp = String(flags.ip || env.ROKU_IP || '').trim();
  const defaultPw = String(flags.password || env.ROKU_DEV_PASSWORD || '');

  const requireRokuIp = async (): Promise<string> => {
    if (defaultIp) return defaultIp;
    const found = await discoverRokuDevices(1800).catch(() => []);
    if (found.length > 0) {
      defaultIp = found[0].ip;
      return defaultIp;
    }
    throw new Error('Missing Roku device IP. Pass --ip <roku-ip> or set ROKU_IP in .env.');
  };

  if (cmd === 'help' || flags.help) {
    printHelp();
    return;
  }

  if (cmd === 'serve' || cmd === 'start') {
    const { createAppServer, ensureTestMediaAssets } = await import('../server/index.js');
    ensureTestMediaAssets();
    const listenPort = Number(port);
    const { server } = createAppServer({ port: listenPort });
    await new Promise<void>((resolveListen) => {
      server.listen(listenPort, '0.0.0.0', () => {
        console.log(`[roku-raf-ad-tool] Workbench Server listening on:`);
        console.log(`  Local: http://127.0.0.1:${listenPort}`);
        console.log(`  LAN:   http://${detectLanIp()}:${listenPort}  (use this on Roku devices)`);
        resolveListen();
      });
    });
    await new Promise(() => {}); // Keep process alive until SIGINT/SIGTERM
    return;
  }

  if (cmd === 'mcp') {
    const mcpBin = join(ROOT, 'bin', 'roku-raf-mcp.mjs');
    const res = spawnSync(process.execPath, [mcpBin], { stdio: 'inherit', env: process.env });
    process.exit(res.status ?? 0);
  }

  if (cmd === 'status') {
    const serverInfo = await fetch(`${apiBase}/api/info`).then((r) => r.json()).catch(() => ({ running: false }));
    const targetIp = defaultIp || (await discoverRokuDevices(1500).then((d) => d[0]?.ip || '').catch(() => ''));
    const rokuInfo = targetIp
      ? await queryRokuDeviceInfo(targetIp)
      : { ip: '', reachable: false, error: 'No Roku IP configured (set ROKU_IP in .env or pass --ip <ip>)' };
    const payload = { server: serverInfo, roku: rokuInfo };
    output(payload, asJson, () =>
      [
        `Server   : ${serverInfo.lanBaseUrl ? `ONLINE (${serverInfo.lanBaseUrl})` : 'OFFLINE (run npm start or npm run dev)'}`,
        `Console  : ${serverInfo.consoleStatus?.connected ? `CONNECTED (${serverInfo.consoleStatus.ip}:8085)` : 'disconnected'}`,
        `Roku     : ${
          rokuInfo.reachable
            ? `ONLINE — ${rokuInfo.friendlyName} (${rokuInfo.modelName}, OS ${rokuInfo.softwareVersion}, RIDA ${rokuInfo.AdvertisingId ?? 'n/a'})`
            : `UNCONFIGURED / UNREACHABLE (${rokuInfo.error})`
        }`,
      ].join('\n')
    );
    return;
  }

  if (cmd === 'perf') {
    await requireRokuIp();
    const perf = await queryRokuPerformance8080(defaultIp);
    output(perf, asJson, () =>
      perf.reachable
        ? [
            `Device (:8080) : ${perf.banner || perf.ip}`,
            `Channel RAM    : ${perf.channelMemMb ?? 'n/a'} MB (${perf.channelMemKib ?? 'n/a'} KiB | anon=${perf.anonMemKib ?? 0} KiB)`,
            `Channel CPU    : ${perf.cpuTotalPct ?? 'n/a'}% (user=${perf.cpuUserPct ?? 0}%, sys=${perf.cpuSysPct ?? 0}%)`,
            `Texture VRAM   : ${perf.textureUsedMb ?? 'n/a'} MB used (${perf.textureUtilizationPct ?? 'n/a'}% of ${
              perf.textureMaxBytes ? Math.round(perf.textureMaxBytes / (1024 * 1024)) : '?'
            } MB pool)`,
            `SG Node Count  : ${perf.sgNodeCount ?? 'n/a'}`,
          ].join('\n')
        : `Port :8080 unreachable on ${defaultIp}: ${perf.error}`
    );
    process.exit(perf.reachable ? 0 : 1);
  }

  if (cmd === 'chaos') {
    const mode = (flags.mode as ChaosFaultMode) || (positional[1] as ChaosFaultMode) || 'none';
    const delayMs = Number(flags.delay || 0);
    const dropAtHop = Number(flags.hop || 2);
    const resp = await fetch(`${apiBase}/api/chaos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, delayMs, dropAtHop }),
    }).then((r) => r.json());
    output(resp, asJson, () => `Active Chaos Fault Mode -> ${resp.mode} (delayMs=${resp.delayMs}, dropAtHop=${resp.dropAtHop})`);
    return;
  }

  if (cmd === 'attach') {
    await requireRokuIp();
    const channelId = String(flags.channel || 'dev');
    const contentId = String(flags['content-id'] || flags.contentId || 'ep-101-pilot');
    const mediaType = (flags['media-type'] || flags.mediaType || 'episode') as RokuMediaType;
    const sessionId = String(flags.session || `attach-${Date.now().toString(36)}`);
    const durationSec = Number(flags.duration || 12);

    await fetch(`${apiBase}/api/roku/console/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: defaultIp, sessionId }),
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 450));
    await fetch(`${apiBase}/api/beacons/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});

    const launched = await launchExternalChannelOnRoku({
      ip: defaultIp,
      channelId,
      contentId,
      mediaType,
      useInputIfRunning: Boolean(flags.hot),
      sessionId,
    });

    await new Promise((r) => setTimeout(r, Math.max(2000, durationSec * 1000)));
    const perf8080 = await fetch(
      `${apiBase}/api/roku/perf?ip=${encodeURIComponent(defaultIp)}&session=${encodeURIComponent(sessionId)}`
    )
      .then((r) => r.json())
      .catch(() => null);
    const audit = await fetch(`${apiBase}/api/audit?session=${encodeURIComponent(sessionId)}&toleranceSec=2.5`).then(
      (r) => r.json()
    );
    const result = {
      sessionId,
      channelId,
      activeDevAppTitle: launched.activeDevAppTitle,
      endpoint: launched.endpoint,
      launchStatus: launched.status,
      certScore: audit.certScore,
      perf8080,
      timingMetrics: audit.timingMetrics,
      certChecks: audit.certChecks,
    };
    output(result, asJson, () =>
      [
        `Attached Channel : ${launched.activeDevAppTitle || channelId} (HTTP ${launched.status} via ${launched.endpoint})`,
        `Cert Score       : ${result.certScore}/100`,
        `Memory / VRAM    : RAM=${perf8080?.channelMemMb ?? 'n/a'} MB | VRAM=${perf8080?.textureUsedMb ?? 'n/a'} MB (${perf8080?.textureUtilizationPct ?? 'n/a'}%) | CPU=${perf8080?.cpuTotalPct ?? 'n/a'}%`,
      ].join('\n')
    );
    return;
  }

  if (cmd === 'validate') {
    const target = positional[1] || String(flags.url || '');
    if (!target) throw new Error('Usage: raf validate <url-or-xml-file>');
    const policy: RokuAdPolicyContext | undefined =
      flags['media-type'] || flags['content-length']
        ? {
            mediaType: flags['media-type'] ? (String(flags['media-type']) as RokuMediaType) : undefined,
            contentLengthSec: flags['content-length'] ? Number(flags['content-length']) : undefined,
          }
        : undefined;
    let report;
    if (/^https?:\/\//i.test(target)) {
      const unwrapped = await fetchAndUnwrapAdTag(target);
      report = validateAdTag(unwrapped.rawXml, {
        preParsed: unwrapped.parsed,
        expandedUrl: unwrapped.expandedUrl,
        policy,
      });
    } else {
      const xml = readFileSync(resolve(target), 'utf8');
      report = validateAdTag(xml, { policy });
    }
    output(report, asJson, () =>
      [
        `RAF Compatible : ${report.validForRaf ? 'YES' : 'NO'} (Score: ${report.score}/100)`,
        `Tag Format     : ${report.parsed.tagType} ${report.parsed.version ?? ''} | Ads: ${report.parsed.ads.length} | Breaks: ${report.parsed.adBreaks.length}`,
        ...report.issues.map((i) => `  [${i.severity.toUpperCase()}] ${i.code}: ${i.message}`),
      ].join('\n')
    );
    process.exit(report.validForRaf ? 0 : 1);
  }

  if (cmd === 'inspect-manifest') {
    const target = positional[1] || String(flags.url || '');
    if (!target) throw new Error('Usage: raf inspect-manifest <url-or-file>');
    const raw = /^https?:\/\//i.test(target)
      ? await fetch(target).then((r) => r.text())
      : readFileSync(resolve(target), 'utf8');
    const res = inspectStreamManifest(raw);
    output(res, asJson, () =>
      [
        `Format : ${res.format} (${res.isMaster ? 'Master' : res.isLive ? 'Live' : 'VOD'}) | Segments: ${res.segmentCount} | Duration: ${res.totalDurationSec}s`,
        `Cues   : ${res.adCues.length} (${res.adCues.map((c) => c.type).join(', ') || 'none'})`,
        ...res.issues.map((i) => `  [${i.severity.toUpperCase()}] ${i.code}: ${i.message}`),
      ].join('\n')
    );
    return;
  }

  if (cmd === 'audit-url') {
    const url = positional[1] || String(flags.url || '');
    if (!url) throw new Error('Usage: raf audit-url <ad-request-url>');
    const res = auditVendorAdRequestUrl(url);
    output(res, asJson, () =>
      [
        `Detected Vendor  : ${res.detectedVendor}`,
        `Compliance Score : ${res.score}/100`,
        ...res.findings.map((f) => `  [${f.status.toUpperCase()}] ${f.param}: ${f.message}`),
      ].join('\n')
    );
    process.exit(res.score >= 70 ? 0 : 1);
  }

  if (cmd === 'scan-repo') {
    const targetDir = positional[1] || String(flags.path || flags.dir || join(ROOT, 'roku-channel'));
    const report = scanRokuChannelRepo(resolve(targetDir));
    output(report, asJson, () =>
      [
        `Channel Path   : ${report.repoPath}`,
        `RAF Ready      : ${report.rafReady ? 'YES' : 'NO'} (Score: ${report.score}/100)`,
        `Files Scanned  : manifest=${report.filesScanned.manifestFound ? 'yes' : 'no'}, .brs=${report.filesScanned.brsFiles}, .xml=${report.filesScanned.xmlFiles}`,
        `Issues         : ${report.summary.errors} error(s), ${report.summary.warnings} warning(s), ${report.summary.infos} info`,
        ...report.findings.map(
          (f) =>
            `  [${f.severity.toUpperCase()}] ${f.code} (${f.file}${f.line ? `:${f.line}` : ''}): ${f.message}\n    Fix: ${f.fixHint}`
        ),
      ].join('\n')
    );
    process.exit(report.rafReady ? 0 : 1);
  }

  if (cmd === 'brs') {
    const mode = (flags.mode as RafPlaybackMode) || 'csai';
    const url = String(flags.url || positional[1] || `${lanBase}/mock/vast/single-preroll.xml`);
    const code = generateBrightScriptSnippet({
      mode,
      adTagOrStreamUrl: url,
      contentUrl: `${lanBase}/media/content-main.mp4`,
      prefs: DEFAULT_RAF_RUNTIME_PREFS,
    });
    if (asJson) {
      console.log(JSON.stringify({ mode, url, code }, null, 2));
    } else {
      console.log(code);
    }
    return;
  }

  if (cmd === 'cue-live') {
    const sessionId = String(flags.session || 'roku-tv');
    const durationSec = Number(flags.duration || 10);
    const resp = await fetch(`${apiBase}/api/live/cue-break`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, durationSec }),
    });
    const data = await resp.json();
    output(data, asJson, () =>
      `Cued ${data.cue.durationSec}s Live SCTE-35 break (${data.cue.id}) starting at MediaSeq #${data.cue.startMediaSeq}`
    );
    return;
  }

  if (cmd === 'sideload') {
    await requireRokuIp();
    if (!defaultPw) throw new Error('Missing password (--password or ROKU_DEV_PASSWORD in .env)');
    const zipBuffer = buildRokuChannelZip(lanBase);
    const res = await sideloadChannelToRoku({
      ip: defaultIp,
      password: defaultPw,
      zipBuffer,
    });
    await fetch(`${apiBase}/api/roku/console/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: defaultIp, sessionId: 'roku-tv' }),
    }).catch(() => {});
    output(res, asJson, () => `[HTTP ${res.status}] ${res.message}`);
    process.exit(res.ok ? 0 : 1);
  }

  if (cmd === 'screenshot') {
    await requireRokuIp();
    if (!defaultPw) throw new Error('Missing password (--password or ROKU_DEV_PASSWORD in .env)');
    const sessionId = String(flags.session || 'roku-tv');
    const shot = await captureRokuScreenshot({
      ip: defaultIp,
      password: defaultPw,
      sessionId,
    });
    const outPath = flags.out ? resolve(String(flags.out)) : resolve(ROOT, `data/screenshot-${Date.now()}.jpg`);
    const base64Part = shot.dataUrl.split(',')[1] || '';
    writeFileSync(outPath, Buffer.from(base64Part, 'base64'));
    const result = { id: shot.id, deviceIp: shot.deviceIp, timestamp: shot.timestamp, savedPath: outPath };
    output(result, asJson, () => `Saved Roku screenshot -> ${outPath}`);
    return;
  }

  if (cmd === 'run') {
    await requireRokuIp();
    const scenario = (flags.scenario as MockScenarioType) || 'single-preroll';
    const sessionId = String(flags.session || `run-${Date.now().toString(36)}`);
    const timeoutSec = Number(flags.timeout || 28);
    const takeShot = Boolean(flags.screenshot);

    let mode: RafPlaybackMode = (flags.mode as RafPlaybackMode) || 'csai';
    const rawExternalTag = flags.tag ? String(flags.tag) : flags.url ? String(flags.url) : '';
    let adTagUrl = rawExternalTag;
    let ssaiMetaUrl: string | undefined;

    if (adTagUrl && Boolean(flags.proxy) && !adTagUrl.includes('/proxy/tag')) {
      adTagUrl = `${lanBase}/proxy/tag?session=${encodeURIComponent(sessionId)}&forward=1&url=${encodeURIComponent(rawExternalTag)}`;
    }

    if (!adTagUrl) {
      if (scenario === 'ssai-hls') {
        mode = 'ssai';
        adTagUrl = `${lanBase}/mock/ssai/stream.m3u8?session=${sessionId}`;
        ssaiMetaUrl = `${lanBase}/mock/ssai/raf-metadata.json?session=${sessionId}`;
      } else if (scenario === 'ssai-live') {
        mode = 'ssai-live';
        adTagUrl = `${lanBase}/mock/live/master.m3u8?session=${sessionId}`;
        ssaiMetaUrl = `${lanBase}/mock/live/raf-metadata.json?session=${sessionId}`;
      } else if (scenario === 'google-dai-vod') {
        mode = 'google-dai';
        adTagUrl = `${lanBase}/mock/dai/ondemand/hls/content/2548831/vid/pilot/streams?session=${sessionId}`;
      } else {
        adTagUrl = `${lanBase}/mock/vast/${scenario}.xml?session=${sessionId}`;
      }
    }

    // Connect :8085 console, wait 450ms for Roku's historical ring-buffer replay, then clear session cleanly
    await fetch(`${apiBase}/api/roku/console/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: defaultIp, sessionId }),
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 450));
    await fetch(`${apiBase}/api/beacons/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});

    const launchResp = await fetch(`${apiBase}/api/roku/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ip: defaultIp,
        adTagUrl,
        contentUrl:
          mode === 'ssai' || mode === 'ssai-live'
            ? adTagUrl
            : String(flags.content || `${lanBase}/media/content-main.mp4`),
        adMode: mode,
        ssaiMetaUrl,
        sessionId,
        useInputIfRunning: Boolean(flags.hot),
      }),
    }).then((r) => r.json());

    let savedScreenshotPath: string | undefined;
    let shotCaptured = false;
    const startedMs = Date.now();
    const deadline = startedMs + timeoutSec * 1000;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const state = await fetch(`${apiBase}/api/beacons?session=${encodeURIComponent(sessionId)}`).then((r) =>
        r.json()
      );
      const evs: Array<{ kind: string; eventName: string }> = state.events ?? [];

      // Capture screenshot once ad playback has started!
      if (
        takeShot &&
        !shotCaptured &&
        defaultPw &&
        evs.some((e) => e.kind === 'impression' || e.eventName === 'PREROLL_START' || e.eventName === 'SSAI_INIT')
      ) {
        shotCaptured = true;
        await new Promise((r) => setTimeout(r, 1200));
        try {
          const shot = await fetch(`${apiBase}/api/roku/screenshot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip: defaultIp, password: defaultPw, sessionId }),
          }).then((r) => r.json());
          if (shot.dataUrl) {
            savedScreenshotPath = resolve(ROOT, `data/screenshot-${sessionId}.jpg`);
            writeFileSync(savedScreenshotPath, Buffer.from(shot.dataUrl.split(',')[1], 'base64'));
          }
        } catch {
          // ignore screenshot error during encrypted/transitional frame
        }
      }

      // Stop waiting as soon as Preroll/Ad pod finishes (for CSAI preroll tests) or full session finishes
      const isFullSchedule =
        scenario === 'vmap-schedule' ||
        scenario === 'gam-vmap-pod' ||
        /output=vmap/i.test(rawExternalTag) ||
        Boolean(flags['full-schedule']);
      const adDone = evs.some(
        (e) =>
          e.eventName === 'SESSION_FINISHED' ||
          (mode === 'csai' && !isFullSchedule && e.eventName === 'PREROLL_END')
      );
      if (adDone) {
        await new Promise((r) => setTimeout(r, 800));
        // Return Roku to menu cleanly if content video started after preroll
        if (!evs.some((e) => e.eventName === 'SESSION_FINISHED')) {
          await fetch(`${apiBase}/api/roku/keypress`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip: defaultIp, key: 'Back' }),
          }).catch(() => {});
        }
        break;
      }
    }

    const audit = await fetch(`${apiBase}/api/audit?session=${encodeURIComponent(sessionId)}&toleranceSec=2.5`).then(
      (r) => r.json()
    );
    const snap = await fetch(`${apiBase}/api/snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `CLI Run: ${scenario} [${mode}]`,
        sessionId,
        adTagUrl,
        toleranceSec: 2.5,
      }),
    }).then((r) => r.json());

    const summary = {
      sessionId,
      snapshotId: snap.id,
      rokuIp: defaultIp,
      mode,
      adTagUrl,
      launchStatus: launchResp.status,
      durationMs: Date.now() - startedMs,
      certScore: audit.certScore,
      expectedBeacons: audit.expectedCount,
      matchedBeacons: audit.matchedCount,
      missingBeacons: audit.missingCount,
      driftedBeacons: audit.driftedCount,
      certChecks: audit.certChecks,
      screenshotPath: savedScreenshotPath,
      eventsCount: snap.events?.length ?? 0,
      rafLogs: (snap.events ?? [])
        .filter((e: { kind: string }) => e.kind === 'raf_telemetry' || e.kind === 'console_log')
        .map((e: { eventName: string; details?: Record<string, unknown> }) => ({
          event: e.eventName,
          detail: e.details?.line ?? e.details?.detail ?? e.details,
        })),
    };

    output(summary, asJson, () =>
      [
        `=== Roku Hardware Ad Run Complete (${summary.sessionId}) ===`,
        `Device / Mode    : ${summary.rokuIp} [${summary.mode}]`,
        `Cert Score       : ${summary.certScore}/100`,
        `Beacons Matched  : ${summary.matchedBeacons}/${summary.expectedBeacons} (missing=${summary.missingBeacons}, drifted=${summary.driftedBeacons})`,
        `Saved Snapshot   : ${summary.snapshotId}${summary.screenshotPath ? ` | Screenshot: ${summary.screenshotPath}` : ''}`,
        `RAF Telemetry    : ${summary.rafLogs.length} lines captured`,
      ].join('\n')
    );
    return;
  }

  if (cmd === 'suite') {
    const simulate = Boolean(flags.simulate);
    if (!simulate) {
      await requireRokuIp();
    }
    const caseIds = typeof flags.cases === 'string' ? flags.cases.split(',').map((s) => s.trim()) : undefined;
    const started = await fetch(`${apiBase}/api/suite/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceIp: simulate ? '127.0.0.1' : defaultIp,
        password: defaultPw || undefined,
        captureScreenshots: Boolean(defaultPw && !simulate && flags.screenshot),
        simulateWithoutDevice: simulate,
        caseIds,
      }),
    }).then((r) => r.json());

    let finalRun = started;
    let lastPrintedCases = 0;
    for (let i = 0; i < 480; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const poll = await fetch(`${apiBase}/api/suite/runs`).then((r) => r.json());
      const found = (poll.runs ?? []).find((r: { id: string }) => r.id === started.id);
      if (found) {
        finalRun = found;
        const curCases: Array<{ passed: boolean; title: string; certScore: number; summary: string }> =
          found.cases ?? [];
        while (lastPrintedCases < curCases.length) {
          const c = curCases[lastPrintedCases];
          console.error(
            `[suite ${lastPrintedCases + 1}/${found.totalCount}] ${c.passed ? 'PASS' : 'FAIL'} ${c.title} (${c.certScore}/100) — ${c.summary}`
          );
          lastPrintedCases += 1;
        }
        if (found.status !== 'running') break;
      }
    }

    // Omit multi-MB base64 screenshot strings from CLI JSON stdout so agent context stays compact
    const compactRun = {
      ...finalRun,
      cases: (finalRun.cases ?? []).map((c: Record<string, unknown>) => {
        const { screenshotDataUrl, ...rest } = c;
        return { ...rest, hasScreenshot: Boolean(screenshotDataUrl) };
      }),
    };

    output(compactRun, asJson, () =>
      [
        `=== Suite "${finalRun.name}" (${finalRun.status.toUpperCase()}) ===`,
        `Overall Score : ${finalRun.overallScore}/100 (${finalRun.passedCount}/${finalRun.totalCount} passed)`,
        ...(finalRun.cases ?? []).map(
          (c: { passed: boolean; title: string; certScore: number; summary: string }) =>
            `  [${c.passed ? 'PASS' : 'FAIL'}] ${c.title} (${c.certScore}/100) — ${c.summary}`
        ),
      ].join('\n')
    );
    process.exit(finalRun.passedCount === finalRun.totalCount ? 0 : 1);
  }

  if (cmd === 'har') {
    const filePath = positional[1];
    if (!filePath) throw new Error('Usage: raf har <capture.har>');
    const snap = importHarArchive(readFileSync(resolve(filePath), 'utf8'), flags.name ? String(flags.name) : undefined);
    output(snap, asJson, () =>
      `Imported HAR "${snap.name}" -> Cert Score: ${snap.auditReport.certScore}/100 | Matched Beacons: ${snap.auditReport.matchedCount}/${snap.auditReport.expectedCount}`
    );
    return;
  }

  throw new Error(`Unknown command "${cmd}". Run with --help for usage.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
