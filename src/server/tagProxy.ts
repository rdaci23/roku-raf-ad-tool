import { expandRafMacros } from '../shared/rafMacros.js';
import { mergeWrapperIntoInline, parseAdXml } from '../shared/vastParser.js';
import type { ParsedAd, ParsedAdTag, RafMacroValues, WrapperHop } from '../shared/types.js';

export interface FetchAndUnwrapResult {
  rawXml: string;
  expandedUrl: string;
  parsed: ParsedAdTag;
}

/**
 * Fetches an external or local VAST/VMAP tag URL, expands Roku RAF macros,
 * and follows <Wrapper><VASTAdTagURI> hops (up to 6 hops so >5 limit violations are detected).
 */
export async function fetchAndUnwrapAdTag(
  adTagUrl: string,
  macroOverrides?: Partial<RafMacroValues>,
  maxHops = 6
): Promise<FetchAndUnwrapResult> {
  const expandedUrl = expandRafMacros(adTagUrl, macroOverrides);
  const hops: WrapperHop[] = [];
  const accumulatedWrappers: ParsedAd[] = [];

  let currentUrl = expandedUrl;
  let latestRawXml = '';
  let finalParsed: ParsedAdTag = { tagType: 'UNKNOWN', ads: [], adBreaks: [], vastErrorUrls: [] };

  for (let hopNum = 1; hopNum <= maxHops; hopNum++) {
    const started = Date.now();
    try {
      const resp = await fetch(currentUrl, {
        headers: {
          'User-Agent': 'Roku/DVP-12.5 (12.5.0.4178-88) RokuRAFAdTool/1.0',
          Accept: 'application/xml, text/xml, */*',
        },
        signal: AbortSignal.timeout(8000),
      });
      const durationMs = Date.now() - started;
      const text = await resp.text();
      if (hopNum === 1 || text.trim()) {
        latestRawXml = text;
      }

      if (!resp.ok) {
        hops.push({
          hop: hopNum,
          url: currentUrl,
          status: resp.status,
          durationMs,
          tagType: 'UNKNOWN',
          isWrapper: false,
          impressionsCount: 0,
          trackingCount: 0,
          error: `HTTP ${resp.status} ${resp.statusText}`,
        });
        break;
      }

      const { parsed, xmlError } = parseAdXml(text);
      if (xmlError) {
        hops.push({
          hop: hopNum,
          url: currentUrl,
          status: resp.status,
          durationMs,
          tagType: 'UNKNOWN',
          isWrapper: false,
          impressionsCount: 0,
          trackingCount: 0,
          error: xmlError,
        });
        finalParsed = parsed;
        break;
      }

      const firstWrapper = parsed.ads.find((a) => a.adType === 'Wrapper' && a.vastAdTagUri);
      const impCount = parsed.ads.reduce((acc, a) => acc + a.impressions.length, 0);
      const trkCount = parsed.ads.reduce(
        (acc, a) => acc + a.linears.reduce((s, l) => s + l.trackingEvents.length, 0),
        0
      );

      hops.push({
        hop: hopNum,
        url: currentUrl,
        status: resp.status,
        durationMs,
        tagType: parsed.tagType,
        version: parsed.version,
        isWrapper: Boolean(firstWrapper),
        nextTagUri: firstWrapper?.vastAdTagUri,
        impressionsCount: impCount,
        trackingCount: trkCount,
      });

      if (firstWrapper && firstWrapper.vastAdTagUri) {
        accumulatedWrappers.push(firstWrapper);
        currentUrl = expandRafMacros(firstWrapper.vastAdTagUri, macroOverrides);
        finalParsed = parsed;
        continue;
      }

      finalParsed = mergeWrapperIntoInline(accumulatedWrappers, parsed);
      break;
    } catch (err) {
      hops.push({
        hop: hopNum,
        url: currentUrl,
        status: 0,
        durationMs: Date.now() - started,
        tagType: 'UNKNOWN',
        isWrapper: false,
        impressionsCount: 0,
        trackingCount: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }
  }

  finalParsed.wrapperHops = hops;
  return {
    rawXml: latestRawXml,
    expandedUrl,
    parsed: finalParsed,
  };
}

function wrapUrlInCdataOrText(
  innerContent: string,
  makeProxyUrl: (originalUrl: string) => string
): string {
  const cdataMatch = innerContent.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdataMatch) {
    const orig = cdataMatch[1].trim();
    if (!orig) return innerContent;
    return `<![CDATA[${makeProxyUrl(orig)}]]>`;
  }
  const orig = innerContent.trim();
  if (!orig) return innerContent;
  return `<![CDATA[${makeProxyUrl(orig)}]]>`;
}

/**
 * Rewrites <Impression>, <Error>, <Tracking event="...">, <ClickTracking>,
 * <VASTAdTagURI>, and <vmap:AdTagURI> inside any VAST/VMAP XML document so
 * Roku RAF sends every beacon and nested wrapper call through our local debugger!
 */
export function instrumentAdXmlForProxy(
  xml: string,
  opts: {
    baseUrl: string;
    sessionId: string;
    forwardUpstream: boolean;
    podId?: string;
  }
): string {
  const root = opts.baseUrl.replace(/\/$/, '');
  const fwd = opts.forwardUpstream ? '1' : '0';
  const podId = opts.podId || 'proxied-pod';

  const makeBeaconProxy = (event: string, originalUrl: string, adId: string, activePodId: string) => {
    // Keep [ERRORCODE] unencoded at the tail so Roku RAF performs runtime substitution on the URL!
    const hasErrorMacro = /\[ERRORCODE\]/i.test(originalUrl);
    const q = new URLSearchParams({
      session: opts.sessionId,
      event,
      adId,
      podId: activePodId,
      forward: fwd,
      target: originalUrl,
    });
    let built = `${root}/api/beacon/hit?${q.toString()}`;
    if (hasErrorMacro) {
      built += '&errorCode=[ERRORCODE]';
    }
    return built;
  };

  const makeTagProxy = (originalTagUrl: string, childPodId: string) => {
    const q = new URLSearchParams({
      session: opts.sessionId,
      podId: childPodId,
      forward: fwd,
      url: originalTagUrl,
    });
    return `${root}/proxy/tag?${q.toString()}`;
  };

  const instrumentBlockBeacons = (blockXml: string, adId: string, activePodId: string): string => {
    let b = blockXml;
    b = b.replace(/<Impression(\b[^>]*)>([\s\S]*?)<\/Impression>/gi, (_m, attrs, inner) => {
      return `<Impression${attrs}>${wrapUrlInCdataOrText(inner, (u) => makeBeaconProxy('impression', u, adId, activePodId))}</Impression>`;
    });
    b = b.replace(/<Error(\b[^>]*)>([\s\S]*?)<\/Error>/gi, (_m, attrs, inner) => {
      return `<Error${attrs}>${wrapUrlInCdataOrText(inner, (u) => makeBeaconProxy('error', u, adId, activePodId))}</Error>`;
    });
    b = b.replace(
      /<([a-z0-9_]+:)?Tracking(\b[^>]*)>([\s\S]*?)<\/\1?Tracking>/gi,
      (_m, ns = '', attrs, inner) => {
        const evMatch = String(attrs).match(/\bevent\s*=\s*["']([^"']+)["']/i);
        const evName = evMatch ? evMatch[1] : 'tracking';
        return `<${ns}Tracking${attrs}>${wrapUrlInCdataOrText(inner, (u) => makeBeaconProxy(evName, u, adId, activePodId))}</${ns}Tracking>`;
      }
    );
    b = b.replace(/<ClickTracking(\b[^>]*)>([\s\S]*?)<\/ClickTracking>/gi, (_m, attrs, inner) => {
      return `<ClickTracking${attrs}>${wrapUrlInCdataOrText(inner, (u) => makeBeaconProxy('clickTracking', u, adId, activePodId))}</ClickTracking>`;
    });
    return b;
  };

  let out = xml;

  // Instrument VMAP <AdBreak> child AdTagURIs with per-break podId so preroll/midroll/postroll stay distinct
  let breakIdx = 0;
  out = out.replace(/<([a-z0-9_]+:)?AdBreak(\b[^>]*)>([\s\S]*?)<\/\1?AdBreak>/gi, (_m, ns = '', attrs, inner) => {
    breakIdx += 1;
    const idMatch = String(attrs).match(/\bbreakId\s*=\s*["']([^"']+)["']/i);
    const childPodId = idMatch ? idMatch[1] : `vmap-break-${breakIdx}`;
    const rewrittenInner = inner.replace(
      /<([a-z0-9_]+:)?AdTagURI(\b[^>]*)>([\s\S]*?)<\/\1?AdTagURI>/gi,
      (_m2: string, ns2 = '', attrs2: string, tagInner: string) =>
        `<${ns2}AdTagURI${attrs2}>${wrapUrlInCdataOrText(tagInner, (u) => makeTagProxy(u, childPodId))}</${ns2}AdTagURI>`
    );
    return `<${ns}AdBreak${attrs}>${rewrittenInner}</${ns}AdBreak>`;
  });

  // Instrument each <Ad id="...">...</Ad> with scoped adId so multi-ad pods & multi-break VMAPs never collide
  if (/<Ad\b/i.test(out)) {
    let adIdx = 0;
    out = out.replace(/<Ad(\b[^>]*)>([\s\S]*?)<\/Ad>/gi, (_m, attrs, inner) => {
      adIdx += 1;
      const idMatch = String(attrs).match(/\bid\s*=\s*["']([^"']+)["']/i);
      const rawAdId = idMatch ? idMatch[1] : `ad-${adIdx}`;
      const scopedAdId = podId !== 'proxied-pod' ? `${podId}-${rawAdId}` : rawAdId;
      const withBeacons = instrumentBlockBeacons(inner, scopedAdId, podId);
      const withWrapper = withBeacons.replace(
        /<([a-z0-9_]+:)?VASTAdTagURI(\b[^>]*)>([\s\S]*?)<\/\1?VASTAdTagURI>/gi,
        (_m2: string, ns2 = '', attrs2: string, uriInner: string) =>
          `<${ns2}VASTAdTagURI${attrs2}>${wrapUrlInCdataOrText(uriInner, (u) => makeTagProxy(u, podId))}</${ns2}VASTAdTagURI>`
      );
      return `<Ad${attrs}>${withWrapper}</Ad>`;
    });
  } else {
    out = instrumentBlockBeacons(out, 'proxied-ad', podId);
  }

  return out;
}
