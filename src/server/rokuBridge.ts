import { createHash, randomBytes, randomUUID } from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';
import { XMLParser } from 'fast-xml-parser';
import type { BeaconStore } from './beaconStore.js';
import type {
  ExternalChannelAttachRequest,
  RokuDeviceInfo,
  RokuLaunchRequest,
  RokuMediaPlayerState,
  RokuPerfSnapshot,
  ScreenshotRecord,
} from '../shared/types.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

export async function discoverRokuDevices(timeoutMs = 1800): Promise<Array<{ ip: string; location: string }>> {
  return new Promise((resolve) => {
    const found = new Map<string, string>();
    let socket: dgram.Socket | null = null;

    const finish = () => {
      if (socket) {
        try {
          socket.close();
        } catch {
          // ignore
        }
        socket = null;
      }
      resolve(Array.from(found.entries()).map(([ip, location]) => ({ ip, location })));
    };

    try {
      socket = dgram.createSocket('udp4');
      socket.on('error', () => finish());
      socket.on('message', (msg, rinfo) => {
        const text = msg.toString('utf8');
        if (/roku:ecp/i.test(text) || /:8060/i.test(text)) {
          const locMatch = text.match(/^LOCATION:\s*(.+)$/im);
          found.set(rinfo.address, locMatch ? locMatch[1].trim() : `http://${rinfo.address}:8060/`);
        }
      });

      socket.bind(0, () => {
        const query = Buffer.from(
          [
            'M-SEARCH * HTTP/1.1',
            'HOST: 239.255.255.250:1900',
            'MAN: "ssdp:discover"',
            'ST: roku:ecp',
            'MX: 2',
            '',
            '',
          ].join('\r\n')
        );
        socket?.send(query, 0, query.length, 1900, '239.255.255.250');
      });

      setTimeout(finish, timeoutMs);
    } catch {
      finish();
    }
  });
}

export async function queryRokuDeviceInfo(ip: string): Promise<RokuDeviceInfo> {
  const cleanIp = ip.trim();
  try {
    const resp = await fetch(`http://${cleanIp}:8060/query/device-info`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) {
      return { ip: cleanIp, reachable: false, error: `ECP HTTP ${resp.status}` };
    }
    const rawXml = await resp.text();
    const doc = xmlParser.parse(rawXml) as Record<string, Record<string, unknown>>;
    const info = doc['device-info'] ?? {};

    return {
      ip: cleanIp,
      reachable: true,
      friendlyName: String(info['friendly-device-name'] ?? info['user-device-name'] ?? 'Roku Device'),
      modelName: String(info['model-name'] ?? ''),
      modelNumber: String(info['model-number'] ?? ''),
      serialNumber: String(info['serial-number'] ?? ''),
      softwareVersion: `${info['software-version'] ?? ''} (${info['software-build'] ?? ''})`.trim(),
      developerEnabled: String(info['developer-enabled']) === 'true',
      AdvertisingId: info['advertising-id'] ? String(info['advertising-id']) : undefined,
      rawXml,
    };
  } catch (err) {
    return {
      ip: cleanIp,
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function queryRokuMediaPlayer(ip: string): Promise<RokuMediaPlayerState> {
  const resp = await fetch(`http://${ip.trim()}:8060/query/media-player`, {
    signal: AbortSignal.timeout(2500),
  });
  const rawXml = await resp.text();
  const doc = xmlParser.parse(rawXml) as Record<string, Record<string, unknown>>;
  const p = doc.player ?? {};
  const plugin = (p.plugin as Record<string, unknown> | undefined) ?? {};

  return {
    state: p['@_state'] ? String(p['@_state']) : undefined,
    isLive: p['@_is_live'] !== undefined ? String(p['@_is_live']) === 'true' : undefined,
    position: p.position ? String(p.position) : undefined,
    duration: p.duration ? String(p.duration) : undefined,
    pluginId: plugin['@_id'] ? String(plugin['@_id']) : undefined,
    pluginName: plugin['@_name'] ? String(plugin['@_name']) : undefined,
    rawXml,
  };
}

export async function sendRokuKeypress(ip: string, key: string): Promise<void> {
  const resp = await fetch(`http://${ip.trim()}:8060/keypress/${encodeURIComponent(key)}`, {
    method: 'POST',
    signal: AbortSignal.timeout(2500),
  });
  if (!resp.ok) {
    throw new Error(`ECP keypress failed: HTTP ${resp.status}`);
  }
}

export async function launchTagOnRoku(
  req: RokuLaunchRequest,
  serverBaseUrl: string
): Promise<{ endpoint: string; status: number }> {
  const ip = req.ip.trim();
  const channelId = req.channelId || 'dev';
  const q = new URLSearchParams({
    adTagUrl: req.adTagUrl,
    adMode: req.adMode || 'csai',
    serverUrl: serverBaseUrl,
    sessionId: req.sessionId || 'roku-tv',
  });
  if (req.contentUrl) q.set('contentUrl', req.contentUrl);
  if (req.ssaiMetaUrl) q.set('ssaiMetaUrl', req.ssaiMetaUrl);
  if (req.daiStreamUrl) q.set('daiStreamUrl', req.daiStreamUrl);

  if (req.rafPrefs) {
    if (req.rafPrefs.enableAdMeasurements !== undefined) {
      q.set('enableAdMeasurements', req.rafPrefs.enableAdMeasurements ? '1' : '0');
    }
    if (req.rafPrefs.maxResolution) q.set('maxResolution', req.rafPrefs.maxResolution);
    if (req.rafPrefs.useRokuAdsFallback !== undefined) {
      q.set('useFallback', req.rafPrefs.useRokuAdsFallback ? '1' : '0');
    }
    if (req.rafPrefs.maxRequests !== undefined) q.set('maxRequests', String(req.rafPrefs.maxRequests));
    if (req.rafPrefs.contentId) q.set('contentId', req.rafPrefs.contentId);
    if (req.rafPrefs.contentGenre) q.set('contentGenre', req.rafPrefs.contentGenre);
    if (req.rafPrefs.contentLengthSec !== undefined) {
      q.set('contentLength', String(req.rafPrefs.contentLengthSec));
    }
    if (req.rafPrefs.showDebugHud !== undefined) {
      q.set('showDebugHud', req.rafPrefs.showDebugHud ? '1' : '0');
    }
    if (req.rafPrefs.simulateLat !== undefined) {
      q.set('simulateLat', req.rafPrefs.simulateLat ? '1' : '0');
    }
  }

  const path = req.useInputIfRunning
    ? `/input?${q.toString()}`
    : `/launch/${encodeURIComponent(channelId)}?${q.toString()}`;
  const endpoint = `http://${ip}:8060${path}`;
  const resp = await fetch(endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(4000),
  });
  return { endpoint, status: resp.status };
}

/**
 * Launches or deep-links ANY sideloaded (`dev`) or installed Roku channel with standard Roku Certification 4.x
 * parameters (`contentId`, `mediaType`, plus arbitrary query params) without overwriting the `dev` slot.
 */
export async function launchExternalChannelOnRoku(
  req: ExternalChannelAttachRequest
): Promise<{ endpoint: string; status: number; activeDevAppTitle?: string }> {
  const ip = req.ip.trim();
  const channelId = req.channelId || 'dev';
  const q = new URLSearchParams({
    contentId: req.contentId,
    mediaType: req.mediaType,
  });
  if (req.sessionId) q.set('sessionId', req.sessionId);
  for (const [k, v] of Object.entries(req.extraParams ?? {})) {
    if (k.trim()) q.set(k.trim(), String(v));
  }

  const devSlot = await queryRokuInstalledDevApp(ip).catch(() => null);
  const path = req.useInputIfRunning
    ? `/input?${q.toString()}`
    : `/launch/${encodeURIComponent(channelId)}?${q.toString()}`;
  const endpoint = `http://${ip}:8060${path}`;
  const resp = await fetch(endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(4000),
  });
  return {
    endpoint,
    status: resp.status,
    activeDevAppTitle: devSlot?.devAppTitle,
  };
}

export async function queryRokuInstalledDevApp(ip: string): Promise<{
  hasDevApp: boolean;
  devAppTitle?: string;
  devAppVersion?: string;
  activeAppTitle?: string;
  isOurHarness: boolean;
}> {
  const cleanIp = ip.trim();
  const [appsResp, activeResp] = await Promise.all([
    fetch(`http://${cleanIp}:8060/query/apps`, { signal: AbortSignal.timeout(3000) }),
    fetch(`http://${cleanIp}:8060/query/active-app`, { signal: AbortSignal.timeout(3000) }),
  ]);

  let devAppTitle: string | undefined;
  let devAppVersion: string | undefined;
  if (appsResp.ok) {
    const appsXml = await appsResp.text();
    const devMatch = appsXml.match(/<app\b([^>]*\bid="dev"[^>]*)>([\s\S]*?)<\/app>/i);
    if (devMatch) {
      devAppTitle = devMatch[2].trim();
      const verMatch = devMatch[1].match(/\bversion="([^"]+)"/i);
      devAppVersion = verMatch ? verMatch[1] : undefined;
    }
  }

  let activeAppTitle: string | undefined;
  if (activeResp.ok) {
    const activeXml = await activeResp.text();
    const actMatch = activeXml.match(/<app\b[^>]*>([\s\S]*?)<\/app>/i);
    if (actMatch) activeAppTitle = actMatch[1].trim();
  }

  return {
    hasDevApp: Boolean(devAppTitle),
    devAppTitle,
    devAppVersion,
    activeAppTitle,
    isOurHarness: Boolean(devAppTitle && /Roku RAF Ad Tool/i.test(devAppTitle)),
  };
}

/**
 * Connects to Roku OS Debug Server on TCP port :8080 and runs `chanperf`, `r2d2_bitmaps`, and `sgnodes all`
 * to capture real-time Channel RAM (KiB/MB), CPU %, GPU Texture VRAM utilization, and SceneGraph node counts.
 */
export async function queryRokuPerformance8080(ip: string, timeoutMs = 2500): Promise<RokuPerfSnapshot> {
  const cleanIp = ip.trim();
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: cleanIp, port: 8080 });
    let raw = '';
    let finished = false;

    const done = (snap: RokuPerfSnapshot) => {
      if (finished) return;
      finished = true;
      sock.destroy();
      resolve(snap);
    };

    sock.setTimeout(timeoutMs);

    sock.once('connect', () => {
      setTimeout(() => {
        if (!finished) sock.write('chanperf\r\n');
      }, 150);
      setTimeout(() => {
        if (!finished) sock.write('r2d2_bitmaps\r\n');
      }, 350);
      setTimeout(() => {
        if (!finished) sock.write('sgnodes all\r\n');
      }, 600);
      setTimeout(() => {
        const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const banner = lines[0]?.replace(/^>+/, '').trim();

        // Parse: channel: mem=33788KiB{anon=7772,file=17004,shared=9012,swap=0},%cpu=26{user=26,sys=0}
        const perfMatch = raw.match(
          /channel:\s*mem=(\d+)KiB\{anon=(\d+),file=(\d+),shared=(\d+)[^}]*\},%cpu=(\d+)\{user=(\d+),sys=(\d+)\}/i
        );
        const channelMemKib = perfMatch ? Number.parseInt(perfMatch[1], 10) : undefined;
        const anonMemKib = perfMatch ? Number.parseInt(perfMatch[2], 10) : undefined;
        const fileMemKib = perfMatch ? Number.parseInt(perfMatch[3], 10) : undefined;
        const sharedMemKib = perfMatch ? Number.parseInt(perfMatch[4], 10) : undefined;
        const cpuTotalPct = perfMatch ? Number.parseInt(perfMatch[5], 10) : undefined;
        const cpuUserPct = perfMatch ? Number.parseInt(perfMatch[6], 10) : undefined;
        const cpuSysPct = perfMatch ? Number.parseInt(perfMatch[7], 10) : undefined;

        // Parse highest non-zero texture memory pool: Available texture memory 66052352 used 33947648 max 100000000
        let textureAvailableBytes: number | undefined;
        let textureUsedBytes: number | undefined;
        let textureMaxBytes: number | undefined;
        const texRegex = /Available texture memory\s+(\d+)\s+used\s+(\d+)\s+max\s+(\d+)/gi;
        let tm: RegExpExecArray | null;
        while ((tm = texRegex.exec(raw)) !== null) {
          const avail = Number.parseInt(tm[1], 10);
          const used = Number.parseInt(tm[2], 10);
          const max = Number.parseInt(tm[3], 10);
          if (textureUsedBytes === undefined || used > textureUsedBytes) {
            textureAvailableBytes = avail;
            textureUsedBytes = used;
            textureMaxBytes = max;
          }
        }

        // Parse sgnodes count
        const nodeCountAttr = raw.match(/node-count="(\d+)"/i);
        const openTagMatches = raw.match(/<[A-Z][A-Za-z0-9_]*\b/g);
        const sgNodeCount = nodeCountAttr
          ? Number.parseInt(nodeCountAttr[1], 10)
          : openTagMatches
            ? openTagMatches.length
            : undefined;

        done({
          ip: cleanIp,
          capturedAt: new Date().toISOString(),
          reachable: true,
          banner,
          channelMemKib,
          channelMemMb:
            channelMemKib !== undefined ? Number((channelMemKib / 1024).toFixed(2)) : undefined,
          anonMemKib,
          fileMemKib,
          sharedMemKib,
          cpuTotalPct,
          cpuUserPct,
          cpuSysPct,
          textureUsedBytes,
          textureMaxBytes,
          textureAvailableBytes,
          textureUsedMb:
            textureUsedBytes !== undefined
              ? Number((textureUsedBytes / (1024 * 1024)).toFixed(2))
              : undefined,
          textureUtilizationPct:
            textureUsedBytes !== undefined && textureMaxBytes && textureMaxBytes > 0
              ? Number(((textureUsedBytes / textureMaxBytes) * 100).toFixed(1))
              : undefined,
          sgNodeCount,
        });
      }, 1250);
    });

    sock.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });

    sock.once('error', (err) => {
      done({
        ip: cleanIp,
        capturedAt: new Date().toISOString(),
        reachable: false,
        error: err.message,
      });
    });

    sock.once('timeout', () => {
      done({
        ip: cleanIp,
        capturedAt: new Date().toISOString(),
        reachable: false,
        error: 'Port 8080 connection timed out',
      });
    });
  });
}

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex');
}

function buildDigestHeader(opts: {
  wwwAuthenticate: string;
  method: string;
  uri: string;
  username: string;
  password: string;
}): string {
  const parseParam = (name: string) => {
    const m = opts.wwwAuthenticate.match(new RegExp(`${name}="([^"]+)"`, 'i'));
    return m ? m[1] : '';
  };

  const realm = parseParam('realm');
  const nonce = parseParam('nonce');
  const qopRaw = parseParam('qop');
  const opaque = parseParam('opaque');
  const qop = qopRaw
    .split(',')
    .map((s) => s.trim())
    .includes('auth')
    ? 'auth'
    : qopRaw.trim();

  const nc = '00000001';
  const cnonce = randomBytes(8).toString('hex');
  const ha1 = md5(`${opts.username}:${realm}:${opts.password}`);
  const ha2 = md5(`${opts.method}:${opts.uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username="${opts.username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${opts.uri}"`,
    `response="${response}"`,
  ];
  if (opaque) parts.push(`opaque="${opaque}"`);
  if (qop) {
    parts.push(`qop=${qop}`);
    parts.push(`nc=${nc}`);
    parts.push(`cnonce="${cnonce}"`);
  }
  return `Digest ${parts.join(', ')}`;
}

function buildMultipartForm(fields: Array<{ name: string; value: string }>, file?: { name: string; filename: string; contentType: string; data: Buffer }) {
  const boundary = `----RokuRafToolBoundary${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];

  for (const f of fields) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`
      )
    );
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
      )
    );
    chunks.push(file.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function fetchWithRokuDigest(opts: {
  ip: string;
  uri: string;
  method: 'GET' | 'POST';
  username: string;
  password: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  timeoutMs?: number;
}): Promise<Response> {
  const url = `http://${opts.ip}${opts.uri}`;
  const probe = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(4000) });
  const wwwAuth = probe.headers.get('www-authenticate') || '';

  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (probe.status === 401 && /digest/i.test(wwwAuth)) {
    headers.Authorization = buildDigestHeader({
      wwwAuthenticate: wwwAuth,
      method: opts.method,
      uri: opts.uri,
      username: opts.username,
      password: opts.password,
    });
  } else {
    headers.Authorization = `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString('base64')}`;
  }

  return fetch(url, {
    method: opts.method,
    headers,
    body: opts.body ? new Uint8Array(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 12000),
  });
}

export async function sideloadChannelToRoku(opts: {
  ip: string;
  username?: string;
  password: string;
  zipBuffer: Buffer;
}): Promise<{ ok: boolean; status: number; message: string }> {
  const ip = opts.ip.trim();
  const username = opts.username || 'rokudev';

  // Ensure any currently open dev channel exits to Home before replacing the dev slot
  await sendRokuKeypress(ip, 'Home').catch(() => {});
  await new Promise((r) => setTimeout(r, 700));

  const postArchive = async (submitAction: 'Replace' | 'Install') => {
    const { body, contentType } = buildMultipartForm([{ name: 'mysubmit', value: submitAction }], {
      name: 'archive',
      filename: 'roku-raf-harness.zip',
      contentType: 'application/zip',
      data: opts.zipBuffer,
    });
    return fetchWithRokuDigest({
      ip,
      uri: '/plugin_install',
      method: 'POST',
      username,
      password: opts.password,
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(body),
      timeoutMs: 15000,
    });
  };

  let installResp = await postArchive('Replace');
  let html = await installResp.text();
  if (/no application|not installed/i.test(html)) {
    installResp = await postArchive('Install');
    html = await installResp.text();
  }

  const msgMatch =
    html.match(/Roku\.Message[\s\S]*?content\(["']([^"']+)["']\)/i) ||
    html.match(/<font[^>]*color="red"[^>]*>([\s\S]*?)<\/font>/i);
  const statusMsg = msgMatch ? msgMatch[1].replace(/<[^>]+>/g, '').trim() : `HTTP ${installResp.status}`;
  const ok = installResp.ok && !/install failure|failed/i.test(statusMsg);

  return {
    ok,
    status: installResp.status,
    message: ok ? `Channel sideloaded (${statusMsg})` : `Sideload response: ${statusMsg}`,
  };
}

/**
 * Triggers a developer channel screenshot via /plugin_inspect and downloads the resulting JPG/PNG.
 */
export async function captureRokuScreenshot(opts: {
  ip: string;
  username?: string;
  password: string;
  sessionId: string;
}): Promise<ScreenshotRecord> {
  const ip = opts.ip.trim();
  const username = opts.username || 'rokudev';
  const { body, contentType } = buildMultipartForm([{ name: 'mysubmit', value: 'Screenshot' }]);

  const inspectResp = await fetchWithRokuDigest({
    ip,
    uri: '/plugin_inspect',
    method: 'POST',
    username,
    password: opts.password,
    headers: { 'Content-Type': contentType },
    body: new Uint8Array(body),
    timeoutMs: 10000,
  });

  const html = await inspectResp.text();
  const imgMatch = html.match(/["'](\/?pkgs\/dev\.(?:jpg|jpeg|png)[^"']*)["']/i);
  if (!imgMatch) {
    throw new Error('Roku did not return a screenshot image (note: encrypted streams or non-dev channels block screenshots).');
  }

  const imgUri = imgMatch[1].startsWith('/') ? imgMatch[1] : `/${imgMatch[1]}`;
  const imgResp = await fetchWithRokuDigest({
    ip,
    uri: imgUri,
    method: 'GET',
    username,
    password: opts.password,
    timeoutMs: 8000,
  });
  if (!imgResp.ok) {
    throw new Error(`Failed fetching screenshot asset ${imgUri}: HTTP ${imgResp.status}`);
  }

  const mimeType = imgResp.headers.get('content-type') || (imgUri.includes('.png') ? 'image/png' : 'image/jpeg');
  const buf = Buffer.from(await imgResp.arrayBuffer());

  return {
    id: randomUUID(),
    sessionId: opts.sessionId || 'roku-tv',
    deviceIp: ip,
    timestamp: new Date().toISOString(),
    mimeType,
    dataUrl: `data:${mimeType};base64,${buf.toString('base64')}`,
  };
}

export class RokuDebugConsoleBridge {
  private socket: net.Socket | null = null;
  private connectedIp: string | null = null;
  private buffer = '';

  constructor(private readonly beaconStore: BeaconStore) {}

  public getStatus(): { connected: boolean; ip: string | null } {
    return { connected: Boolean(this.socket && !this.socket.destroyed), ip: this.connectedIp };
  }

  public connect(ip: string, sessionId = 'roku-tv'): Promise<{ connected: boolean; ip: string }> {
    this.disconnect();
    const targetIp = ip.trim();

    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: targetIp, port: 8085 });
      let settled = false;

      sock.setTimeout(4000);
      sock.once('connect', () => {
        sock.setTimeout(0);
        this.socket = sock;
        this.connectedIp = targetIp;
        settled = true;
        this.beaconStore.record({
          sessionId,
          kind: 'console_log',
          eventName: 'CONSOLE_CONNECTED',
          requestUrl: `tcp://${targetIp}:8085`,
          details: { message: `Connected to Roku BrightScript console at ${targetIp}:8085` },
        });
        resolve({ connected: true, ip: targetIp });
      });

      sock.on('data', (chunk) => {
        this.buffer += chunk.toString('utf8');
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() ?? '';
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          const isRaf = /\[raf/i.test(line) || /Roku_Ads/i.test(line);
          this.beaconStore.record({
            sessionId,
            kind: 'console_log',
            eventName: isRaf ? 'RAF_DEBUG_LOG' : 'BRS_PRINT',
            requestUrl: `tcp://${targetIp}:8085`,
            details: { line },
          });

          // Mirror [RAF-HARNESS] [HH:MM:SS] EVENT_NAME: detail lines as telemetry & external beacon events
          const harnessMatch = line.match(/\[RAF-HARNESS\]\s*\[\d{2}:\d{2}:\d{2}\]\s*([A-Za-z0-9_"]+):\s*(.*)$/);
          if (harnessMatch) {
            const evKey = harnessMatch[1].replace(/"/g, '');
            const evDetail = harnessMatch[2];
            this.beaconStore.record({
              sessionId,
              kind: 'raf_telemetry',
              eventName: evKey,
              requestUrl: `tcp://${targetIp}:8085`,
              userAgent: 'Roku/DVP-16.0 (:8085 Bridge)',
              details: { detail: evDetail, via: 'port-8085' },
            });

            // When testing external non-proxied tags, synthesize quartile/impression beacons from RAF tracking callback logs
            if (evKey.startsWith('RAF_')) {
              const rawRafEv = evKey.slice(4);
              const lower = rawRafEv.toLowerCase();
              const mapped =
                lower === 'impression'
                  ? { kind: 'impression' as const, name: 'impression' }
                  : lower === 'start'
                    ? { kind: 'quartile' as const, name: 'start' }
                    : lower === 'firstquartile'
                      ? { kind: 'quartile' as const, name: 'firstQuartile' }
                      : lower === 'midpoint'
                        ? { kind: 'quartile' as const, name: 'midpoint' }
                        : lower === 'thirdquartile'
                          ? { kind: 'quartile' as const, name: 'thirdQuartile' }
                          : lower === 'complete'
                            ? { kind: 'quartile' as const, name: 'complete' }
                            : lower === 'error'
                              ? { kind: 'error' as const, name: 'error' }
                              : null;

              if (mapped && this.beaconStore.getExpectedBeacons(sessionId).length === 0) {
                const alreadyViaHttp = this.beaconStore
                  .getEvents(sessionId)
                  .some(
                    (e) =>
                      e.eventName.toLowerCase() === mapped.name.toLowerCase() &&
                      e.requestUrl.startsWith('http')
                  );
                if (!alreadyViaHttp) {
                  const adIdxMatch = evDetail.match(/adIndex=(\d+)/i);
                  this.beaconStore.record({
                    sessionId,
                    kind: mapped.kind,
                    eventName: mapped.name,
                    adId: adIdxMatch ? `roku-ad-${adIdxMatch[1]}` : 'roku-ad-1',
                    podId: 'roku-pod',
                    requestUrl: `raf-callback://${targetIp}/${mapped.name}`,
                    userAgent: 'Roku/DVP-16.0 (RAF Callback via :8085)',
                  });
                }
              }
            }
          }
        }
      });

      sock.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.disconnect();
      });

      sock.on('close', () => {
        this.socket = null;
        this.connectedIp = null;
      });

      sock.once('timeout', () => {
        if (!settled) {
          settled = true;
          sock.destroy();
          reject(new Error(`Timed out connecting to ${targetIp}:8085`));
        }
      });
    });
  }

  public disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connectedIp = null;
  }
}
