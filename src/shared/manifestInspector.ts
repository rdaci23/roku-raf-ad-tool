import { XMLParser } from 'fast-xml-parser';
import type {
  ManifestAdCue,
  ManifestInspectionReport,
  ManifestVariant,
  ValidationIssue,
} from './types.js';

const dashParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
});

function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function parseHlsAttrList(attrStr: string): Record<string, string> {
  const out: Record<string, string> = {};
  const regex = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(attrStr)) !== null) {
    out[m[1].toUpperCase()] = (m[3] ?? m[4] ?? '').trim();
  }
  return out;
}

function parseIsoDurationSec(iso?: string): number | undefined {
  if (!iso) return undefined;
  const m = iso.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!m) return undefined;
  const h = m[1] ? Number.parseFloat(m[1]) : 0;
  const min = m[2] ? Number.parseFloat(m[2]) : 0;
  const s = m[3] ? Number.parseFloat(m[3]) : 0;
  return h * 3600 + min * 60 + s;
}

function inspectHls(rawText: string): ManifestInspectionReport {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const issues: ValidationIssue[] = [];
  const variants: ManifestVariant[] = [];
  const adCues: ManifestAdCue[] = [];

  if (!lines[0]?.startsWith('#EXTM3U')) {
    issues.push({
      severity: 'error',
      code: 'HLS_MISSING_EXTM3U',
      message: 'HLS playlist does not start with #EXTM3U header.',
      rafHint: 'Roku HLS demuxer requires #EXTM3U on line 1.',
    });
  }

  let isMaster = false;
  let hasEndList = false;
  let playlistType = '';
  let targetDuration: number | undefined;
  let mediaSequence: number | undefined;
  let segmentCount = 0;
  let runningTimeSec = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      isMaster = true;
      const attrs = parseHlsAttrList(line.slice('#EXT-X-STREAM-INF:'.length));
      const nextUrl = lines[i + 1] && !lines[i + 1].startsWith('#') ? lines[i + 1] : '';
      variants.push({
        url: nextUrl,
        bandwidth: attrs.BANDWIDTH ? Number.parseInt(attrs.BANDWIDTH, 10) : undefined,
        resolution: attrs.RESOLUTION,
        codecs: attrs.CODECS,
        frameRate: attrs['FRAME-RATE'],
      });
      if (!attrs.CODECS) {
        issues.push({
          severity: 'warning',
          code: 'HLS_VARIANT_MISSING_CODECS',
          message: `Variant "${nextUrl}" omits CODECS attribute on #EXT-X-STREAM-INF.`,
          rafHint: 'Specify CODECS (e.g., "avc1.4d401f,mp4a.40.2") so Roku selects compatible video/audio tracks cleanly.',
        });
      }
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number.parseFloat(line.split(':')[1] ?? '');
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number.parseInt(line.split(':')[1] ?? '0', 10);
    } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      playlistType = (line.split(':')[1] ?? '').trim().toUpperCase();
    } else if (line === '#EXT-X-ENDLIST') {
      hasEndList = true;
    } else if (line.startsWith('#EXTINF:')) {
      const durPart = line.slice('#EXTINF:'.length).split(',')[0];
      const dur = Number.parseFloat(durPart);
      if (Number.isFinite(dur)) {
        runningTimeSec += dur;
      }
      segmentCount += 1;
    } else if (line === '#EXT-X-DISCONTINUITY') {
      adCues.push({
        type: 'DISCONTINUITY',
        offsetSec: Number(runningTimeSec.toFixed(3)),
        rawLine: line,
      });
    } else if (line.startsWith('#EXT-X-DATERANGE:')) {
      const attrs = parseHlsAttrList(line.slice('#EXT-X-DATERANGE:'.length));
      const dur = attrs.DURATION
        ? Number.parseFloat(attrs.DURATION)
        : attrs['PLANNED-DURATION']
          ? Number.parseFloat(attrs['PLANNED-DURATION'])
          : undefined;
      adCues.push({
        type: 'DATERANGE',
        id: attrs.ID,
        startDate: attrs['START-DATE'],
        offsetSec: Number(runningTimeSec.toFixed(3)),
        durationSec: dur,
        scte35Payload: attrs['SCTE35-OUT'] || attrs['SCTE35-CMD'] || attrs['SCTE35-IN'],
        rawLine: line,
      });
    } else if (line.startsWith('#EXT-X-CUE-OUT')) {
      const durMatch = line.match(/DURATION=([\d.]+)/i) || line.match(/^#EXT-X-CUE-OUT:([\d.]+)/i);
      adCues.push({
        type: 'CUE-OUT',
        offsetSec: Number(runningTimeSec.toFixed(3)),
        durationSec: durMatch ? Number.parseFloat(durMatch[1]) : undefined,
        rawLine: line,
      });
    } else if (line.startsWith('#EXT-X-CUE-IN')) {
      adCues.push({
        type: 'CUE-IN',
        offsetSec: Number(runningTimeSec.toFixed(3)),
        rawLine: line,
      });
    } else if (line.startsWith('#EXT-X-OATCLS-SCTE35:') || line.startsWith('#EXT-X-SCTE35:')) {
      adCues.push({
        type: 'SCTE35',
        offsetSec: Number(runningTimeSec.toFixed(3)),
        scte35Payload: line.split(':').slice(1).join(':').trim(),
        rawLine: line,
      });
    }
  }

  const isLive = !isMaster && !hasEndList && playlistType !== 'VOD';

  if (!isMaster && adCues.some((c) => c.type === 'DATERANGE') && !lines.some((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:'))) {
    issues.push({
      severity: 'warning',
      code: 'HLS_DATERANGE_WITHOUT_PDT',
      message: '#EXT-X-DATERANGE tags found without #EXT-X-PROGRAM-DATE-TIME anchors.',
      rafHint: 'Include #EXT-X-PROGRAM-DATE-TIME so Roku Video node maps START-DATE cues accurately onto stream time.',
    });
  }

  if (!isMaster && adCues.length === 0) {
    issues.push({
      severity: 'info',
      code: 'HLS_NO_AD_MARKERS',
      message: 'No #EXT-X-DISCONTINUITY, #EXT-X-DATERANGE, or SCTE-35 ad cues detected in media playlist.',
      rafHint: 'For SSAI streams, ensure ad breaks include #EXT-X-DISCONTINUITY and #EXT-X-DATERANGE / sidecar metadata.',
    });
  }

  return {
    format: 'HLS',
    isMaster,
    isLive,
    targetDuration,
    mediaSequence,
    segmentCount,
    totalDurationSec: Number(runningTimeSec.toFixed(2)),
    variants,
    adCues,
    issues,
    rawText,
  };
}

function inspectDash(rawText: string): ManifestInspectionReport {
  const issues: ValidationIssue[] = [];
  const variants: ManifestVariant[] = [];
  const adCues: ManifestAdCue[] = [];

  const doc = dashParser.parse(rawText) as Record<string, unknown>;
  const mpd = (doc.MPD ?? {}) as Record<string, unknown>;
  const mpdType = String(mpd['@_type'] ?? 'static').toLowerCase();
  const isLive = mpdType === 'dynamic';
  const totalDur = parseIsoDurationSec(mpd['@_mediaPresentationDuration'] ? String(mpd['@_mediaPresentationDuration']) : undefined) ?? 0;

  const periods = toArray(mpd.Period);
  for (const [pIdx, p] of periods.entries()) {
    const pObj = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>;
    const pId = pObj['@_id'] ? String(pObj['@_id']) : `period-${pIdx + 1}`;
    const pStart = parseIsoDurationSec(pObj['@_start'] ? String(pObj['@_start']) : undefined);
    const pDur = parseIsoDurationSec(pObj['@_duration'] ? String(pObj['@_duration']) : undefined);

    if (periods.length > 1) {
      adCues.push({
        type: 'DASH_PERIOD',
        id: pId,
        offsetSec: pStart,
        durationSec: pDur,
        rawLine: `<Period id="${pId}"${pStart !== undefined ? ` start="${pStart}s"` : ''}${pDur !== undefined ? ` duration="${pDur}s"` : ''}>`,
      });
    }

    for (const es of toArray(pObj.EventStream)) {
      const esObj = (typeof es === 'object' && es !== null ? es : {}) as Record<string, unknown>;
      const scheme = String(esObj['@_schemeIdUri'] ?? '');
      const timescale = Number(esObj['@_timescale'] ?? 1);
      for (const ev of toArray(esObj.Event)) {
        const evObj = (typeof ev === 'object' && ev !== null ? ev : {}) as Record<string, unknown>;
        const pt = Number(evObj['@_presentationTime'] ?? 0) / timescale;
        const dur = evObj['@_duration'] ? Number(evObj['@_duration']) / timescale : undefined;
        adCues.push({
          type: 'DASH_EVENT',
          id: evObj['@_id'] ? String(evObj['@_id']) : scheme,
          offsetSec: Number(((pStart ?? 0) + pt).toFixed(3)),
          durationSec: dur,
          scte35Payload: typeof evObj.Signal === 'object' ? JSON.stringify(evObj.Signal) : undefined,
          rawLine: `<EventStream schemeIdUri="${scheme}">`,
        });
      }
    }

    for (const as of toArray(pObj.AdaptationSet)) {
      const asObj = (typeof as === 'object' && as !== null ? as : {}) as Record<string, unknown>;
      const mime = String(asObj['@_mimeType'] ?? '');
      if (mime.includes('video') || !mime) {
        for (const rep of toArray(asObj.Representation)) {
          const rObj = (typeof rep === 'object' && rep !== null ? rep : {}) as Record<string, unknown>;
          const w = rObj['@_width'];
          const h = rObj['@_height'];
          variants.push({
            url: rObj['@_id'] ? `Representation[${rObj['@_id']}]` : 'Representation',
            bandwidth: rObj['@_bandwidth'] ? Number.parseInt(String(rObj['@_bandwidth']), 10) : undefined,
            resolution: w && h ? `${w}x${h}` : undefined,
            codecs: rObj['@_codecs'] ? String(rObj['@_codecs']) : asObj['@_codecs'] ? String(asObj['@_codecs']) : undefined,
          });
        }
      }
    }
  }

  if (periods.length > 1) {
    issues.push({
      severity: 'info',
      code: 'DASH_MULTI_PERIOD_DETECTED',
      message: `Multi-Period MPEG-DASH manifest detected (${periods.length} periods).`,
      rafHint: 'Verify Roku OS version compatibility when stitching multi-period DASH ads with raf.stitchedAdsInit().',
    });
  }

  return {
    format: 'DASH',
    isMaster: variants.length > 0,
    isLive,
    segmentCount: periods.length,
    totalDurationSec: Number(totalDur.toFixed(2)),
    variants,
    adCues,
    issues,
    rawText,
  };
}

export function inspectStreamManifest(rawText: string): ManifestInspectionReport {
  const trimmed = rawText.trim();
  if (trimmed.startsWith('#EXTM3U')) {
    return inspectHls(trimmed);
  }
  if (/<MPD[\s>]/i.test(trimmed)) {
    return inspectDash(trimmed);
  }
  return {
    format: 'UNKNOWN',
    isMaster: false,
    isLive: false,
    segmentCount: 0,
    totalDurationSec: 0,
    variants: [],
    adCues: [],
    issues: [
      {
        severity: 'error',
        code: 'UNKNOWN_MANIFEST_FORMAT',
        message: 'Input is neither an HLS (#EXTM3U) playlist nor an MPEG-DASH (<MPD>) manifest.',
      },
    ],
    rawText,
  };
}
