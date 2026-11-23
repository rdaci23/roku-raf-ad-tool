import { randomUUID } from 'node:crypto';
import { extractExpectedBeaconsFromParsedTag, runBeaconAndCertAudit } from './beaconAuditor.js';
import { inspectStreamManifest } from './manifestInspector.js';
import { validateAdTag } from './rafValidator.js';
import type {
  BeaconEvent,
  BeaconEventKind,
  ExpectedBeaconSpec,
  ManifestInspectionReport,
  SessionSnapshot,
  ValidationReport,
} from './types.js';

interface HarHeader {
  name: string;
  value: string;
}

interface HarEntry {
  startedDateTime?: string;
  time?: number;
  request?: {
    method?: string;
    url?: string;
    headers?: HarHeader[];
  };
  response?: {
    status?: number;
    headers?: HarHeader[];
    content?: {
      mimeType?: string;
      text?: string;
      encoding?: string;
    };
  };
}

const KNOWN_BEACON_EVENTS = [
  'impression',
  'start',
  'firstQuartile',
  'midpoint',
  'thirdQuartile',
  'complete',
  'skip',
  'mute',
  'unmute',
  'pause',
  'resume',
  'error',
  'breakStart',
  'breakEnd',
  'clickTracking',
];

function inferBeaconEventFromUrl(url: string): { kind: BeaconEventKind; eventName: string; errorCode?: string } | null {
  try {
    const parsed = new URL(url);
    const sp = parsed.searchParams;
    const explicitEv = sp.get('event') || sp.get('label') || sp.get('ev') || sp.get('type') || sp.get('cn');
    if (explicitEv) {
      const match = KNOWN_BEACON_EVENTS.find((e) => e.toLowerCase() === explicitEv.toLowerCase());
      const evName = match ?? explicitEv;
      const lower = evName.toLowerCase();
      const kind: BeaconEventKind =
        lower === 'impression'
          ? 'impression'
          : ['start', 'firstquartile', 'midpoint', 'thirdquartile', 'complete'].includes(lower)
            ? 'quartile'
            : lower === 'error'
              ? 'error'
              : lower.includes('break')
                ? 'vmap'
                : 'tracking';
      return {
        kind,
        eventName: evName,
        errorCode: sp.get('errorCode') || sp.get('err') || sp.get('code') || undefined,
      };
    }

    const pathLower = parsed.pathname.toLowerCase();
    for (const known of KNOWN_BEACON_EVENTS) {
      if (pathLower.includes(`/${known.toLowerCase()}`) || pathLower.endsWith(known.toLowerCase())) {
        const lower = known.toLowerCase();
        return {
          kind:
            lower === 'impression'
              ? 'impression'
              : ['start', 'firstquartile', 'midpoint', 'thirdquartile', 'complete'].includes(lower)
                ? 'quartile'
                : lower === 'error'
                  ? 'error'
                  : 'tracking',
          eventName: known,
        };
      }
    }
  } catch {
    // ignore invalid URL
  }
  return null;
}

/**
 * Imports a Charles Proxy / mitmproxy / DevTools .har JSON archive captured from a Roku device,
 * extracting VAST/VMAP tags, HLS/DASH manifests, and fired tracking beacons into a SessionSnapshot.
 */
export function importHarArchive(harJsonText: string, customName?: string): SessionSnapshot {
  const parsedHar = JSON.parse(harJsonText) as { log?: { entries?: HarEntry[] } };
  const entries = parsedHar.log?.entries ?? [];
  const sessionId = `har-${randomUUID().slice(0, 8)}`;

  let validationReport: ValidationReport | undefined;
  let manifestReport: ManifestInspectionReport | undefined;
  let primaryTagUrl: string | undefined;
  let rawXmlOrManifest: string | undefined;
  const expectedBeacons: ExpectedBeaconSpec[] = [];
  const expectedUrlLookup = new Map<string, ExpectedBeaconSpec>();
  const events: BeaconEvent[] = [];

  const firstEpoch =
    entries[0]?.startedDateTime ? new Date(entries[0].startedDateTime).getTime() : Date.now();

  // Pass 1: Discover VAST/VMAP XML payloads & HLS/DASH manifests so we know expected beacon URLs!
  for (const entry of entries) {
    const reqUrl = entry.request?.url ?? '';
    let bodyText = entry.response?.content?.text ?? '';
    if (bodyText && entry.response?.content?.encoding === 'base64') {
      bodyText = Buffer.from(bodyText, 'base64').toString('utf8');
    }
    const trimmed = bodyText.trim();
    if (!trimmed) continue;

    if (/<(VAST|vmap:VMAP|VMAP)[\s>]/i.test(trimmed)) {
      const report = validateAdTag(trimmed, { expandedUrl: reqUrl });
      if (!validationReport || report.parsed.ads.length >= validationReport.parsed.ads.length) {
        validationReport = report;
        primaryTagUrl = reqUrl;
        rawXmlOrManifest = trimmed;
      }
      const extracted = extractExpectedBeaconsFromParsedTag(report.parsed, sessionId, 'har-pod');
      for (const spec of extracted) {
        expectedBeacons.push(spec);
        expectedUrlLookup.set(spec.url, spec);
      }
    } else if (!manifestReport && (trimmed.startsWith('#EXTM3U') || /<MPD[\s>]/i.test(trimmed))) {
      manifestReport = inspectStreamManifest(trimmed);
      if (!primaryTagUrl) primaryTagUrl = reqUrl;
      if (!rawXmlOrManifest) rawXmlOrManifest = trimmed;
    }
  }

  // Pass 2: Classify requests as tag requests or tracking beacon hits
  for (const entry of entries) {
    const reqUrl = entry.request?.url ?? '';
    if (!reqUrl) continue;
    const epochMs = entry.startedDateTime ? new Date(entry.startedDateTime).getTime() : firstEpoch;
    const ua = entry.request?.headers?.find((h) => h.name.toLowerCase() === 'user-agent')?.value;

    const matchedSpec = expectedUrlLookup.get(reqUrl);
    if (matchedSpec) {
      const lower = matchedSpec.event.toLowerCase();
      events.push({
        id: randomUUID(),
        sessionId,
        timestamp: new Date(epochMs).toISOString(),
        epochMs,
        relativeMs: Math.max(0, epochMs - firstEpoch),
        kind:
          lower === 'impression'
            ? 'impression'
            : ['start', 'firstquartile', 'midpoint', 'thirdquartile', 'complete'].includes(lower)
              ? 'quartile'
              : lower === 'error'
                ? 'error'
                : 'tracking',
        eventName: matchedSpec.event,
        adId: matchedSpec.adId,
        podId: matchedSpec.podId,
        requestUrl: reqUrl,
        originalUrl: reqUrl,
        method: entry.request?.method ?? 'GET',
        userAgent: ua,
        forwardedStatus: entry.response?.status,
      });
      continue;
    }

    if (reqUrl === primaryTagUrl || /vast|vmap|gampad\/ads|springserve|fwmrm/i.test(reqUrl)) {
      events.push({
        id: randomUUID(),
        sessionId,
        timestamp: new Date(epochMs).toISOString(),
        epochMs,
        relativeMs: Math.max(0, epochMs - firstEpoch),
        kind: 'tag_request',
        eventName: 'HAR_AD_REQUEST',
        requestUrl: reqUrl,
        method: entry.request?.method ?? 'GET',
        userAgent: ua,
        forwardedStatus: entry.response?.status,
      });
      continue;
    }

    const inferred = inferBeaconEventFromUrl(reqUrl);
    if (inferred) {
      events.push({
        id: randomUUID(),
        sessionId,
        timestamp: new Date(epochMs).toISOString(),
        epochMs,
        relativeMs: Math.max(0, epochMs - firstEpoch),
        kind: inferred.kind,
        eventName: inferred.eventName,
        adId: 'har-ad-1',
        podId: 'har-pod',
        errorCode: inferred.errorCode,
        requestUrl: reqUrl,
        method: entry.request?.method ?? 'GET',
        userAgent: ua,
        forwardedStatus: entry.response?.status,
      });
    }
  }

  const auditReport = runBeaconAndCertAudit({
    sessionId,
    expected: expectedBeacons,
    events,
  });

  return {
    id: randomUUID(),
    name: customName || `HAR Import (${entries.length} HTTP entries)`,
    source: 'har_import',
    createdAt: new Date().toISOString(),
    sessionId,
    adTagUrl: primaryTagUrl,
    rawXmlOrManifest,
    validationReport,
    manifestReport,
    expectedBeacons,
    events,
    auditReport,
    screenshots: [],
  };
}
