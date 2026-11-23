import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { BeaconStore } from './beaconStore.js';
import { buildLlmsTxt, buildOpenApiSpec } from './aiDocs.js';
import { buildRokuChannelZip } from './channelPackager.js';
import { GoogleDaiEmulator } from './daiEmulator.js';
import { AppDatabase, formatSnapshotAsMarkdown } from './db.js';
import { LiveHlsEngine } from './liveHlsEngine.js';
import { detectLanIp } from './networkInfo.js';
import {
  captureRokuScreenshot,
  discoverRokuDevices,
  launchExternalChannelOnRoku,
  launchTagOnRoku,
  queryRokuDeviceInfo,
  queryRokuInstalledDevApp,
  queryRokuMediaPlayer,
  queryRokuPerformance8080,
  RokuDebugConsoleBridge,
  sendRokuKeypress,
  sideloadChannelToRoku,
} from './rokuBridge.js';
import { AutomatedSuiteRunner, DEFAULT_SUITE_CASES } from './suiteRunner.js';
import { fetchAndUnwrapAdTag, instrumentAdXmlForProxy } from './tagProxy.js';

import {
  extractExpectedBeaconsFromParsedTag,
  extractExpectedBeaconsFromSsaiPods,
  runBeaconAndCertAudit,
} from '../shared/beaconAuditor.js';
import { generateBrightScriptSnippet } from '../shared/brsCodeGenerator.js';
import { importHarArchive } from '../shared/harImporter.js';
import { inspectStreamManifest } from '../shared/manifestInspector.js';
import {
  buildFromCustomConfig,
  generateMockVastXml,
  generateMockVmapXml,
  generateSsaiMediaPlaylist,
  generateSsaiRafMetadata,
} from '../shared/mockGenerator.js';
import { DEFAULT_RAF_MACROS } from '../shared/rafMacros.js';
import { validateAdTag } from '../shared/rafValidator.js';
import { scanRokuChannelRepo } from '../shared/repoScanner.js';
import {
  DEFAULT_RAF_RUNTIME_PREFS,
  type BeaconEventKind,
  type ChaosConfig,
  type ChaosFaultMode,
  type CustomMockConfig,
  type ExternalChannelAttachRequest,
  type MockScenarioType,
  type RafMacroValues,
  type RafPlaybackMode,
  type RafRuntimePrefs,
  type RokuAdPolicyContext,
  type RokuLaunchRequest,
  type SavedRokuDevice,
  type SessionSnapshot,
  type VendorBuildParams,
} from '../shared/types.js';
import { parseAdXml } from '../shared/vastParser.js';
import { auditVendorAdRequestUrl, buildVendorRequestTemplate } from '../shared/vendorTemplates.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_MEDIA_DIR = join(ROOT, 'public', 'media');
const DIST_CLIENT_DIR = join(ROOT, 'dist', 'client');

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
  '.mpd': 'application/dash+xml',
  '.ts': 'video/mp2t',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendXml(res: ServerResponse, status: number, xml: string): void {
  setCors(res);
  res.writeHead(status, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(xml);
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const raw = await readRawBody(req);
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

function classifyBeaconKind(eventName: string): BeaconEventKind {
  const lower = eventName.toLowerCase();
  if (lower === 'impression') return 'impression';
  if (['start', 'firstquartile', 'midpoint', 'thirdquartile', 'complete'].includes(lower)) {
    return 'quartile';
  }
  if (lower === 'error') return 'error';
  if (lower.includes('click')) return 'click';
  if (lower === 'breakstart' || lower === 'breakend') return 'vmap';
  return 'tracking';
}

function serveFileWithRanges(req: IncomingMessage, res: ServerResponse, filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const st = statSync(filePath);
  if (!st.isFile()) return false;

  setCors(res);
  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_MAP[ext] ?? 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const start = match[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match[2] ? Number.parseInt(match[2], 10) : st.size - 1;
      if (start >= 0 && end < st.size && start <= end) {
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Type': contentType,
        });
        createReadStream(filePath, { start, end }).pipe(res);
        return true;
      }
    }
  }

  res.writeHead(200, {
    'Content-Length': st.size,
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
  });
  createReadStream(filePath).pipe(res);
  return true;
}

export function createAppServer(options?: { port?: number; dbPath?: string }) {
  const db = new AppDatabase(options?.dbPath);
  const beaconStore = new BeaconStore();
  const liveEngine = new LiveHlsEngine();
  const daiEmulator = new GoogleDaiEmulator(liveEngine);
  const consoleBridge = new RokuDebugConsoleBridge(beaconStore);
  const suiteRunner = new AutomatedSuiteRunner(beaconStore, db, consoleBridge, liveEngine);
  const configuredPort = options?.port ?? Number(process.env.PORT || 4321);
  let activeChaos: ChaosConfig = { mode: 'none', delayMs: 0, dropAtHop: 2 };

  function resolveChaosForRequest(parsedUrl: URL): ChaosConfig {
    const queryMode = parsedUrl.searchParams.get('chaos') as ChaosFaultMode | null;
    if (queryMode && queryMode !== 'none') {
      return {
        mode: queryMode,
        delayMs: Number(parsedUrl.searchParams.get('delayMs') || (queryMode === 'latency' ? 3000 : 0)),
        dropAtHop: Number(parsedUrl.searchParams.get('dropAtHop') || 2),
      };
    }
    return activeChaos;
  }

  async function maybeInjectChaosResponse(opts: {
    chaos: ChaosConfig;
    hop: number;
    sessionId: string;
    reqUrl: string;
    userAgent?: string;
    remoteIp?: string;
    res: ServerResponse;
  }): Promise<boolean> {
    const { chaos, hop, sessionId, reqUrl, userAgent, remoteIp, res } = opts;
    if (chaos.mode === 'none') return false;

    if (chaos.mode === 'latency' && chaos.delayMs > 0) {
      await new Promise((r) => setTimeout(r, Math.min(15000, chaos.delayMs)));
      return false;
    }

    if (chaos.mode === 'timeout-hang') {
      beaconStore.record({
        sessionId,
        kind: 'tag_request',
        eventName: 'CHAOS_INJECTED_TIMEOUT',
        requestUrl: reqUrl,
        userAgent,
        remoteIp,
      });
      await new Promise((r) => setTimeout(r, 9500));
      setCors(res);
      res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Gateway Timeout (Chaos Injected)');
      return true;
    }

    if (chaos.mode === 'http-503' || (chaos.mode === 'drop-wrapper-hop' && hop >= chaos.dropAtHop)) {
      beaconStore.record({
        sessionId,
        kind: 'tag_request',
        eventName: 'CHAOS_INJECTED_HTTP_503',
        requestUrl: reqUrl,
        userAgent,
        remoteIp,
      });
      setCors(res);
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Service Unavailable (Chaos Injected)');
      return true;
    }

    if (chaos.mode === 'http-429') {
      beaconStore.record({
        sessionId,
        kind: 'tag_request',
        eventName: 'CHAOS_INJECTED_HTTP_429',
        requestUrl: reqUrl,
        userAgent,
        remoteIp,
      });
      setCors(res);
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '5' });
      res.end('Too Many Requests (Chaos Injected)');
      return true;
    }

    if (chaos.mode === 'corrupt-xml') {
      beaconStore.record({
        sessionId,
        kind: 'tag_request',
        eventName: 'CHAOS_INJECTED_CORRUPT_XML',
        requestUrl: reqUrl,
        userAgent,
        remoteIp,
      });
      sendXml(
        res,
        200,
        '<?xml version="1.0" encoding="UTF-8"?><VAST version="4.0"><Ad id="corrupt-1"><InLine><AdSystem>TruncatedChaosStream'
      );
      return true;
    }

    if (chaos.mode === 'empty-vast-303') {
      beaconStore.record({
        sessionId,
        kind: 'tag_request',
        eventName: 'CHAOS_INJECTED_EMPTY_VAST',
        requestUrl: reqUrl,
        userAgent,
        remoteIp,
      });
      sendXml(res, 200, '<?xml version="1.0" encoding="UTF-8"?><VAST version="4.0"/>');
      return true;
    }

    return false;
  }

  function registerXmlExpectations(sessionId: string, xml: string, url: string, podId = 'preroll'): void {
    const { parsed, xmlError } = parseAdXml(xml);
    if (!xmlError && parsed.tagType !== 'UNKNOWN') {
      const rawSpecs = extractExpectedBeaconsFromParsedTag(parsed, sessionId, podId);
      const specs =
        podId !== 'preroll' && podId !== 'proxied-pod'
          ? rawSpecs.map((s) => ({
              ...s,
              adId: s.adId.startsWith(`${podId}-`) ? s.adId : `${podId}-${s.adId}`,
            }))
          : rawSpecs;
      beaconStore.registerExpectedBeacons(sessionId, specs, { url, rawText: xml });
    }
  }

  const server: Server = createServer(async (req, res) => {
    try {
      setCors(res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = parsedUrl.pathname;

      const lanIp = detectLanIp();
      const addr = server.address();
      const boundAddr = typeof addr === 'object' && addr ? addr.address : '0.0.0.0';
      const isWildcardBind = boundAddr === '0.0.0.0' || boundAddr === '::';
      const hostHeader = req.headers.host || `${lanIp}:${configuredPort}`;
      const baseUrl =
        isWildcardBind && /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(hostHeader) && lanIp !== '127.0.0.1'
          ? `http://${lanIp}:${hostHeader.includes(':') ? hostHeader.split(':')[1] : configuredPort}`
          : `http://${hostHeader}`;

      const userAgent = req.headers['user-agent'];
      const remoteIp = req.socket.remoteAddress;

      // --- 1. Server Info, AI Discovery (/llms.txt, /api/openapi.json) & Runtime Defaults ---
      if (pathname === '/llms.txt' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(buildLlmsTxt(baseUrl));
        return;
      }

      if (pathname === '/api/openapi.json' && req.method === 'GET') {
        sendJson(res, 200, buildOpenApiSpec(baseUrl));
        return;
      }

      if (pathname === '/api/info' && req.method === 'GET') {
        sendJson(res, 200, {
          lanIp,
          port: configuredPort,
          lanBaseUrl: `http://${lanIp}:${configuredPort}`,
          defaultMacros: DEFAULT_RAF_MACROS,
          defaultRafPrefs: DEFAULT_RAF_RUNTIME_PREFS,
          consoleStatus: consoleBridge.getStatus(),
          activeSuiteRun: suiteRunner.getActiveRun(),
          chaos: activeChaos,
        });
        return;
      }

      if (pathname === '/api/chaos' && req.method === 'GET') {
        sendJson(res, 200, activeChaos);
        return;
      }

      if (pathname === '/api/chaos' && req.method === 'POST') {
        const body = await readJsonBody<Partial<ChaosConfig>>(req);
        activeChaos = {
          mode: (body.mode as ChaosFaultMode) || 'none',
          delayMs: Number(body.delayMs ?? 0),
          dropAtHop: Number(body.dropAtHop ?? 2),
        };
        sendJson(res, 200, activeChaos);
        return;
      }

      // --- 2. VAST / VMAP Validator, HLS/DASH Manifest Inspector & Vendor Tools ---
      if (pathname === '/api/validate' && req.method === 'POST') {
        const body = await readJsonBody<{
          xml?: string;
          url?: string;
          macros?: Partial<RafMacroValues>;
          policy?: RokuAdPolicyContext;
        }>(req);

        if (body.url && body.url.trim()) {
          const unwrapped = await fetchAndUnwrapAdTag(body.url.trim(), body.macros);
          const report = validateAdTag(unwrapped.rawXml, {
            preParsed: unwrapped.parsed,
            expandedUrl: unwrapped.expandedUrl,
            policy: body.policy,
          });
          sendJson(res, 200, report);
          return;
        }

        const report = validateAdTag(body.xml ?? '', { policy: body.policy });
        sendJson(res, 200, report);
        return;
      }

      if (pathname === '/api/inspect-manifest' && req.method === 'POST') {
        const body = await readJsonBody<{ text?: string; url?: string }>(req);
        let rawText = body.text ?? '';
        if (body.url && body.url.trim()) {
          const resp = await fetch(body.url.trim(), { signal: AbortSignal.timeout(8000) });
          rawText = await resp.text();
        }
        sendJson(res, 200, inspectStreamManifest(rawText));
        return;
      }

      if (pathname === '/api/vendor/build' && req.method === 'POST') {
        const body = await readJsonBody<{ params: VendorBuildParams; useLocalMock?: boolean }>(req);
        const built = buildVendorRequestTemplate(body.params, body.useLocalMock ? baseUrl : undefined);
        const audit = auditVendorAdRequestUrl(built.requestUrl);
        sendJson(res, 200, { ...built, audit });
        return;
      }

      if (pathname === '/api/vendor/audit' && req.method === 'POST') {
        const body = await readJsonBody<{ url: string }>(req);
        sendJson(res, 200, auditVendorAdRequestUrl(body.url || ''));
        return;
      }

      if (pathname === '/api/vendor/brs-snippet' && req.method === 'POST') {
        const body = await readJsonBody<{
          mode: RafPlaybackMode;
          adTagOrStreamUrl: string;
          contentUrl?: string;
          ssaiMetaUrl?: string;
          prefs?: Partial<RafRuntimePrefs>;
        }>(req);
        const snippet = generateBrightScriptSnippet({
          mode: body.mode || 'csai',
          adTagOrStreamUrl: body.adTagOrStreamUrl,
          contentUrl: body.contentUrl,
          ssaiMetaUrl: body.ssaiMetaUrl,
          prefs: { ...DEFAULT_RAF_RUNTIME_PREFS, ...(body.prefs ?? {}) },
        });
        sendJson(res, 200, { code: snippet });
        return;
      }

      if (pathname === '/api/scan-repo' && req.method === 'POST') {
        const body = await readJsonBody<{ repoPath?: string }>(req);
        const targetPath = body.repoPath?.trim() || join(ROOT, 'roku-channel');
        const scanReport = scanRokuChannelRepo(targetPath);
        sendJson(res, 200, scanReport);
        return;
      }

      // --- 3. SSE Stream, Beacons & Expected-vs-Actual Certification Audit ---
      if (pathname === '/api/events/stream' && req.method === 'GET') {
        beaconStore.attachSse(res);
        return;
      }

      if (pathname === '/api/beacons' && req.method === 'GET') {
        const session = parsedUrl.searchParams.get('session') ?? undefined;
        sendJson(res, 200, {
          events: beaconStore.getEvents(session),
          progress: beaconStore.getProgress(session),
          screenshots: beaconStore.getScreenshots(session),
        });
        return;
      }

      if (pathname === '/api/audit' && req.method === 'GET') {
        const sessionId = parsedUrl.searchParams.get('session') || 'roku-tv';
        const toleranceSec = Number(parsedUrl.searchParams.get('toleranceSec') || 1.5);
        const simulateLat = parsedUrl.searchParams.get('simulateLat') === '1';
        const audit = runBeaconAndCertAudit({
          sessionId,
          expected: beaconStore.getExpectedBeacons(sessionId),
          events: beaconStore.getEvents(sessionId),
          toleranceSec,
          simulateLat,
          rokuPerf8080: beaconStore.getPerf8080(sessionId),
        });
        sendJson(res, 200, audit);
        return;
      }

      if (pathname === '/api/beacons/clear' && req.method === 'POST') {
        const body = await readJsonBody<{ sessionId?: string }>(req);
        beaconStore.clear(body.sessionId);
        sendJson(res, 200, { cleared: true });
        return;
      }

      if (pathname === '/api/beacons/simulate' && req.method === 'POST') {
        const body = await readJsonBody<{
          sessionId?: string;
          adId?: string;
          podId?: string;
          includeError?: boolean;
        }>(req);
        const sessionId = body.sessionId || 'sim-session';
        const adId = body.adId || 'preroll-spot-1';
        const podId = body.podId || 'preroll';

        // Reset session and register matching 8s single-preroll expectations for clean full-ad simulation
        if (!body.includeError) {
          beaconStore.clear(sessionId);
          const mockXml = generateMockVastXml('single-preroll', { baseUrl, sessionId });
          registerXmlExpectations(sessionId, mockXml, `${baseUrl}/mock/vast/single-preroll.xml`, podId);
        }

        const baseEpoch = Date.now() - 8000;
        const steps: Array<{ event: string; kind: BeaconEventKind; offsetMs: number; errorCode?: string }> =
          body.includeError
            ? [
                { event: 'impression', kind: 'impression', offsetMs: 8000 },
                { event: 'error', kind: 'error', offsetMs: 8100, errorCode: '403' },
              ]
            : [
                { event: 'impression', kind: 'impression', offsetMs: 0 },
                { event: 'start', kind: 'quartile', offsetMs: 40 },
                { event: 'firstQuartile', kind: 'quartile', offsetMs: 2000 },
                { event: 'midpoint', kind: 'quartile', offsetMs: 4000 },
                { event: 'thirdQuartile', kind: 'quartile', offsetMs: 6000 },
                { event: 'complete', kind: 'quartile', offsetMs: 8000 },
              ];

        for (const st of steps) {
          beaconStore.record({
            sessionId,
            kind: st.kind,
            eventName: st.event,
            adId,
            podId,
            errorCode: st.errorCode,
            epochMs: baseEpoch + st.offsetMs,
            requestUrl: `${baseUrl}/api/beacon/hit?session=${sessionId}&event=${st.event}&adId=${adId}&podId=${podId}`,
            userAgent: 'Roku/DVP-12.5 (Simulated RAF Playback)',
            remoteIp: '127.0.0.1',
          });
        }

        sendJson(res, 200, {
          simulated: steps.length,
          events: beaconStore.getEvents(sessionId),
          progress: beaconStore.getProgress(sessionId),
        });
        return;
      }

      if (pathname === '/api/beacon/hit') {
        const sessionId = parsedUrl.searchParams.get('session') || 'default';
        const eventName = parsedUrl.searchParams.get('event') || (parsedUrl.searchParams.has('daiVerify') ? 'daiVerification' : 'unknown');
        const adId = parsedUrl.searchParams.get('adId') || undefined;
        const podId = parsedUrl.searchParams.get('podId') || undefined;
        const errorCode = parsedUrl.searchParams.get('errorCode') || undefined;
        const target = parsedUrl.searchParams.get('target') || undefined;
        const forward = parsedUrl.searchParams.get('forward') === '1';

        let forwardedStatus: number | undefined;
        if (forward && target) {
          const resolvedTarget = errorCode
            ? target.replace(/\[ERRORCODE\]/gi, encodeURIComponent(errorCode))
            : target;
          try {
            const upstream = await fetch(resolvedTarget, {
              method: 'GET',
              headers: userAgent ? { 'User-Agent': userAgent } : undefined,
              signal: AbortSignal.timeout(4000),
            });
            forwardedStatus = upstream.status;
          } catch {
            forwardedStatus = 0;
          }
        }

        beaconStore.record({
          sessionId,
          kind: classifyBeaconKind(eventName),
          eventName,
          adId,
          podId,
          errorCode,
          requestUrl: parsedUrl.toString(),
          originalUrl: target,
          method: req.method || 'GET',
          userAgent,
          remoteIp,
          forwardedStatus,
        });

        const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        res.writeHead(200, {
          'Content-Type': 'image/gif',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Content-Length': gif.length,
        });
        res.end(gif);
        return;
      }

      if (pathname === '/api/roku/telemetry' && req.method === 'POST') {
        const sessionId = parsedUrl.searchParams.get('session') || 'roku-tv';
        const body = await readJsonBody<Record<string, unknown>>(req);
        beaconStore.record({
          sessionId,
          kind: 'raf_telemetry',
          eventName: String(body.eventName || 'RAF_EVENT'),
          requestUrl: parsedUrl.toString(),
          method: 'POST',
          userAgent,
          remoteIp,
          details: body,
        });
        sendJson(res, 200, { ok: true });
        return;
      }

      // --- 4. Tag Instrumentation Proxy ---
      if (pathname === '/mock/chaos/media-500.mp4' && req.method === 'GET') {
        setCors(res);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal Server Error — Chaos Media 500');
        return;
      }

      if (pathname === '/proxy/tag' && req.method === 'GET') {
        const upstreamUrl = parsedUrl.searchParams.get('url');
        const sessionId = parsedUrl.searchParams.get('session') || 'proxy-session';
        const podId = parsedUrl.searchParams.get('podId') || 'proxied-pod';
        const hop = Number(parsedUrl.searchParams.get('hop') || 1);
        const forwardUpstream = parsedUrl.searchParams.get('forward') === '1';

        if (!upstreamUrl) {
          sendJson(res, 400, { error: 'Missing ?url= query parameter' });
          return;
        }

        const reqChaos = resolveChaosForRequest(parsedUrl);
        if (
          await maybeInjectChaosResponse({
            chaos: reqChaos,
            hop,
            sessionId,
            reqUrl: parsedUrl.toString(),
            userAgent,
            remoteIp,
            res,
          })
        ) {
          return;
        }

        beaconStore.record({
          sessionId,
          podId,
          kind: 'tag_request',
          eventName: 'PROXY_TAG_FETCH',
          requestUrl: parsedUrl.toString(),
          originalUrl: upstreamUrl,
          userAgent,
          remoteIp,
        });

        const upstreamResp = await fetch(upstreamUrl, {
          headers: {
            'User-Agent': userAgent || 'Roku/DVP-12.5 (RAF Proxy)',
            Accept: 'application/xml, text/xml, */*',
          },
          signal: AbortSignal.timeout(8000),
        });
        const upstreamXml = await upstreamResp.text();
        registerXmlExpectations(sessionId, upstreamXml, upstreamUrl, podId);
        let instrumented = instrumentAdXmlForProxy(upstreamXml, {
          baseUrl,
          sessionId,
          forwardUpstream,
          podId,
        });
        if (reqChaos.mode === 'media-500') {
          instrumented = instrumented.replace(
            /<MediaFile(\b[^>]*)>[\s\S]*?<\/MediaFile>/gi,
            (_m, attrs) => `<MediaFile${attrs}><![CDATA[${baseUrl}/mock/chaos/media-500.mp4]]></MediaFile>`
          );
        }
        sendXml(res, upstreamResp.status, instrumented);
        return;
      }

      // --- 5. Mock Ad Server, Live HLS SCTE-35 Studio & Google DAI Emulator ---
      if (pathname === '/api/mocks' && req.method === 'GET') {
        sendJson(res, 200, { customMocks: db.listCustomMocks() });
        return;
      }

      if (pathname === '/api/mocks' && req.method === 'POST') {
        const body = await readJsonBody<Partial<CustomMockConfig>>(req);
        const created: CustomMockConfig = {
          id: body.id || `custom-${randomUUID().slice(0, 8)}`,
          name: body.name || 'Custom RAF Pod',
          scenario: (body.scenario as MockScenarioType) || 'single-preroll',
          vastVersion: body.vastVersion === '3.0' ? '3.0' : '4.0',
          podSize: Number(body.podSize ?? 3),
          durationSec: Number(body.durationSec ?? 8),
          skippableAfterSec: body.skippableAfterSec ? Number(body.skippableAfterSec) : undefined,
          wrapperDepth: Number(body.wrapperDepth ?? 2),
          delayMs: Number(body.delayMs ?? 0),
          includeCompanion: Boolean(body.includeCompanion),
          sessionId: body.sessionId || 'default',
        };
        db.upsertCustomMock(created);
        sendJson(res, 201, created);
        return;
      }

      if (pathname.startsWith('/api/mocks/') && req.method === 'DELETE') {
        const id = pathname.slice('/api/mocks/'.length);
        db.deleteCustomMock(id);
        sendJson(res, 200, { deleted: id });
        return;
      }

      if (pathname.startsWith('/mock/custom/') && req.method === 'GET') {
        const id = pathname.slice('/mock/custom/'.length).replace(/\.xml$/i, '');
        const found = db.listCustomMocks().find((m) => m.id === id);
        if (!found) {
          sendJson(res, 404, { error: `Custom mock "${id}" not found` });
          return;
        }
        const sessionId = parsedUrl.searchParams.get('session') || found.sessionId || 'default';
        beaconStore.record({
          sessionId,
          kind: 'tag_request',
          eventName: `MOCK_CUSTOM_${found.scenario.toUpperCase()}`,
          requestUrl: parsedUrl.toString(),
          userAgent,
          remoteIp,
        });
        if (found.delayMs > 0) {
          await new Promise((r) => setTimeout(r, Math.min(15000, found.delayMs)));
        }
        const xml = buildFromCustomConfig({ ...found, sessionId }, baseUrl);
        registerXmlExpectations(sessionId, xml, parsedUrl.toString());
        sendXml(res, 200, xml);
        return;
      }

      if (pathname.startsWith('/mock/vast/') && req.method === 'GET') {
        const slug = pathname.slice('/mock/vast/'.length).replace(/\.xml$/i, '') as MockScenarioType;
        const sessionId = parsedUrl.searchParams.get('session') || 'default';
        const podId = parsedUrl.searchParams.get('pod') || 'preroll';
        const depth = Number(parsedUrl.searchParams.get('depth') || 2);
        const hop = Number(parsedUrl.searchParams.get('hop') || 1);
        const delayMs =
          slug === 'error-timeout'
            ? Number(parsedUrl.searchParams.get('delayMs') || 6000)
            : Number(parsedUrl.searchParams.get('delayMs') || 0);

        const reqChaos = resolveChaosForRequest(parsedUrl);
        if (
          await maybeInjectChaosResponse({
            chaos: reqChaos,
            hop,
            sessionId,
            reqUrl: parsedUrl.toString(),
            userAgent,
            remoteIp,
            res,
          })
        ) {
          return;
        }

        beaconStore.record({
          sessionId,
          kind: 'tag_request',
          eventName: `VAST_REQUEST (${slug})`,
          requestUrl: parsedUrl.toString(),
          userAgent,
          remoteIp,
        });

        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, Math.min(15000, delayMs)));
        }

        let xml = generateMockVastXml(slug, {
          baseUrl,
          sessionId,
          podId,
          wrapperDepth: depth,
          currentHop: hop,
        });
        if (reqChaos.mode === 'media-500') {
          xml = xml.replace(
            /<MediaFile(\b[^>]*)>[\s\S]*?<\/MediaFile>/gi,
            (_m, attrs) => `<MediaFile${attrs}><![CDATA[${baseUrl}/mock/chaos/media-500.mp4]]></MediaFile>`
          );
        }
        registerXmlExpectations(sessionId, xml, parsedUrl.toString(), podId);
        sendXml(res, 200, xml);
        return;
      }

      if (pathname === '/mock/vmap/schedule.xml' && req.method === 'GET') {
        const sessionId = parsedUrl.searchParams.get('session') || 'default';
        beaconStore.record({
          sessionId,
          kind: 'tag_request',
          eventName: 'VMAP_SCHEDULE_REQUEST',
          requestUrl: parsedUrl.toString(),
          userAgent,
          remoteIp,
        });
        const xml = generateMockVmapXml({ baseUrl, sessionId });
        registerXmlExpectations(sessionId, xml, parsedUrl.toString(), 'vmap');
        sendXml(res, 200, xml);
        return;
      }

      if (pathname === '/mock/ssai/stream.m3u8' && req.method === 'GET') {
        const sessionId = parsedUrl.searchParams.get('session') || 'default';
        beaconStore.record({
          sessionId,
          kind: 'tag_request',
          eventName: 'SSAI_HLS_PLAYLIST_REQUEST',
          requestUrl: parsedUrl.toString(),
          userAgent,
          remoteIp,
        });
        const m3u8 = generateSsaiMediaPlaylist(baseUrl);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store',
        });
        res.end(m3u8);
        return;
      }

      if (pathname === '/mock/ssai/raf-metadata.json' && req.method === 'GET') {
        const sessionId = parsedUrl.searchParams.get('session') || 'default';
        const pods = generateSsaiRafMetadata(baseUrl, sessionId);
        beaconStore.registerExpectedBeacons(
          sessionId,
          extractExpectedBeaconsFromSsaiPods(pods, sessionId, 'ssai')
        );
        sendJson(res, 200, pods);
        return;
      }

      if (pathname === '/mock/dash/stream.mpd' && req.method === 'GET') {
        const dashFile = join(PUBLIC_MEDIA_DIR, 'dash', 'stream.mpd');
        if (!existsSync(dashFile)) {
          sendJson(res, 404, { error: 'DASH manifest not generated yet' });
          return;
        }
        const rawMpd = await import('node:fs').then((fs) => fs.readFileSync(dashFile, 'utf8'));
        const withBaseUrl = rawMpd.replace(
          /<Period\b/i,
          `<BaseURL>${baseUrl}/media/dash/</BaseURL>\n\t<Period`
        );
        res.writeHead(200, {
          'Content-Type': 'application/dash+xml',
          'Cache-Control': 'no-store',
        });
        res.end(withBaseUrl);
        return;
      }

      // Live Linear HLS Sliding-Window + SCTE-35 Cue Trigger
      if (pathname === '/api/live/state' && req.method === 'GET') {
        const sessionId = parsedUrl.searchParams.get('session') || 'roku-tv';
        sendJson(res, 200, {
          mediaSequence: liveEngine.getCurrentMediaSequence(),
          cues: liveEngine.getActiveCues(sessionId),
          masterUrl: `${baseUrl}/mock/live/master.m3u8?session=${encodeURIComponent(sessionId)}`,
          playlistUrl: `${baseUrl}/mock/live/playlist.m3u8?session=${encodeURIComponent(sessionId)}`,
          metaUrl: `${baseUrl}/mock/live/raf-metadata.json?session=${encodeURIComponent(sessionId)}`,
        });
        return;
      }

      if (pathname === '/api/live/cue-break' && req.method === 'POST') {
        const body = await readJsonBody<{ sessionId?: string; durationSec?: number }>(req);
        const sessionId = body.sessionId || 'roku-tv';
        const cue = liveEngine.cueAdBreak({ sessionId, durationSec: body.durationSec ?? 10 });
        const pods = liveEngine.buildLiveRafMetadata(baseUrl, sessionId);
        beaconStore.registerExpectedBeacons(
          sessionId,
          extractExpectedBeaconsFromSsaiPods(pods, sessionId, 'ssai')
        );
        beaconStore.record({
          sessionId,
          kind: 'raf_telemetry',
          eventName: 'LIVE_SCTE35_BREAK_CUED',
          requestUrl: `${baseUrl}/mock/live/playlist.m3u8?session=${sessionId}`,
          details: { ...cue },
        });
        sendJson(res, 201, { cue, pods });
        return;
      }

      if (pathname === '/mock/live/master.m3u8' && req.method === 'GET') {
        const sessionId = parsedUrl.searchParams.get('session') || 'roku-tv';
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store',
        });
        res.end(liveEngine.buildMasterPlaylist(baseUrl, sessionId));
        return;
      }

      if (pathname === '/mock/live/playlist.m3u8' && req.method === 'GET') {
        const sessionId = parsedUrl.searchParams.get('session') || 'roku-tv';
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store',
        });
        res.end(liveEngine.buildLiveSlidingPlaylist(baseUrl, sessionId));
        return;
      }

      if (pathname === '/mock/live/raf-metadata.json' && req.method === 'GET') {
        const sessionId = parsedUrl.searchParams.get('session') || 'roku-tv';
        const pods = liveEngine.buildLiveRafMetadata(baseUrl, sessionId);
        beaconStore.registerExpectedBeacons(
          sessionId,
          extractExpectedBeaconsFromSsaiPods(pods, sessionId, 'ssai')
        );
        sendJson(res, 200, pods);
        return;
      }

      // Google DAI VOD & Live Stream Session Emulator
      const daiVodMatch = pathname.match(/^\/mock\/dai\/ondemand\/hls\/content\/([^/]+)\/vid\/([^/]+)\/streams$/);
      if (daiVodMatch && req.method === 'POST') {
        const rawForm = await readRawBody(req);
        const formParams = Object.fromEntries(new URLSearchParams(rawForm));
        const sessionId = parsedUrl.searchParams.get('session') || formParams.session || 'roku-tv';
        const daiResp = daiEmulator.createVodStream({
          baseUrl,
          sessionId,
          cmsId: daiVodMatch[1],
          videoId: daiVodMatch[2],
          params: formParams,
        });
        beaconStore.record({
          sessionId,
          kind: 'tag_request',
          eventName: 'GOOGLE_DAI_VOD_STREAM_CREATE',
          requestUrl: `${parsedUrl.toString()}${rawForm ? `?${rawForm}` : ''}`,
          method: 'POST',
          userAgent,
          remoteIp,
          details: formParams,
        });
        beaconStore.registerExpectedBeacons(
          sessionId,
          extractExpectedBeaconsFromSsaiPods(daiResp.ad_pods, sessionId, 'dai')
        );
        sendJson(res, 201, daiResp);
        return;
      }

      const daiLiveMatch = pathname.match(/^\/mock\/dai\/live\/hls\/asset\/([^/]+)\/streams$/);
      if (daiLiveMatch && req.method === 'POST') {
        const rawForm = await readRawBody(req);
        const formParams = Object.fromEntries(new URLSearchParams(rawForm));
        const sessionId = parsedUrl.searchParams.get('session') || formParams.session || 'roku-tv';
        const daiResp = daiEmulator.createLiveStream({
          baseUrl,
          sessionId,
          assetKey: daiLiveMatch[1],
          params: formParams,
        });
        beaconStore.record({
          sessionId,
          kind: 'tag_request',
          eventName: 'GOOGLE_DAI_LIVE_STREAM_CREATE',
          requestUrl: `${parsedUrl.toString()}${rawForm ? `?${rawForm}` : ''}`,
          method: 'POST',
          userAgent,
          remoteIp,
          details: formParams,
        });
        beaconStore.registerExpectedBeacons(
          sessionId,
          extractExpectedBeaconsFromSsaiPods(daiResp.ad_pods, sessionId, 'dai')
        );
        sendJson(res, 201, daiResp);
        return;
      }

      const daiMetaMatch = pathname.match(/^\/mock\/dai\/stream\/([^/]+)\/metadata$/);
      if (daiMetaMatch && req.method === 'GET') {
        const meta = daiEmulator.getStreamMetadata(daiMetaMatch[1], baseUrl);
        if (!meta) {
          sendJson(res, 404, { error: 'Unknown DAI stream_id' });
          return;
        }
        sendJson(res, 200, meta);
        return;
      }

      // --- 6. Multi-Roku Device Roster, Sideloader, Screenshots & Suite Runner ---
      if (pathname === '/api/devices' && req.method === 'GET') {
        sendJson(res, 200, { devices: db.listDevices() });
        return;
      }

      if (pathname === '/api/devices' && req.method === 'POST') {
        const body = await readJsonBody<Partial<SavedRokuDevice>>(req);
        const saved = db.upsertDevice({
          id: body.id || `roku-${randomUUID().slice(0, 8)}`,
          name: body.name || `Roku (${body.ip})`,
          ip: (body.ip || '').trim(),
          username: body.username || 'rokudev',
          password: body.password || '',
          modelName: body.modelName,
          softwareVersion: body.softwareVersion,
          serialNumber: body.serialNumber,
          lastSeenAt: new Date().toISOString(),
        });
        sendJson(res, 201, saved);
        return;
      }

      if (pathname.startsWith('/api/devices/') && req.method === 'DELETE') {
        const id = pathname.slice('/api/devices/'.length);
        db.deleteDevice(id);
        sendJson(res, 200, { deleted: id });
        return;
      }

      if (pathname === '/api/channel/package.zip' && req.method === 'GET') {
        const customServerUrl = parsedUrl.searchParams.get('serverUrl') || baseUrl;
        const zipBuf = buildRokuChannelZip(customServerUrl);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="roku-raf-harness.zip"',
          'Content-Length': zipBuf.length,
        });
        res.end(zipBuf);
        return;
      }

      if (pathname === '/api/roku/discover' && req.method === 'GET') {
        const devices = await discoverRokuDevices();
        sendJson(res, 200, { devices });
        return;
      }

      if (pathname === '/api/roku/device-info' && req.method === 'GET') {
        const ip = parsedUrl.searchParams.get('ip');
        if (!ip) {
          sendJson(res, 400, { error: 'Missing ?ip=' });
          return;
        }
        const info = await queryRokuDeviceInfo(ip);
        let player = null;
        let devSlot = null;
        if (info.reachable) {
          try {
            player = await queryRokuMediaPlayer(ip);
          } catch {
            player = null;
          }
          try {
            devSlot = await queryRokuInstalledDevApp(ip);
          } catch {
            devSlot = null;
          }
        }
        sendJson(res, 200, { info, player, devSlot, console: consoleBridge.getStatus() });
        return;
      }

      if (pathname === '/api/roku/perf' && req.method === 'GET') {
        const ip = parsedUrl.searchParams.get('ip');
        const sessionId = parsedUrl.searchParams.get('session');
        if (!ip) {
          sendJson(res, 400, { error: 'Missing ?ip=' });
          return;
        }
        const snap = await queryRokuPerformance8080(ip);
        if (sessionId && snap.reachable) {
          beaconStore.setPerf8080(sessionId, snap);
        }
        sendJson(res, 200, snap);
        return;
      }

      if (pathname === '/api/roku/dev-slot' && req.method === 'GET') {
        const ip = parsedUrl.searchParams.get('ip');
        if (!ip) {
          sendJson(res, 400, { error: 'Missing ?ip=' });
          return;
        }
        const slot = await queryRokuInstalledDevApp(ip);
        sendJson(res, 200, slot);
        return;
      }

      if (pathname === '/api/roku/attach' && req.method === 'POST') {
        const body = await readJsonBody<ExternalChannelAttachRequest>(req);
        const sessionId = body.sessionId || 'roku-tv';
        await consoleBridge.connect(body.ip, sessionId).catch(() => {});
        const launched = await launchExternalChannelOnRoku({ ...body, sessionId });
        sendJson(res, 200, launched);
        return;
      }

      if (pathname === '/api/roku/keypress' && req.method === 'POST') {
        const body = await readJsonBody<{ ip: string; key: string }>(req);
        await sendRokuKeypress(body.ip, body.key);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/roku/launch' && req.method === 'POST') {
        const body = await readJsonBody<RokuLaunchRequest>(req);
        const result = await launchTagOnRoku(body, baseUrl);
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/roku/sideload' && req.method === 'POST') {
        const body = await readJsonBody<{
          ip: string;
          username?: string;
          password: string;
          serverUrl?: string;
        }>(req);
        const zipBuffer = buildRokuChannelZip(body.serverUrl || baseUrl);
        const result = await sideloadChannelToRoku({
          ip: body.ip,
          username: body.username,
          password: body.password,
          zipBuffer,
        });
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (pathname === '/api/roku/screenshot' && req.method === 'POST') {
        const body = await readJsonBody<{
          ip: string;
          username?: string;
          password: string;
          sessionId?: string;
        }>(req);
        const shot = await captureRokuScreenshot({
          ip: body.ip,
          username: body.username,
          password: body.password,
          sessionId: body.sessionId || 'roku-tv',
        });
        beaconStore.addScreenshot(shot);
        sendJson(res, 200, shot);
        return;
      }

      if (pathname === '/api/roku/console/connect' && req.method === 'POST') {
        const body = await readJsonBody<{ ip: string; sessionId?: string }>(req);
        const status = await consoleBridge.connect(body.ip, body.sessionId);
        sendJson(res, 200, status);
        return;
      }

      if (pathname === '/api/roku/console/disconnect' && req.method === 'POST') {
        consoleBridge.disconnect();
        sendJson(res, 200, consoleBridge.getStatus());
        return;
      }

      // Automated Certification Suite Runner
      if (pathname === '/api/suite/presets' && req.method === 'GET') {
        sendJson(res, 200, { cases: DEFAULT_SUITE_CASES });
        return;
      }

      if (pathname === '/api/suite/runs' && req.method === 'GET') {
        sendJson(res, 200, {
          activeRun: suiteRunner.getActiveRun(),
          runs: db.listSuiteRuns(),
        });
        return;
      }

      if (pathname === '/api/suite/start' && req.method === 'POST') {
        const body = await readJsonBody<{
          name?: string;
          deviceIp: string;
          password?: string;
          captureScreenshots?: boolean;
          simulateWithoutDevice?: boolean;
          caseIds?: string[];
          rafPrefs?: Partial<RafRuntimePrefs>;
        }>(req);
        const run = await suiteRunner.startSuite({
          ...body,
          baseUrl,
        });
        sendJson(res, 201, run);
        return;
      }

      if (pathname === '/api/suite/abort' && req.method === 'POST') {
        suiteRunner.abort();
        sendJson(res, 200, { aborted: true });
        return;
      }

      // --- 7. Session Snapshots, HAR Import & JSON/Markdown Export ---
      if (pathname === '/api/snapshots' && req.method === 'GET') {
        sendJson(res, 200, { snapshots: db.listSnapshots() });
        return;
      }

      if (pathname === '/api/snapshots' && req.method === 'POST') {
        const body = await readJsonBody<{
          name?: string;
          sessionId?: string;
          notes?: string;
          adTagUrl?: string;
          toleranceSec?: number;
        }>(req);
        const sessionId = body.sessionId || 'roku-tv';
        const expectedBeacons = beaconStore.getExpectedBeacons(sessionId);
        const events = beaconStore.getEvents(sessionId);
        const lastPayload = beaconStore.getLastServedPayload(sessionId);
        const auditReport = runBeaconAndCertAudit({
          sessionId,
          expected: expectedBeacons,
          events,
          toleranceSec: body.toleranceSec,
          rokuPerf8080: beaconStore.getPerf8080(sessionId),
        });
        const snap: SessionSnapshot = {
          id: `snap-${randomUUID().slice(0, 8)}`,
          name: body.name || `Session ${sessionId} (${new Date().toLocaleString()})`,
          source: 'live',
          createdAt: new Date().toISOString(),
          sessionId,
          adTagUrl: body.adTagUrl || lastPayload?.url,
          rawXmlOrManifest: lastPayload?.rawText,
          expectedBeacons,
          events,
          auditReport,
          screenshots: beaconStore.getScreenshots(sessionId),
          notes: body.notes,
        };
        db.saveSnapshot(snap);
        sendJson(res, 201, snap);
        return;
      }

      if (pathname === '/api/snapshots/import-har' && req.method === 'POST') {
        const body = await readJsonBody<{ harJson: string; name?: string }>(req);
        const snap = importHarArchive(body.harJson, body.name);
        db.saveSnapshot(snap);
        sendJson(res, 201, snap);
        return;
      }

      if (pathname === '/api/snapshots/import-json' && req.method === 'POST') {
        const body = await readJsonBody<{ snapshot: SessionSnapshot }>(req);
        const imported: SessionSnapshot = {
          ...body.snapshot,
          id: body.snapshot.id || `snap-${randomUUID().slice(0, 8)}`,
          createdAt: body.snapshot.createdAt || new Date().toISOString(),
        };
        db.saveSnapshot(imported);
        sendJson(res, 201, imported);
        return;
      }

      const snapExportMdMatch = pathname.match(/^\/api\/snapshots\/([^/]+)\/export\.md$/);
      if (snapExportMdMatch && req.method === 'GET') {
        const snap = db.getSnapshot(snapExportMdMatch[1]);
        if (!snap) {
          sendJson(res, 404, { error: 'Snapshot not found' });
          return;
        }
        const md = formatSnapshotAsMarkdown(snap);
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${snap.id}-report.md"`,
        });
        res.end(md);
        return;
      }

      const snapExportJsonMatch = pathname.match(/^\/api\/snapshots\/([^/]+)\/export\.json$/);
      if (snapExportJsonMatch && req.method === 'GET') {
        const snap = db.getSnapshot(snapExportJsonMatch[1]);
        if (!snap) {
          sendJson(res, 404, { error: 'Snapshot not found' });
          return;
        }
        const jsonStr = JSON.stringify(snap, null, 2);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${snap.id}-bundle.json"`,
        });
        res.end(jsonStr);
        return;
      }

      if (pathname.startsWith('/api/snapshots/') && req.method === 'GET') {
        const id = pathname.slice('/api/snapshots/'.length);
        const snap = db.getSnapshot(id);
        if (!snap) {
          sendJson(res, 404, { error: 'Snapshot not found' });
          return;
        }
        sendJson(res, 200, snap);
        return;
      }

      if (pathname.startsWith('/api/snapshots/') && req.method === 'DELETE') {
        const id = pathname.slice('/api/snapshots/'.length);
        db.deleteSnapshot(id);
        sendJson(res, 200, { deleted: id });
        return;
      }

      // --- 8. Static Test Media (/media/*) ---
      if (pathname.startsWith('/media/')) {
        const rel = normalize(pathname.slice('/media/'.length)).replace(/^(\.\.(\/|\\|$))+/, '');
        const targetFile = join(PUBLIC_MEDIA_DIR, rel);
        if (serveFileWithRanges(req, res, targetFile)) {
          return;
        }
        sendJson(res, 404, { error: `Media asset not found: ${rel}` });
        return;
      }

      // --- 9. Built Frontend SPA (production mode) ---
      if (existsSync(DIST_CLIENT_DIR)) {
        const cleanRel =
          pathname === '/' ? 'index.html' : normalize(pathname.slice(1)).replace(/^(\.\.(\/|\\|$))+/, '');
        const candidate = join(DIST_CLIENT_DIR, cleanRel);
        if (serveFileWithRanges(req, res, candidate)) return;
        const fallbackIndex = join(DIST_CLIENT_DIR, 'index.html');
        if (serveFileWithRanges(req, res, fallbackIndex)) return;
      }

      sendJson(res, 404, { error: `Route not found: ${pathname}` });
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return { server, db, beaconStore, liveEngine, daiEmulator, consoleBridge, suiteRunner };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (isMain) {
  const port = Number(process.env.PORT || 4321);
  const { server } = createAppServer({ port });
  server.listen(port, '0.0.0.0', () => {
    const lanIp = detectLanIp();
    console.log(`[roku-raf-ad-tool] Workbench Server listening on:`);
    console.log(`  Local: http://127.0.0.1:${port}`);
    console.log(`  LAN:   http://${lanIp}:${port}  (use this on Roku devices)`);
  });
}
