import { detectUnexpandedMacros } from './rafMacros.js';
import { parseAdXml, parseDurationToSeconds } from './vastParser.js';
import type {
  ParsedAd,
  ParsedAdBreak,
  ParsedAdTag,
  RokuAdPolicyContext,
  ValidationIssue,
  ValidationReport,
} from './types.js';

const CORE_QUARTILES = ['start', 'firstQuartile', 'midpoint', 'thirdQuartile', 'complete'] as const;
const VALID_VMAP_OFFSET = /^(start|end|\d{1,2}:\d{2}:\d{2}(?:\.\d{1,3})?|\d{1,3}%|#\d+)$/i;

function validateSingleAd(ad: ParsedAd, issues: ValidationIssue[], prefix = ''): void {
  const loc = `${prefix}Ad[id=${ad.id}${ad.sequence !== undefined ? `, seq=${ad.sequence}` : ''}]`;

  if (ad.impressions.length === 0) {
    issues.push({
      severity: 'error',
      code: 'MISSING_IMPRESSION',
      message: 'Ad does not contain any <Impression> beacon URL.',
      location: loc,
      rafHint: 'IAB VAST & Roku RAF require at least one <Impression> URI to count ad rendering.',
    });
  }

  if (ad.errors.length === 0) {
    issues.push({
      severity: 'warning',
      code: 'MISSING_ERROR_BEACON',
      message: 'Ad has no <Error> tracking URL.',
      location: loc,
      rafHint: 'Add an <Error> URL with [ERRORCODE] so Roku RAF can report 303/403/405 failures.',
    });
  }

  const extCombined = [...ad.extensions, ...ad.verifications].join(' ');
  if (/brightline|innovid/i.test(extCombined) || ad.linears.some((l) => l.interactiveFiles.length > 0)) {
    issues.push({
      severity: 'info',
      code: 'INTERACTIVE_CREATIVE_DETECTED',
      message: 'Interactive creative / extension detected (BrightLine, Innovid, or InteractiveCreativeFile).',
      location: loc,
      rafHint: 'Ensure raf.enableAdMeasurements(true) and SceneGraph node parent are passed to raf.showAds(adPods, invalid, viewNode) on Roku.',
    });
  }

  if (ad.adType === 'Wrapper') {
    if (!ad.vastAdTagUri) {
      issues.push({
        severity: 'error',
        code: 'WRAPPER_MISSING_URI',
        message: 'Wrapper ad is missing <VASTAdTagURI>.',
        location: loc,
        rafHint: 'A VAST <Wrapper> must include a valid HTTP(S) <VASTAdTagURI> pointing to the next VAST tag.',
      });
    }
    return;
  }

  if (ad.linears.length === 0) {
    issues.push({
      severity: 'error',
      code: 'NO_LINEAR_CREATIVE',
      message: 'InLine Ad contains no <Linear> video creative.',
      location: loc,
      rafHint: 'Roku RAF requires a <Linear> video creative for video ad pods.',
    });
    return;
  }

  for (const [idx, lin] of ad.linears.entries()) {
    const linLoc = `${loc} > Linear[${idx + 1}]`;
    if (!lin.duration || lin.durationSeconds === undefined) {
      issues.push({
        severity: 'error',
        code: 'INVALID_DURATION',
        message: `Linear creative has missing or invalid <Duration> ("${lin.duration ?? ''}").`,
        location: linLoc,
        rafHint: 'Format <Duration> strictly as HH:MM:SS (e.g., 00:00:15).',
      });
    }

    if (lin.skipOffset) {
      issues.push({
        severity: 'info',
        code: 'LINEAR_SKIPOFFSET_RAF_BEHAVIOR',
        message: `Linear creative declares skipoffset="${lin.skipOffset}".`,
        location: linLoc,
        rafHint:
          'Verified on Roku OS 16 (roku_ads_lib 3.31+): standard raf.showAds() ignores VAST skipoffset and plays full creative duration unless custom SceneGraph skip UI is implemented.',
      });
    }

    const compatibleMedia = lin.mediaFiles.filter((m) => m.rafCompatible);
    const incompatibleMedia = lin.mediaFiles.filter((m) => !m.rafCompatible);

    if (compatibleMedia.length === 0) {
      issues.push({
        severity: 'error',
        code: 'NO_RAF_COMPATIBLE_MEDIA',
        message: 'No Roku RAF-compatible <MediaFile> found (MP4 H.264/AAC or HLS required).',
        location: linLoc,
        rafHint:
          incompatibleMedia.length > 0
            ? incompatibleMedia.flatMap((m) => m.rafNotes).join(' ')
            : 'Provide at least one progressive video/mp4 (H.264/AAC) or application/x-mpegURL HLS stream.',
      });
    } else if (incompatibleMedia.length > 0) {
      issues.push({
        severity: 'warning',
        code: 'MIXED_UNSUPPORTED_MEDIA',
        message: `${incompatibleMedia.length} unsupported MediaFile(s) present alongside ${compatibleMedia.length} valid rendition(s) (e.g., JS VPAID/WebM).`,
        location: linLoc,
        rafHint: 'Roku RAF will ignore JS VPAID/WebM renditions and select from the compatible MP4/HLS files.',
      });
    }

    for (const mf of compatibleMedia) {
      if (!mf.width || !mf.height || !mf.bitrate) {
        issues.push({
          severity: 'warning',
          code: 'MEDIA_MISSING_RENDITION_ATTRS',
          message: `MediaFile (${mf.type}) is missing width, height, or bitrate attributes.`,
          location: linLoc,
          rafHint: 'RAF uses bitrate, width, and height to pick the optimal stream via raf.setAdPrefs().',
        });
        break;
      }
      if (mf.bitrate && mf.bitrate > 10000) {
        issues.push({
          severity: 'warning',
          code: 'MEDIA_HIGH_BITRATE',
          message: `MediaFile bitrate ${mf.bitrate} kbps exceeds 10 Mbps.`,
          location: linLoc,
          rafHint: 'Include a 1,500–3,500 kbps 720p/1080p MP4 rendition for smooth playback across Roku Stick/Express models.',
        });
      }
    }

    const trackedEvents = new Set(lin.trackingEvents.map((t) => t.event));
    const missingQuartiles = CORE_QUARTILES.filter((q) => !trackedEvents.has(q));
    if (missingQuartiles.length > 0) {
      issues.push({
        severity: 'warning',
        code: 'MISSING_QUARTILE_BEACONS',
        message: `Missing standard quartile tracking events: ${missingQuartiles.join(', ')}.`,
        location: linLoc,
        rafHint: 'Include start, firstQuartile, midpoint, thirdQuartile, and complete beacons for full RAF verification.',
      });
    }
  }
}

function validateVastStructure(parsed: ParsedAdTag, issues: ValidationIssue[], prefix = ''): void {
  if (parsed.ads.length === 0) {
    issues.push({
      severity: 'warning',
      code: 'EMPTY_VAST_NO_FILL',
      message: 'VAST response contains zero <Ad> elements (No-Fill).',
      location: `${prefix}VAST`,
      rafHint: 'Roku RAF treats an empty <VAST> as no-fill and fires VAST Error 303 if reached after a Wrapper.',
    });
    return;
  }

  const sequenced = parsed.ads.filter((a) => a.sequence !== undefined);
  const unsequenced = parsed.ads.filter((a) => a.sequence === undefined);

  if (sequenced.length > 0) {
    const seqNums = sequenced.map((a) => a.sequence!).sort((a, b) => a - b);
    for (let i = 0; i < seqNums.length; i++) {
      if (seqNums[i] !== i + 1) {
        issues.push({
          severity: 'warning',
          code: 'POD_SEQUENCE_GAP_OR_DUPLICATE',
          message: `Ad pod sequence attributes (${seqNums.join(', ')}) are not contiguous starting at 1.`,
          location: `${prefix}VAST`,
          rafHint: 'Number pod ads sequentially starting at sequence="1" so RAF plays all pod spots in order.',
        });
        break;
      }
    }
    if (unsequenced.length > 0) {
      issues.push({
        severity: 'info',
        code: 'POD_BUFFET_ADS_PRESENT',
        message: `Pod contains ${sequenced.length} sequenced ad(s) and ${unsequenced.length} unsequenced buffet ad(s).`,
        location: `${prefix}VAST`,
        rafHint: 'RAF uses unsequenced ads in a pod as fallback ("buffet") creatives if a sequenced ad fails.',
      });
    }
  }

  for (const ad of parsed.ads) {
    validateSingleAd(ad, issues, prefix);
  }

  // Roku Ad-Load Certification Policy: Pod duration & spot count checks
  const activePodAds = sequenced.length > 0 ? sequenced : parsed.ads.slice(0, 1);
  const totalPodSec = activePodAds.reduce(
    (sum, a) => sum + (a.linears[0]?.durationSeconds ?? 0),
    0
  );
  if (totalPodSec > 120) {
    issues.push({
      severity: 'warning',
      code: 'ROKU_POLICY_POD_DURATION_EXCESSIVE',
      message: `Total ad pod duration (${totalPodSec}s) exceeds Roku's recommended 120s break cap.`,
      location: `${prefix}AdPod`,
      rafHint: 'Roku Ad Certification guidelines recommend keeping standard commercial breaks <= 90–120 seconds.',
    });
  }
  if (sequenced.length > 5) {
    issues.push({
      severity: 'warning',
      code: 'ROKU_POLICY_POD_SPOT_COUNT_HIGH',
      message: `Ad pod contains ${sequenced.length} sequenced spots (recommended <= 5 spots per pod).`,
      location: `${prefix}AdPod`,
      rafHint: 'High spot counts increase buffering transitions on entry-level Roku devices.',
    });
  }
}

function evaluateBreakSchedulePolicies(
  adBreaks: ParsedAdBreak[],
  issues: ValidationIssue[],
  policy?: RokuAdPolicyContext
): void {
  const midrollOffsetsSec: Array<{ id: string; sec: number }> = [];
  let hasMidroll = false;

  for (const brk of adBreaks) {
    const raw = brk.timeOffset.trim().toLowerCase();
    if (raw === 'start' || raw === '0%' || raw === '00:00:00' || raw === '00:00:00.000') continue;
    if (raw === 'end' || raw === '100%') continue;

    hasMidroll = true;
    const parsedSec = parseDurationToSeconds(brk.timeOffset);
    if (parsedSec !== undefined) {
      midrollOffsetsSec.push({ id: brk.id || 'midroll', sec: parsedSec });
    } else if (raw.endsWith('%') && policy?.contentLengthSec) {
      const pct = Number.parseFloat(raw.slice(0, -1));
      if (Number.isFinite(pct)) {
        midrollOffsetsSec.push({
          id: brk.id || 'midroll',
          sec: Math.round((policy.contentLengthSec * pct) / 100),
        });
      }
    }
  }

  if (
    hasMidroll &&
    (policy?.mediaType === 'shortFormVideo' ||
      (policy?.contentLengthSec !== undefined && policy.contentLengthSec > 0 && policy.contentLengthSec < 900))
  ) {
    issues.push({
      severity: 'warning',
      code: 'ROKU_POLICY_SHORTFORM_MIDROLL',
      message: `Midroll ad break scheduled on short-form content (${
        policy?.mediaType === 'shortFormVideo' ? 'mediaType=shortFormVideo' : `${policy?.contentLengthSec}s < 900s`
      }).`,
      location: 'AdSchedulePolicy',
      rafHint: 'Roku UX & Ad-Load Certification guidelines prohibit midroll interruptions on short-form clips (< 15 minutes); use preroll only.',
    });
  }

  midrollOffsetsSec.sort((a, b) => a.sec - b.sec);
  for (let i = 1; i < midrollOffsetsSec.length; i++) {
    const prev = midrollOffsetsSec[i - 1];
    const curr = midrollOffsetsSec[i];
    const gapSec = curr.sec - prev.sec;
    if (gapSec < 420) {
      issues.push({
        severity: 'warning',
        code: 'ROKU_POLICY_MIDROLL_SPACING_TOO_CLOSE',
        message: `Midroll breaks "${prev.id}" (${prev.sec}s) and "${curr.id}" (${curr.sec}s) are only ${gapSec}s apart (< 420s / 7 min minimum).`,
        location: 'AdSchedulePolicy',
        rafHint: 'Roku Ad Certification requires spacing midroll breaks at least 7–10 minutes (420–600s) apart in long-form VOD.',
      });
    }
  }
}

export function validateAdTag(
  rawXml: string,
  options?: { preParsed?: ParsedAdTag; expandedUrl?: string; policy?: RokuAdPolicyContext }
): ValidationReport {
  const issues: ValidationIssue[] = [];
  let parsed: ParsedAdTag;

  if (options?.preParsed) {
    parsed = options.preParsed;
  } else {
    const res = parseAdXml(rawXml);
    parsed = res.parsed;
    if (res.xmlError) {
      issues.push({
        severity: 'error',
        code: 'XML_PARSE_ERROR',
        message: res.xmlError,
        location: 'Document',
        rafHint: 'Ensure the ad server returns well-formed UTF-8 XML with <VAST> or <vmap:VMAP> root.',
      });
    }
  }

  if (parsed.wrapperHops && parsed.wrapperHops.length > 0) {
    const wrapperCount = parsed.wrapperHops.filter((h) => h.isWrapper).length;
    if (wrapperCount > 5) {
      issues.push({
        severity: 'error',
        code: 'MAX_WRAPPER_DEPTH_EXCEEDED',
        message: `Wrapper chain depth (${wrapperCount} hops) exceeds Roku RAF limit of 5 redirects.`,
        location: 'WrapperChain',
        rafHint: 'Roku RAF aborts wrapper chains deeper than 5 hops and fires VAST error 302.',
      });
    }
    for (const hop of parsed.wrapperHops) {
      if (hop.error) {
        issues.push({
          severity: 'error',
          code: 'WRAPPER_HOP_FAILED',
          message: `Wrapper hop #${hop.hop} failed: ${hop.error}`,
          location: hop.url,
          rafHint: 'Check upstream ad server availability, TLS certificate chain, and response latency.',
        });
      }
    }
  }

  if (parsed.tagType === 'VAST') {
    validateVastStructure(parsed, issues);
  } else if (parsed.tagType === 'SMRX') {
    issues.push({
      severity: 'info',
      code: 'FREEWHEEL_SMARTXML_DETECTED',
      message: `FreeWheel SmartXML (<adResponse>) schedule detected with ${parsed.ads.length} ad(s) and ${parsed.adBreaks.length} temporal slot(s).`,
      location: 'adResponse',
      rafHint: 'Roku RAF parses FreeWheel SmartXML natively via raf.getAds(). Ensure asset URLs use HTTPS or reachable HTTP MP4/HLS streams.',
    });
    for (const ad of parsed.ads) {
      const compatible = ad.linears.flatMap((l) => l.mediaFiles).filter((m) => m.rafCompatible);
      if (compatible.length === 0) {
        issues.push({
          severity: 'error',
          code: 'NO_RAF_COMPATIBLE_MEDIA',
          message: `SmartXML Ad ${ad.id} has no Roku RAF-compatible MP4/HLS asset.`,
          location: `adResponse > ad[adId=${ad.id}]`,
          rafHint: 'Provide at least one video/mp4 or application/x-mpegURL creativeRendition asset.',
        });
      }
      if (ad.impressions.length === 0) {
        issues.push({
          severity: 'warning',
          code: 'SMRX_NO_EVENT_CALLBACKS',
          message: `SmartXML Ad ${ad.id} has no <eventCallback> impression/quartile tracking URLs (common in static demo feeds).`,
          location: `adResponse > ad[adId=${ad.id}]`,
          rafHint: 'Production FreeWheel SmartXML responses include <eventCallbacks> for slotImpression, defaultImpression, and quartiles.',
        });
      }
    }
  } else if (parsed.tagType === 'VMAP') {
    if (parsed.adBreaks.length === 0) {
      issues.push({
        severity: 'warning',
        code: 'EMPTY_VMAP',
        message: 'VMAP schedule contains zero <AdBreak> definitions.',
        location: 'VMAP',
        rafHint: 'Add at least one <vmap:AdBreak timeOffset="start" breakType="linear">.',
      });
    }
    for (const brk of parsed.adBreaks) {
      const loc = `AdBreak[id=${brk.id}, offset=${brk.timeOffset}]`;
      if (!VALID_VMAP_OFFSET.test(brk.timeOffset)) {
        issues.push({
          severity: 'error',
          code: 'INVALID_VMAP_TIMEOFFSET',
          message: `Invalid VMAP timeOffset "${brk.timeOffset}".`,
          location: loc,
          rafHint: 'Use "start", "end", "HH:MM:SS", "n%", or "#n".',
        });
      }
      if (!brk.adTagUri && !brk.inlineVast) {
        issues.push({
          severity: 'error',
          code: 'ADBREAK_MISSING_SOURCE',
          message: 'VMAP AdBreak has neither <AdTagURI> nor inline <VASTAdData>.',
          location: loc,
          rafHint: 'Provide a <vmap:AdTagURI> or embedded <vmap:VASTAdData> inside <vmap:AdSource>.',
        });
      }
      if (brk.inlineVast) {
        validateVastStructure(brk.inlineVast, issues, `${loc} > `);
      }
    }
    evaluateBreakSchedulePolicies(parsed.adBreaks, issues, options?.policy);
  }

  if (parsed.tagType === 'SMRX') {
    evaluateBreakSchedulePolicies(parsed.adBreaks, issues, options?.policy);
  }

  const unexpandedMacros = detectUnexpandedMacros(`${options?.expandedUrl ?? ''}\n${rawXml}`).filter(
    (m) => m.startsWith('ROKU_ADS_')
  );
  if (unexpandedMacros.length > 0) {
    issues.push({
      severity: 'info',
      code: 'ROKU_MACROS_PRESENT',
      message: `Tag contains Roku RAF macros (${unexpandedMacros.join(', ')}).`,
      location: 'Macros',
      rafHint: 'RAF automatically expands ROKU_ADS_* macros in the initial setAdUrl(), but does NOT expand custom DSP macros unless mapped.',
    });
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warnCount = issues.filter((i) => i.severity === 'warning').length;
  const rawScore = 100 - errorCount * 30 - warnCount * 8;
  const score = Math.max(0, Math.min(100, rawScore));

  return {
    score,
    validForRaf: errorCount === 0 && parsed.tagType !== 'UNKNOWN',
    expandedUrl: options?.expandedUrl,
    unexpandedMacros,
    parsed,
    issues,
    rawXml,
  };
}
