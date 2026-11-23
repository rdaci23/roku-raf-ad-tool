import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type {
  ParsedAd,
  ParsedAdBreak,
  ParsedAdTag,
  ParsedCompanionAd,
  ParsedLinearCreative,
  ParsedMediaFile,
  ParsedTrackingEvent,
} from './types.js';

const ROKU_SUPPORTED_MIME_TYPES = new Set([
  'video/mp4',
  'video/mp4-h264',
  'video/quicktime',
  'video/x-m4v',
  'application/x-mpegurl',
  'application/vnd.apple.mpegurl',
  'audio/mpegurl',
  'video/mp2t',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  cdataPropName: '__cdata',
  removeNSPrefix: true,
  parseAttributeValue: false,
  trimValues: true,
});

function toArray<T>(val: T | T[] | undefined | null): T[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function extractText(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return String(node).trim();
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj.__cdata === 'string') return obj.__cdata.trim();
    if (obj.__cdata !== undefined) return extractText(obj.__cdata);
    if (obj['#text'] !== undefined) return String(obj['#text']).trim();
  }
  return '';
}

function toInt(val: unknown): number | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  const n = Number.parseInt(String(val), 10);
  return Number.isFinite(n) ? n : undefined;
}

export function parseDurationToSeconds(duration?: string): number | undefined {
  if (!duration) return undefined;
  const m = duration.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!m) return undefined;
  const hours = Number.parseInt(m[1], 10);
  const mins = Number.parseInt(m[2], 10);
  const secs = Number.parseInt(m[3], 10);
  const ms = m[4] ? Number.parseInt(m[4].padEnd(3, '0'), 10) / 1000 : 0;
  return hours * 3600 + mins * 60 + secs + ms;
}

function evaluateMediaFileCompatibility(mf: Omit<ParsedMediaFile, 'rafCompatible' | 'rafNotes'>): {
  rafCompatible: boolean;
  rafNotes: string[];
} {
  const notes: string[] = [];
  let compatible = true;

  const framework = (mf.apiFramework || '').toUpperCase();
  const mime = (mf.type || '').toLowerCase().trim();

  if (framework === 'VPAID' || framework === 'SIMID' || mime === 'application/javascript' || mime === 'application/x-shockwave-flash') {
    compatible = false;
    notes.push(`Unsupported framework/type on Roku RAF (${mf.apiFramework || mf.type}). Roku RAF does not execute JS VPAID or Flash.`);
  } else if (!mime) {
    compatible = false;
    notes.push('Missing MIME type attribute on <MediaFile>.');
  } else if (!ROKU_SUPPORTED_MIME_TYPES.has(mime)) {
    compatible = false;
    notes.push(`MIME type "${mf.type}" is not supported by Roku video player (use video/mp4 or application/x-mpegURL).`);
  }

  if (!mf.url || !/^https?:\/\//i.test(mf.url)) {
    compatible = false;
    notes.push('MediaFile URL is missing or not a valid HTTP/HTTPS URL.');
  }

  if (mf.bitrate && mf.bitrate > 10000) {
    notes.push(`High bitrate (${mf.bitrate} kbps) may cause rebuffering on entry-level Roku devices.`);
  }
  if (!mf.width || !mf.height) {
    notes.push('Missing width/height attributes; RAF rendition selection works best with explicit dimensions.');
  }

  return { rafCompatible: compatible, rafNotes: notes };
}

function parseLinear(linearNode: Record<string, unknown>, creativeId?: string, creativeAdId?: string): ParsedLinearCreative {
  const duration = extractText(linearNode.Duration) || undefined;
  const skipOffset = typeof linearNode['@_skipoffset'] === 'string' ? linearNode['@_skipoffset'] : undefined;

  const mediaFilesContainer = (linearNode.MediaFiles as Record<string, unknown> | undefined) ?? {};
  const rawMediaFiles = toArray(mediaFilesContainer.MediaFile);
  const mediaFiles: ParsedMediaFile[] = rawMediaFiles.map((item) => {
    const obj = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const base = {
      id: obj['@_id'] ? String(obj['@_id']) : undefined,
      url: extractText(item),
      delivery: obj['@_delivery'] ? String(obj['@_delivery']) : undefined,
      type: obj['@_type'] ? String(obj['@_type']) : undefined,
      bitrate: toInt(obj['@_bitrate']),
      minBitrate: toInt(obj['@_minBitrate']),
      maxBitrate: toInt(obj['@_maxBitrate']),
      width: toInt(obj['@_width']),
      height: toInt(obj['@_height']),
      codec: obj['@_codec'] ? String(obj['@_codec']) : undefined,
      apiFramework: obj['@_apiFramework'] ? String(obj['@_apiFramework']) : undefined,
      scalable: obj['@_scalable'] !== undefined ? String(obj['@_scalable']) === 'true' : undefined,
    };
    return {
      ...base,
      ...evaluateMediaFileCompatibility(base),
    };
  });

  const rawInteractive = toArray(mediaFilesContainer.InteractiveCreativeFile);
  const interactiveFiles = rawInteractive.map((item) => {
    const obj = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    return {
      url: extractText(item),
      apiFramework: obj['@_apiFramework'] ? String(obj['@_apiFramework']) : undefined,
      type: obj['@_type'] ? String(obj['@_type']) : undefined,
    };
  });

  const trackingContainer = (linearNode.TrackingEvents as Record<string, unknown> | undefined) ?? {};
  const trackingEvents: ParsedTrackingEvent[] = toArray(trackingContainer.Tracking)
    .map((t) => {
      const obj = (typeof t === 'object' && t !== null ? t : {}) as Record<string, unknown>;
      return {
        event: obj['@_event'] ? String(obj['@_event']) : 'unknown',
        offset: obj['@_offset'] ? String(obj['@_offset']) : undefined,
        url: extractText(t),
      };
    })
    .filter((t) => Boolean(t.url));

  const videoClicks = (linearNode.VideoClicks as Record<string, unknown> | undefined) ?? {};
  const clickThrough = extractText(videoClicks.ClickThrough) || undefined;
  const clickTracking = toArray(videoClicks.ClickTracking)
    .map((c) => extractText(c))
    .filter(Boolean);

  return {
    id: creativeId,
    adId: creativeAdId,
    duration,
    durationSeconds: parseDurationToSeconds(duration),
    skipOffset,
    mediaFiles,
    interactiveFiles,
    trackingEvents,
    clickThrough,
    clickTracking,
  };
}

function parseCompanions(companionAdsNode: unknown): ParsedCompanionAd[] {
  if (!companionAdsNode || typeof companionAdsNode !== 'object') return [];
  const container = companionAdsNode as Record<string, unknown>;
  return toArray(container.Companion).map((c) => {
    const obj = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
    let resourceType: ParsedCompanionAd['resourceType'] = 'Unknown';
    let creativeType: string | undefined;
    let url: string | undefined;

    if (obj.StaticResource) {
      resourceType = 'StaticResource';
      const sr = obj.StaticResource as Record<string, unknown>;
      creativeType = sr['@_creativeType'] ? String(sr['@_creativeType']) : undefined;
      url = extractText(obj.StaticResource);
    } else if (obj.IFrameResource) {
      resourceType = 'IFrameResource';
      url = extractText(obj.IFrameResource);
    } else if (obj.HTMLResource) {
      resourceType = 'HTMLResource';
      url = extractText(obj.HTMLResource);
    }

    return {
      id: obj['@_id'] ? String(obj['@_id']) : undefined,
      width: toInt(obj['@_width']),
      height: toInt(obj['@_height']),
      resourceType,
      creativeType,
      url,
      clickThrough: extractText(obj.CompanionClickThrough) || undefined,
    };
  });
}

function parseVastObject(vastObj: Record<string, unknown>): ParsedAdTag {
  const version = vastObj['@_version'] ? String(vastObj['@_version']) : undefined;
  const vastErrorUrls = toArray(vastObj.Error)
    .map((e) => extractText(e))
    .filter(Boolean);

  const rawAds = toArray(vastObj.Ad);
  const ads: ParsedAd[] = rawAds.map((adItem, idx) => {
    const adObj = (typeof adItem === 'object' && adItem !== null ? adItem : {}) as Record<string, unknown>;
    const id = adObj['@_id'] ? String(adObj['@_id']) : `ad-${idx + 1}`;
    const sequence = toInt(adObj['@_sequence']);
    const isWrapper = Boolean(adObj.Wrapper);
    const body = ((adObj.InLine ?? adObj.Wrapper ?? {}) as Record<string, unknown>);

    const adSystem = extractText(body.AdSystem) || undefined;
    const adTitle = extractText(body.AdTitle) || undefined;
    const vastAdTagUri = extractText(body.VASTAdTagURI) || undefined;

    const impressions = toArray(body.Impression)
      .map((imp) => extractText(imp))
      .filter(Boolean);

    const errors = toArray(body.Error)
      .map((err) => extractText(err))
      .filter(Boolean);

    const verifContainer = (body.AdVerifications as Record<string, unknown> | undefined) ?? {};
    const verifications = toArray(verifContainer.Verification).map((v) => {
      const vo = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
      return vo['@_vendor'] ? String(vo['@_vendor']) : 'OMID/Verification';
    });

    const extContainer = (body.Extensions as Record<string, unknown> | undefined) ?? {};
    const extensions = toArray(extContainer.Extension).map((ext) => {
      const eo = (typeof ext === 'object' && ext !== null ? ext : {}) as Record<string, unknown>;
      return eo['@_type'] ? String(eo['@_type']) : JSON.stringify(eo).slice(0, 80);
    });

    const creativesContainer = (body.Creatives as Record<string, unknown> | undefined) ?? {};
    const rawCreatives = toArray(creativesContainer.Creative);

    const linears: ParsedLinearCreative[] = [];
    const companions: ParsedCompanionAd[] = [];

    for (const cr of rawCreatives) {
      const crObj = (typeof cr === 'object' && cr !== null ? cr : {}) as Record<string, unknown>;
      const crId = crObj['@_id'] ? String(crObj['@_id']) : undefined;
      const crAdId = crObj['@_adId'] || crObj['@_AdID'] ? String(crObj['@_adId'] ?? crObj['@_AdID']) : undefined;

      if (crObj.Linear && typeof crObj.Linear === 'object') {
        linears.push(parseLinear(crObj.Linear as Record<string, unknown>, crId, crAdId));
      }
      if (crObj.CompanionAds) {
        companions.push(...parseCompanions(crObj.CompanionAds));
      }
    }

    return {
      id,
      sequence,
      adType: isWrapper ? 'Wrapper' : 'InLine',
      adSystem,
      adTitle,
      vastAdTagUri,
      impressions,
      errors,
      verifications,
      extensions,
      linears,
      companions,
    };
  });

  return {
    tagType: 'VAST',
    version,
    ads,
    adBreaks: [],
    vastErrorUrls,
  };
}

function parseVmapObject(vmapObj: Record<string, unknown>): ParsedAdTag {
  const version = vmapObj['@_version'] ? String(vmapObj['@_version']) : '1.0';
  const rawBreaks = toArray(vmapObj.AdBreak);

  const adBreaks: ParsedAdBreak[] = rawBreaks.map((brk, idx) => {
    const bObj = (typeof brk === 'object' && brk !== null ? brk : {}) as Record<string, unknown>;
    const adSource = (bObj.AdSource as Record<string, unknown> | undefined) ?? {};
    const adTagUriNode = adSource.AdTagURI;
    const adTagUriObj = (typeof adTagUriNode === 'object' && adTagUriNode !== null ? adTagUriNode : {}) as Record<
      string,
      unknown
    >;
    const adTagUri = extractText(adTagUriNode) || undefined;
    const templateType = adTagUriObj['@_templateType'] ? String(adTagUriObj['@_templateType']) : undefined;

    let inlineVast: ParsedAdTag | undefined;
    const vastData = adSource.VASTAdData as Record<string, unknown> | undefined;
    if (vastData && vastData.VAST && typeof vastData.VAST === 'object') {
      inlineVast = parseVastObject(vastData.VAST as Record<string, unknown>);
    }

    const trackingContainer = (bObj.TrackingEvents as Record<string, unknown> | undefined) ?? {};
    const trackingEvents: ParsedTrackingEvent[] = toArray(trackingContainer.Tracking)
      .map((t) => {
        const tObj = (typeof t === 'object' && t !== null ? t : {}) as Record<string, unknown>;
        return {
          event: tObj['@_event'] ? String(tObj['@_event']) : 'unknown',
          url: extractText(t),
        };
      })
      .filter((t) => Boolean(t.url));

    return {
      id: bObj['@_breakId'] ? String(bObj['@_breakId']) : `break-${idx + 1}`,
      timeOffset: bObj['@_timeOffset'] ? String(bObj['@_timeOffset']) : '',
      breakType: bObj['@_breakType'] ? String(bObj['@_breakType']) : undefined,
      repeatAfter: bObj['@_repeatAfter'] ? String(bObj['@_repeatAfter']) : undefined,
      adTagUri,
      templateType,
      trackingEvents,
      inlineVast,
    };
  });

  return {
    tagType: 'VMAP',
    version,
    ads: [],
    adBreaks,
    vastErrorUrls: [],
  };
}

function formatSecondsAsHhMmSs(sec: number): string {
  const whole = Math.max(0, Math.round(sec));
  const h = String(Math.floor(whole / 3600)).padStart(2, '0');
  const m = String(Math.floor((whole % 3600) / 60)).padStart(2, '0');
  const s = String(whole % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * Parses FreeWheel SmartXML (<adResponse>), natively supported by Roku RAF (e.g. Roku's official sample.xml).
 */
function parseSmartXmlObject(adRespObj: Record<string, unknown>): ParsedAdTag {
  const version = adRespObj['@_version'] ? String(adRespObj['@_version']) : '1';
  const adsContainer = (adRespObj.ads as Record<string, unknown> | undefined) ?? {};
  const rawAds = toArray(adsContainer.ad);

  const adsById = new Map<string, ParsedAd>();
  const ads: ParsedAd[] = rawAds.map((adNode, idx) => {
    const aObj = (typeof adNode === 'object' && adNode !== null ? adNode : {}) as Record<string, unknown>;
    const adId = aObj['@_adId'] ? String(aObj['@_adId']) : `smrx-ad-${idx + 1}`;
    const creativesContainer = (aObj.creatives as Record<string, unknown> | undefined) ?? {};
    const rawCreatives = toArray(creativesContainer.creative);

    const linears: ParsedLinearCreative[] = rawCreatives.map((crNode) => {
      const crObj = (typeof crNode === 'object' && crNode !== null ? crNode : {}) as Record<string, unknown>;
      const durNum = Number.parseFloat(String(crObj['@_duration'] ?? '0'));
      const durationSeconds = Number.isFinite(durNum) && durNum > 0 ? durNum : undefined;
      const duration = durationSeconds !== undefined ? formatSecondsAsHhMmSs(durationSeconds) : undefined;

      const renditionsContainer = (crObj.creativeRenditions as Record<string, unknown> | undefined) ?? {};
      const rawRenditions = toArray(renditionsContainer.creativeRendition);
      const mediaFiles: ParsedMediaFile[] = [];

      for (const rNode of rawRenditions) {
        const rObj = (typeof rNode === 'object' && rNode !== null ? rNode : {}) as Record<string, unknown>;
        const width = toInt(rObj['@_width']);
        const height = toInt(rObj['@_height']);
        for (const assetNode of toArray(rObj.asset)) {
          const asObj = (typeof assetNode === 'object' && assetNode !== null ? assetNode : {}) as Record<string, unknown>;
          const bytes = toInt(asObj['@_bytes']);
          const estBitrate =
            toInt(asObj['@_bitrate']) ??
            (bytes && durationSeconds ? Math.round((bytes * 8) / 1000 / durationSeconds) : undefined);
          const base = {
            id: asObj['@_id'] ? String(asObj['@_id']) : undefined,
            url: asObj['@_url'] ? String(asObj['@_url']) : extractText(assetNode),
            delivery: 'progressive',
            type: asObj['@_mimeType']
              ? String(asObj['@_mimeType'])
              : asObj['@_contentType']
                ? String(asObj['@_contentType'])
                : undefined,
            bitrate: estBitrate,
            width,
            height,
          };
          mediaFiles.push({
            ...base,
            ...evaluateMediaFileCompatibility(base),
          });
        }
      }

      return {
        id: crObj['@_creativeId'] ? String(crObj['@_creativeId']) : undefined,
        adId,
        duration,
        durationSeconds,
        mediaFiles,
        interactiveFiles: [],
        trackingEvents: [],
        clickTracking: [],
      };
    });

    const parsedAd: ParsedAd = {
      id: adId,
      sequence: idx + 1,
      adType: 'InLine',
      adSystem: 'FreeWheel SmartXML',
      adTitle: `SmartXML Ad ${adId}`,
      impressions: [],
      errors: [],
      verifications: [],
      extensions: ['FreeWheel-SMRX'],
      linears,
      companions: [],
    };
    adsById.set(adId, parsedAd);
    return parsedAd;
  });

  // Extract temporalAdSlot schedule breaks if present
  const siteSection = (adRespObj.siteSection as Record<string, unknown> | undefined) ?? {};
  const videoPlayer = (siteSection.videoPlayer as Record<string, unknown> | undefined) ?? {};
  const videoAsset = (videoPlayer.videoAsset as Record<string, unknown> | undefined) ?? {};
  const adSlotsContainer = (videoAsset.adSlots as Record<string, unknown> | undefined) ?? {};
  const rawSlots = toArray(adSlotsContainer.temporalAdSlot);

  const adBreaks: ParsedAdBreak[] = rawSlots.map((slotNode, idx) => {
    const sObj = (typeof slotNode === 'object' && slotNode !== null ? slotNode : {}) as Record<string, unknown>;
    const posClass = String(sObj['@_timePositionClass'] ?? '').toLowerCase();
    const rawPos = Number.parseFloat(String(sObj['@_timePosition'] ?? '0'));
    const timeOffset =
      posClass === 'preroll' || rawPos === 0
        ? 'start'
        : posClass === 'postroll'
          ? 'end'
          : formatSecondsAsHhMmSs(rawPos);

    const callbacksContainer = (sObj.eventCallbacks as Record<string, unknown> | undefined) ?? {};
    const callbacks = toArray(callbacksContainer.eventCallback);
    const slotImpressions = callbacks
      .map((cb) => {
        const cbObj = (typeof cb === 'object' && cb !== null ? cb : {}) as Record<string, unknown>;
        return cbObj['@_url'] ? String(cbObj['@_url']) : '';
      })
      .filter(Boolean);

    const selectedContainer = (sObj.selectedAds as Record<string, unknown> | undefined) ?? {};
    for (const ref of toArray(selectedContainer.adReference)) {
      const refObj = (typeof ref === 'object' && ref !== null ? ref : {}) as Record<string, unknown>;
      const refAd = refObj['@_adId'] ? adsById.get(String(refObj['@_adId'])) : undefined;
      if (refAd && slotImpressions.length > 0 && refAd.impressions.length === 0) {
        refAd.impressions.push(...slotImpressions);
      }
    }

    return {
      id: sObj['@_customId'] ? String(sObj['@_customId']) : `slot-${idx + 1}`,
      timeOffset,
      breakType: 'linear',
      templateType: 'smrx',
      trackingEvents: [],
    };
  });

  return {
    tagType: 'SMRX',
    version,
    ads,
    adBreaks,
    vastErrorUrls: [],
  };
}

export function parseAdXml(xml: string): { parsed: ParsedAdTag; xmlError?: string } {
  const trimmed = xml.trim();
  if (!trimmed) {
    return {
      parsed: { tagType: 'UNKNOWN', ads: [], adBreaks: [], vastErrorUrls: [] },
      xmlError: 'Empty XML payload.',
    };
  }

  const valid = XMLValidator.validate(trimmed);
  if (valid !== true) {
    return {
      parsed: { tagType: 'UNKNOWN', ads: [], adBreaks: [], vastErrorUrls: [] },
      xmlError: `XML syntax error at line ${valid.err.line}, col ${valid.err.col}: ${valid.err.msg}`,
    };
  }

  const doc = parser.parse(trimmed) as Record<string, unknown>;
  if (doc.VAST && typeof doc.VAST === 'object') {
    return { parsed: parseVastObject(doc.VAST as Record<string, unknown>) };
  }
  if (doc.VMAP && typeof doc.VMAP === 'object') {
    return { parsed: parseVmapObject(doc.VMAP as Record<string, unknown>) };
  }
  if (doc.adResponse && typeof doc.adResponse === 'object') {
    return { parsed: parseSmartXmlObject(doc.adResponse as Record<string, unknown>) };
  }

  return {
    parsed: { tagType: 'UNKNOWN', ads: [], adBreaks: [], vastErrorUrls: [] },
    xmlError: 'Root element must be <VAST>, <VMAP> (or <vmap:VMAP>), or FreeWheel <adResponse>.',
  };
}

/**
 * Merges accumulated Wrapper tracking events, impressions, and error URLs onto the final InLine VAST tag,
 * matching Roku RAF wrapper resolution behavior.
 */
export function mergeWrapperIntoInline(wrapperAds: ParsedAd[], inlineTag: ParsedAdTag): ParsedAdTag {
  if (wrapperAds.length === 0 || inlineTag.tagType !== 'VAST') return inlineTag;

  const extraImpressions = wrapperAds.flatMap((w) => w.impressions);
  const extraErrors = wrapperAds.flatMap((w) => w.errors);
  const extraTracking = wrapperAds.flatMap((w, hopIdx) =>
    w.linears.flatMap((l) => l.trackingEvents.map((t) => ({ ...t, sourceHop: hopIdx + 1 })))
  );
  const extraClickTracking = wrapperAds.flatMap((w) => w.linears.flatMap((l) => l.clickTracking));

  return {
    ...inlineTag,
    ads: inlineTag.ads.map((ad) => ({
      ...ad,
      impressions: [...extraImpressions, ...ad.impressions],
      errors: [...extraErrors, ...ad.errors],
      linears: ad.linears.map((lin) => ({
        ...lin,
        trackingEvents: [...extraTracking, ...lin.trackingEvents],
        clickTracking: [...extraClickTracking, ...lin.clickTracking],
      })),
    })),
  };
}
