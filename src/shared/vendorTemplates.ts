import { DEFAULT_RAF_MACROS } from './rafMacros.js';
import type {
  VendorAuditFinding,
  VendorBuildParams,
  VendorId,
  VendorRequestAudit,
} from './types.js';

export const VENDOR_LABELS: Record<VendorId, string> = {
  gam: 'Google Ad Manager (GAM CSAI VAST/VMAP)',
  'google-dai-vod': 'Google DAI — VOD HLS Session',
  'google-dai-live': 'Google DAI — Live Linear HLS Session',
  springserve: 'SpringServe CTV Ad Router',
  publica: 'Publica CTV Pod Decisioning',
  freewheel: 'FreeWheel SmartXML / VAST 4',
};

export function buildVendorRequestTemplate(
  params: VendorBuildParams,
  localMockBaseUrl?: string
): { requestUrl: string; method: 'GET' | 'POST'; postBody?: Record<string, string> } {
  const rida = params.useRokuMacros ? 'ROKU_ADS_TRACKING_ID' : DEFAULT_RAF_MACROS.ROKU_ADS_TRACKING_ID;
  const lat = params.useRokuMacros ? 'ROKU_ADS_LIMIT_TRACKING' : DEFAULT_RAF_MACROS.ROKU_ADS_LIMIT_TRACKING;
  const cb = params.useRokuMacros ? 'ROKU_ADS_CACHE_BUSTER' : DEFAULT_RAF_MACROS.ROKU_ADS_CACHE_BUSTER;
  const appId = params.useRokuMacros ? 'ROKU_ADS_APP_ID' : DEFAULT_RAF_MACROS.ROKU_ADS_APP_ID;
  const contentId = params.useRokuMacros ? 'ROKU_ADS_CONTENT_ID' : DEFAULT_RAF_MACROS.ROKU_ADS_CONTENT_ID;
  const tfcd = params.coppa ? '1' : '0';

  if (params.vendor === 'gam') {
    const host = localMockBaseUrl ? `${localMockBaseUrl}/mock/vast/gam-vmap-pod.xml` : 'https://pubads.g.doubleclick.net/gampad/ads';
    const q = new URLSearchParams({
      iu: params.adUnitOrProfile || `/${params.networkOrSupplyId || '21775744923'}/roku_ctv_video`,
      sz: '1920x1080',
      gdfp_req: '1',
      env: 'vp',
      output: params.outputFormat === 'vast4' ? 'xml_vast4' : 'vmap',
      unviewed_position_start: '1',
      rdid: rida,
      idtype: 'rida',
      is_lat: lat,
      correlator: cb,
      tfcd,
      us_privacy: params.usPrivacy || '1YNN',
      pmxd: String((params.maxAdDurationSec ?? 30) * 1000),
      pmad: String(Math.max(1, Math.round(params.podMaxDurationSec / 15))),
    });
    if (params.gpp) q.set('gpp', params.gpp);
    if (params.gppSid) q.set('gpp_sid', params.gppSid);
    if (params.customTargeting) q.set('cust_params', params.customTargeting);
    // Keep ROKU_ADS_* unencoded for RAF substitution
    const urlStr = `${host}?${q.toString()}`.replace(/%5BROKU_/g, '[ROKU_').replace(/%5D/g, ']');
    return { requestUrl: urlStr, method: 'GET' };
  }

  if (params.vendor === 'google-dai-vod') {
    const cms = encodeURIComponent(params.cmsId || '2548831');
    const vid = encodeURIComponent(params.videoId || 'tears-of-steel');
    const base = localMockBaseUrl
      ? `${localMockBaseUrl}/mock/dai/ondemand/hls/content/${cms}/vid/${vid}/streams`
      : `https://dai.google.com/ondemand/hls/content/${cms}/vid/${vid}/streams`;
    return {
      requestUrl: base,
      method: 'POST',
      postBody: {
        rdid: rida,
        idtype: 'rida',
        is_lat: lat,
        us_privacy: params.usPrivacy || '1YNN',
        tfcd,
        ...(params.customTargeting ? { cust_params: params.customTargeting } : {}),
      },
    };
  }

  if (params.vendor === 'google-dai-live') {
    const asset = encodeURIComponent(params.assetKey || 'sample-dai-live-asset');
    const base = localMockBaseUrl
      ? `${localMockBaseUrl}/mock/dai/live/hls/asset/${asset}/streams`
      : `https://dai.google.com/live/hls/asset/${asset}/streams`;
    return {
      requestUrl: base,
      method: 'POST',
      postBody: {
        rdid: rida,
        idtype: 'rida',
        is_lat: lat,
        us_privacy: params.usPrivacy || '1YNN',
        tfcd,
      },
    };
  }

  if (params.vendor === 'springserve') {
    const supplyId = encodeURIComponent(params.networkOrSupplyId || '123456');
    const host = localMockBaseUrl
      ? `${localMockBaseUrl}/mock/vast/springserve-pod.xml`
      : `https://vid.springserve.com/rt/${supplyId}`;
    const q = new URLSearchParams({
      w: '1920',
      h: '1080',
      cb,
      did: rida,
      dnt: lat,
      ifa_type: 'rida',
      app_bundle: appId,
      content_id: contentId,
      pod_max_dur: String(params.podMaxDurationSec || 90),
      max_dur: String(params.maxAdDurationSec || 30),
      us_privacy: params.usPrivacy || '1YNN',
      coppa: tfcd,
    });
    if (params.gpp) q.set('gpp', params.gpp);
    if (params.gppSid) q.set('gpp_sid', params.gppSid);
    return { requestUrl: `${host}?${q.toString()}`, method: 'GET' };
  }

  if (params.vendor === 'publica') {
    const host = localMockBaseUrl
      ? `${localMockBaseUrl}/mock/vast/pod-3-ads.xml`
      : `https://pbs.getpublica.com/v1/s2s-hb`;
    const q = new URLSearchParams({
      site_id: params.networkOrSupplyId || 'pub-roku-01',
      app_bundle: appId,
      did: rida,
      ifa_type: 'rida',
      lmt: lat,
      w: '1920',
      h: '1080',
      pod_duration: String(params.podMaxDurationSec || 90),
      max_ad_duration: String(params.maxAdDurationSec || 30),
      cb,
      us_privacy: params.usPrivacy || '1YNN',
      coppa: tfcd,
    });
    if (params.gpp) q.set('gpp', params.gpp);
    return { requestUrl: `${host}?${q.toString()}`, method: 'GET' };
  }

  // FreeWheel
  const nw = params.networkOrSupplyId || '96749';
  const host = localMockBaseUrl
    ? `${localMockBaseUrl}/mock/vast/freewheel-vast.xml`
    : `https://${nw}.v.fwmrm.net/ad/g/1`;
  const q = new URLSearchParams({
    nw,
    prof: params.adUnitOrProfile || `${nw}:roku_ctv_live`,
    csid: 'roku_ctv_section',
    caid: contentId,
    resp: 'vast4',
    metr: '1031',
    _fw_vcid2: rida,
    _fw_did: `rida:${rida}`,
    _fw_is_lat: lat,
    _fw_us_privacy: params.usPrivacy || '1YNN',
    _fw_coppa: tfcd,
    pvrn: cb,
    vprn: cb,
  });
  return { requestUrl: `${host}?${q.toString()}`, method: 'GET' };
}

export function detectVendorFromUrl(url: string): VendorId | 'generic-ctv' {
  const lower = url.toLowerCase();
  if (lower.includes('dai.google.com') || lower.includes('/mock/dai/')) {
    return lower.includes('/live/') ? 'google-dai-live' : 'google-dai-vod';
  }
  if (lower.includes('doubleclick.net') || lower.includes('gampad/ads') || lower.includes('gam-vmap')) {
    return 'gam';
  }
  if (lower.includes('springserve.com') || lower.includes('springserve-pod')) {
    return 'springserve';
  }
  if (lower.includes('getpublica.com')) {
    return 'publica';
  }
  if (lower.includes('fwmrm.net') || lower.includes('freewheel')) {
    return 'freewheel';
  }
  return 'generic-ctv';
}

/**
 * Audits a CTV / Roku ad request URL for required Roku Advertising Certification & vendor parameters.
 */
export function auditVendorAdRequestUrl(rawUrl: string): VendorRequestAudit {
  const detectedVendor = detectVendorFromUrl(rawUrl);
  const findings: VendorAuditFinding[] = [];

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      detectedVendor,
      url: rawUrl,
      score: 0,
      findings: [
        {
          severity: 'error',
          param: 'url',
          status: 'missing',
          message: 'Malformed HTTP(S) URL.',
        },
      ],
    };
  }

  const sp = parsed.searchParams;
  const firstParam = (...names: string[]) => {
    for (const n of names) {
      const v = sp.get(n);
      if (v !== null && v !== '') return { key: n, value: v };
    }
    return null;
  };

  // 1. RIDA identifier check
  const rida = firstParam('rdid', 'did', '_fw_vcid2', 'ifa', 'device_id');
  if (!rida) {
    findings.push({
      severity: 'error',
      param: 'rdid / did (RIDA)',
      status: 'missing',
      message: 'Missing Roku ID for Advertising (rdid / did / _fw_vcid2). Required for frequency capping & monetization.',
    });
  } else {
    findings.push({
      severity: 'info',
      param: rida.key,
      status: 'ok',
      value: rida.value,
      message: 'Roku Advertising ID parameter present.',
    });
  }

  // 2. Limit Ad Tracking (LAT / DNT / LMT) check
  const lat = firstParam('is_lat', 'dnt', 'lmt', '_fw_is_lat', 'lat');
  if (!lat) {
    findings.push({
      severity: 'error',
      param: 'is_lat / dnt / lmt',
      status: 'missing',
      message: 'Missing Limit Ad Tracking signal (ROKU_ADS_LIMIT_TRACKING). Roku Certification requires passing user LAT status.',
    });
  } else {
    findings.push({
      severity: 'info',
      param: lat.key,
      status: 'ok',
      value: lat.value,
      message: 'Limit Ad Tracking parameter present.',
    });

    // Privacy cross-check: if LAT == 1, RIDA must not be a raw personal UUID unless zeroed or macro
    if (
      lat.value === '1' &&
      rida &&
      !rida.value.includes('ROKU_ADS_') &&
      rida.value !== '00000000-0000-0000-0000-000000000000'
    ) {
      findings.push({
        severity: 'warning',
        param: `${rida.key} + ${lat.key}=1`,
        status: 'warning',
        value: rida.value,
        message: 'LAT is set to 1 while a non-zeroed RIDA UUID is passed. Verify your channel uses roDeviceInfo.IsRIDADisabled() and zeroes RIDA when required.',
      });
    }
  }

  // 3. GAM-specific idtype check across CTV platforms (rida, afai, idfa, tifa, lgudid)
  if (detectedVendor === 'gam') {
    const idtype = sp.get('idtype');
    const validIdTypes = new Set(['rida', 'afai', 'idfa', 'tifa', 'lgudid', 'adid', 'ppid']);
    if (!idtype || !validIdTypes.has(idtype.toLowerCase())) {
      findings.push({
        severity: 'warning',
        param: 'idtype',
        status: idtype ? 'warning' : 'missing',
        value: idtype ?? undefined,
        message: 'GAM CTV requests should pass idtype=rida (Roku), afai (Fire TV), idfa (tvOS), tifa (Tizen), or lgudid (webOS).',
      });
    }
  }

  // 4. Cachebuster / Correlator
  const cb = firstParam('correlator', 'cb', 'pvrn', 'ord', 'cachebuster');
  if (!cb && !detectedVendor.startsWith('google-dai')) {
    findings.push({
      severity: 'warning',
      param: 'correlator / cb',
      status: 'missing',
      message: 'Missing cachebuster/correlator parameter (ROKU_ADS_CACHE_BUSTER). Risk of cached VAST responses.',
    });
  }

  // 5. US Privacy / GPP / COPPA
  const privacy = firstParam('us_privacy', '_fw_us_privacy', 'gpp');
  if (!privacy) {
    findings.push({
      severity: 'warning',
      param: 'us_privacy / gpp',
      status: 'missing',
      message: 'No IAB US Privacy (us_privacy) or GPP consent string found on request.',
    });
  } else if (privacy.key.includes('us_privacy') && !/^1[YN-]{3}$/i.test(privacy.value)) {
    findings.push({
      severity: 'warning',
      param: privacy.key,
      status: 'warning',
      value: privacy.value,
      message: `US Privacy value "${privacy.value}" does not match standard 4-char IAB format (e.g., 1YNN or 1---).`,
    });
  }

  // 6. Pod duration / resolution hints
  const podDur = firstParam('pod_max_dur', 'pod_duration', 'pmxd');
  if (!podDur && (detectedVendor === 'springserve' || detectedVendor === 'publica')) {
    findings.push({
      severity: 'warning',
      param: 'pod_max_dur / pod_duration',
      status: 'missing',
      message: 'Missing pod duration budget parameter; ad router may return single spot instead of full CTV pod.',
    });
  }

  const errCount = findings.filter((f) => f.severity === 'error').length;
  const warnCount = findings.filter((f) => f.severity === 'warning').length;
  const score = Math.max(0, Math.min(100, 100 - errCount * 30 - warnCount * 10));

  return {
    detectedVendor,
    url: rawUrl,
    score,
    findings,
  };
}
