#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateBrightScriptSnippet } from '../shared/brsCodeGenerator.js';
import { importHarArchive } from '../shared/harImporter.js';
import { inspectStreamManifest } from '../shared/manifestInspector.js';
import { validateAdTag } from '../shared/rafValidator.js';
import { scanRokuChannelRepo } from '../shared/repoScanner.js';
import {
  DEFAULT_RAF_RUNTIME_PREFS,
  type ChaosFaultMode,
  type RafPlaybackMode,
  type RokuAdPolicyContext,
  type RokuMediaType,
} from '../shared/types.js';
import { auditVendorAdRequestUrl } from '../shared/vendorTemplates.js';
import { detectLanIp } from '../server/networkInfo.js';
import {
  captureRokuScreenshot,
  launchExternalChannelOnRoku,
  queryRokuDeviceInfo,
  queryRokuPerformance8080,
} from '../server/rokuBridge.js';
import { fetchAndUnwrapAdTag } from '../server/tagProxy.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const PORT = process.env.PORT || '4321';
const API_BASE = process.env.RAF_API_URL || `http://127.0.0.1:${PORT}`;
const LAN_BASE = `http://${detectLanIp()}:${PORT}`;

const TOOLS = [
  {
    name: 'validate_ad_tag',
    description:
      'Validate a VAST (2.0-4.2), VMAP (1.0), or FreeWheel SmartXML string or remote URL against Roku RAF & Roku Ad-Load Certification policies, unrolling Wrapper chains.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Remote or local VAST/VMAP/SmartXML tag URL to fetch and unwrap' },
        xml: { type: 'string', description: 'Raw VAST, VMAP, or SmartXML string (if not passing url)' },
        mediaType: {
          type: 'string',
          enum: ['movie', 'episode', 'shortFormVideo', 'live', 'season', 'special'],
          description: 'Optional Roku content mediaType for short-form / midroll spacing policy checks',
        },
        contentLengthSec: {
          type: 'number',
          description: 'Optional content duration in seconds for Roku Ad-Load Certification policy checks',
        },
      },
    },
  },
  {
    name: 'inspect_stream_manifest',
    description: 'Inspect an HLS (.m3u8) or MPEG-DASH (.mpd) manifest for variants, #EXT-X-DATERANGE, #EXT-X-DISCONTINUITY, and SCTE-35 ad cues.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL of the .m3u8 or .mpd manifest' },
        text: { type: 'string', description: 'Raw manifest content (if not passing url)' },
      },
    },
  },
  {
    name: 'audit_vendor_ad_url',
    description: 'Audit a GAM, Google DAI, SpringServe, Publica, or FreeWheel CTV ad request URL for RIDA, Limit Ad Tracking, US-Privacy, GPP, and correlator compliance.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'Full outbound Roku ad request URL' },
      },
    },
  },
  {
    name: 'generate_raf_brightscript',
    description: 'Generate copy-ready Roku BrightScript SceneGraph Task code using Roku_Ads.brs for csai, csai-stitched, csai-skippable, ssai, ssai-live, or google-dai.',
    inputSchema: {
      type: 'object',
      required: ['mode', 'adTagOrStreamUrl'],
      properties: {
        mode: {
          type: 'string',
          enum: ['csai', 'csai-stitched', 'csai-skippable', 'ssai', 'ssai-live', 'google-dai'],
        },
        adTagOrStreamUrl: { type: 'string' },
        contentUrl: { type: 'string' },
      },
    },
  },
  {
    name: 'scan_roku_channel_repo',
    description:
      'Statically scan a Roku BrightScript / SceneGraph channel directory (manifest, .brs, .xml) for RAF certification violations, Render-thread violations, RIDA/LAT privacy leaks, and Roku OS 16 runtime crashes.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Path to the Roku channel source directory containing manifest' },
      },
    },
  },
  {
    name: 'roku_device_status',
    description: 'Query ECP device info, model, OS version, RIDA, and developer mode status of a Roku device on the LAN.',
    inputSchema: {
      type: 'object',
      required: ['ip'],
      properties: {
        ip: { type: 'string', description: 'Roku LAN IPv4 address on your local network' },
      },
    },
  },
  {
    name: 'cue_live_scte35_break',
    description: 'Cue an immediate SCTE-35 / #EXT-X-DATERANGE ad break in the local Live Linear HLS sliding-window stream.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', default: 'roku-tv' },
        durationSec: { type: 'number', default: 10 },
      },
    },
  },
  {
    name: 'get_session_beacon_audit',
    description: 'Retrieve captured beacons, Expected-vs-Actual beacon diff, quartile timing drift, and Roku Certification checks for a session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', default: 'roku-tv' },
        toleranceSec: { type: 'number', default: 1.5 },
      },
    },
  },
  {
    name: 'capture_roku_screenshot',
    description: 'Capture a developer channel screenshot from a Roku device via /plugin_inspect.',
    inputSchema: {
      type: 'object',
      required: ['ip', 'password'],
      properties: {
        ip: { type: 'string' },
        password: { type: 'string' },
        sessionId: { type: 'string', default: 'roku-tv' },
      },
    },
  },
  {
    name: 'import_har_file',
    description: 'Import and audit a Charles / mitmproxy .har capture file from disk.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Path to .har file' },
      },
    },
  },
  {
    name: 'roku_performance_profile',
    description:
      'Query Roku OS Debug Server (:8080) chanperf, r2d2_bitmaps, and sgnodes for live Channel RAM (MB), CPU %, GPU Texture VRAM utilization %, and SceneGraph node count.',
    inputSchema: {
      type: 'object',
      required: ['ip'],
      properties: {
        ip: { type: 'string', description: 'Roku LAN IPv4 address' },
      },
    },
  },
  {
    name: 'attach_external_roku_channel',
    description:
      'Deep-link launch (/launch) or warm input (/input) into ANY sideloaded dev or installed Roku channel with contentId & mediaType without overwriting the dev slot.',
    inputSchema: {
      type: 'object',
      required: ['ip', 'contentId', 'mediaType'],
      properties: {
        ip: { type: 'string' },
        channelId: { type: 'string', default: 'dev' },
        contentId: { type: 'string' },
        mediaType: {
          type: 'string',
          enum: ['movie', 'episode', 'shortFormVideo', 'live', 'season', 'special'],
        },
        useInputIfRunning: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'configure_chaos_fault',
    description:
      'Configure Ad Chaos / Network Fault injection on local /proxy/tag and Mock endpoints to test Roku channel resilience against ad server outages.',
    inputSchema: {
      type: 'object',
      required: ['mode'],
      properties: {
        mode: {
          type: 'string',
          enum: [
            'none',
            'latency',
            'http-503',
            'http-429',
            'timeout-hang',
            'corrupt-xml',
            'empty-vast-303',
            'drop-wrapper-hop',
            'media-500',
          ],
        },
        delayMs: { type: 'number', default: 0 },
        dropAtHop: { type: 'number', default: 2 },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'validate_ad_tag') {
    const policy: RokuAdPolicyContext | undefined =
      args.mediaType || args.contentLengthSec
        ? {
            mediaType: args.mediaType ? (String(args.mediaType) as RokuMediaType) : undefined,
            contentLengthSec: args.contentLengthSec ? Number(args.contentLengthSec) : undefined,
          }
        : undefined;
    if (typeof args.url === 'string' && args.url) {
      const unwrapped = await fetchAndUnwrapAdTag(args.url);
      return validateAdTag(unwrapped.rawXml, {
        preParsed: unwrapped.parsed,
        expandedUrl: unwrapped.expandedUrl,
        policy,
      });
    }
    return validateAdTag(String(args.xml || ''), { policy });
  }

  if (name === 'inspect_stream_manifest') {
    const raw =
      typeof args.url === 'string' && args.url
        ? await fetch(args.url).then((r) => r.text())
        : String(args.text || '');
    return inspectStreamManifest(raw);
  }

  if (name === 'audit_vendor_ad_url') {
    return auditVendorAdRequestUrl(String(args.url || ''));
  }

  if (name === 'generate_raf_brightscript') {
    return {
      code: generateBrightScriptSnippet({
        mode: (args.mode as RafPlaybackMode) || 'csai',
        adTagOrStreamUrl: String(args.adTagOrStreamUrl),
        contentUrl: args.contentUrl ? String(args.contentUrl) : `${LAN_BASE}/media/content-main.mp4`,
        prefs: DEFAULT_RAF_RUNTIME_PREFS,
      }),
    };
  }

  if (name === 'roku_device_status') {
    return queryRokuDeviceInfo(String(args.ip));
  }

  if (name === 'cue_live_scte35_break') {
    const resp = await fetch(`${API_BASE}/api/live/cue-break`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: args.sessionId || 'roku-tv',
        durationSec: Number(args.durationSec || 10),
      }),
    });
    return resp.json();
  }

  if (name === 'get_session_beacon_audit') {
    const sid = encodeURIComponent(String(args.sessionId || 'roku-tv'));
    const tol = Number(args.toleranceSec || 1.5);
    const resp = await fetch(`${API_BASE}/api/audit?session=${sid}&toleranceSec=${tol}`);
    return resp.json();
  }

  if (name === 'capture_roku_screenshot') {
    const shot = await captureRokuScreenshot({
      ip: String(args.ip),
      password: String(args.password),
      sessionId: String(args.sessionId || 'roku-tv'),
    });
    return { id: shot.id, deviceIp: shot.deviceIp, timestamp: shot.timestamp, mimeType: shot.mimeType };
  }

  if (name === 'import_har_file') {
    const raw = readFileSync(resolve(String(args.path)), 'utf8');
    return importHarArchive(raw);
  }

  if (name === 'scan_roku_channel_repo') {
    return scanRokuChannelRepo(resolve(String(args.path)));
  }

  if (name === 'roku_performance_profile') {
    return queryRokuPerformance8080(String(args.ip));
  }

  if (name === 'attach_external_roku_channel') {
    return launchExternalChannelOnRoku({
      ip: String(args.ip),
      channelId: args.channelId ? String(args.channelId) : 'dev',
      contentId: String(args.contentId),
      mediaType: (args.mediaType as RokuMediaType) || 'episode',
      useInputIfRunning: Boolean(args.useInputIfRunning),
    });
  }

  if (name === 'configure_chaos_fault') {
    const resp = await fetch(`${API_BASE}/api/chaos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: (args.mode as ChaosFaultMode) || 'none',
        delayMs: Number(args.delayMs || 0),
        dropAtHop: Number(args.dropAtHop || 2),
      }),
    });
    return resp.json();
  }

  throw new Error(`Unknown MCP tool: ${name}`);
}

let useHeaderFraming = false;

function sendResponse(payload: unknown): void {
  const json = JSON.stringify(payload);
  if (useHeaderFraming) {
    const byteLen = Buffer.byteLength(json, 'utf8');
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  if (req.method === 'notifications/initialized') return;

  if (req.method === 'initialize') {
    sendResponse({
      jsonrpc: '2.0',
      id: req.id ?? null,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'roku-raf-ad-tool', version: '0.2.0' },
      },
    });
    return;
  }

  if (req.method === 'ping') {
    sendResponse({ jsonrpc: '2.0', id: req.id ?? null, result: {} });
    return;
  }

  if (req.method === 'tools/list') {
    sendResponse({
      jsonrpc: '2.0',
      id: req.id ?? null,
      result: { tools: TOOLS },
    });
    return;
  }

  if (req.method === 'tools/call') {
    try {
      const toolName = String(req.params?.name || '');
      const toolArgs = ((req.params?.arguments as Record<string, unknown>) ?? {});
      const data = await callTool(toolName, toolArgs);
      sendResponse({
        jsonrpc: '2.0',
        id: req.id ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        },
      });
    } catch (err) {
      sendResponse({
        jsonrpc: '2.0',
        id: req.id ?? null,
        result: {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        },
      });
    }
    return;
  }

  if (req.id !== undefined) {
    sendResponse({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32601, message: `Method not found: ${req.method}` },
    });
  }
}

let rawBuf = Buffer.alloc(0);
process.stdin.on('data', (chunk: Buffer) => {
  rawBuf = Buffer.concat([rawBuf, chunk]);

  while (rawBuf.length > 0) {
    const str = rawBuf.toString('utf8');
    if (str.startsWith('Content-Length:')) {
      useHeaderFraming = true;
      const sepIdx = rawBuf.indexOf('\r\n\r\n');
      if (sepIdx === -1) return;
      const headerPart = rawBuf.subarray(0, sepIdx).toString('utf8');
      const lenMatch = headerPart.match(/Content-Length:\s*(\d+)/i);
      const bodyLen = lenMatch ? Number.parseInt(lenMatch[1], 10) : 0;
      const totalLen = sepIdx + 4 + bodyLen;
      if (rawBuf.length < totalLen) return;
      const bodyStr = rawBuf.subarray(sepIdx + 4, totalLen).toString('utf8');
      rawBuf = rawBuf.subarray(totalLen);
      void handleRequest(JSON.parse(bodyStr) as JsonRpcRequest);
    } else {
      const nlIdx = rawBuf.indexOf('\n');
      if (nlIdx === -1) return;
      const line = rawBuf.subarray(0, nlIdx).toString('utf8').trim();
      rawBuf = rawBuf.subarray(nlIdx + 1);
      if (line) {
        void handleRequest(JSON.parse(line) as JsonRpcRequest);
      }
    }
  }
});
