import type { CustomMockConfig, MockScenarioType } from './types.js';

export interface MockBuildContext {
  baseUrl: string;
  sessionId: string;
  podId?: string;
  vastVersion?: '3.0' | '4.0';
  durationSec?: number;
  podSize?: number;
  skippableAfterSec?: number;
  wrapperDepth?: number;
  currentHop?: number;
  includeCompanion?: boolean;
}

function formatDuration(sec: number): string {
  const s = Math.max(1, Math.round(sec));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildBeaconUrl(
  baseUrl: string,
  params: { sessionId: string; event: string; adId: string; podId: string; extra?: string }
): string {
  const q = new URLSearchParams({
    session: params.sessionId,
    event: params.event,
    adId: params.adId,
    podId: params.podId,
  });
  let url = `${baseUrl}/api/beacon/hit?${q.toString()}`;
  if (params.extra) {
    url += `&${params.extra}`;
  }
  return url;
}

function buildLinearAdXml(opts: {
  baseUrl: string;
  sessionId: string;
  podId: string;
  adId: string;
  adSystem?: string;
  title: string;
  sequence?: number;
  durationSec: number;
  mediaUrl: string;
  mimeType?: string;
  apiFramework?: string;
  skippableAfterSec?: number;
  includeCompanion?: boolean;
}): string {
  const seqAttr = opts.sequence !== undefined ? ` sequence="${opts.sequence}"` : '';
  const skipAttr =
    opts.skippableAfterSec && opts.skippableAfterSec > 0
      ? ` skipoffset="${formatDuration(opts.skippableAfterSec)}"`
      : '';
  const mime = opts.mimeType ?? 'video/mp4';
  const apiAttr = opts.apiFramework ? ` apiFramework="${opts.apiFramework}"` : '';
  const systemName = opts.adSystem ?? 'RokuRAFAdToolMockServer';

  const events = [
    'start',
    'firstQuartile',
    'midpoint',
    'thirdQuartile',
    'complete',
    'mute',
    'unmute',
    'pause',
    'resume',
    'rewind',
    'skip',
    'closeLinear',
  ];

  const trackingLines = events
    .map(
      (ev) =>
        `              <Tracking event="${ev}"><![CDATA[${buildBeaconUrl(opts.baseUrl, {
          sessionId: opts.sessionId,
          event: ev,
          adId: opts.adId,
          podId: opts.podId,
        })}]]></Tracking>`
    )
    .join('\n');

  const companionBlock = opts.includeCompanion
    ? `
        <Creative id="${opts.adId}-comp">
          <CompanionAds>
            <Companion id="comp-300x250" width="300" height="250">
              <StaticResource creativeType="image/png"><![CDATA[${opts.baseUrl}/media/companion-banner.png]]></StaticResource>
              <CompanionClickThrough><![CDATA[https://developer.roku.com/docs/developer-program/advertising/roku-advertising-framework.md]]></CompanionClickThrough>
            </Companion>
          </CompanionAds>
        </Creative>`
    : '';

  return `  <Ad id="${escapeXml(opts.adId)}"${seqAttr}>
    <InLine>
      <AdSystem version="1.0">${escapeXml(systemName)}</AdSystem>
      <AdTitle><![CDATA[${opts.title}]]></AdTitle>
      <Error><![CDATA[${buildBeaconUrl(opts.baseUrl, {
        sessionId: opts.sessionId,
        event: 'error',
        adId: opts.adId,
        podId: opts.podId,
        extra: 'errorCode=[ERRORCODE]',
      })}]]></Error>
      <Impression id="imp-${escapeXml(opts.adId)}"><![CDATA[${buildBeaconUrl(opts.baseUrl, {
        sessionId: opts.sessionId,
        event: 'impression',
        adId: opts.adId,
        podId: opts.podId,
      })}]]></Impression>
      <Creatives>
        <Creative id="cr-${escapeXml(opts.adId)}" adId="${escapeXml(opts.adId)}">
          <Linear${skipAttr}>
            <Duration>${formatDuration(opts.durationSec)}</Duration>
            <TrackingEvents>
${trackingLines}
            </TrackingEvents>
            <VideoClicks>
              <ClickThrough><![CDATA[https://developer.roku.com/]]></ClickThrough>
              <ClickTracking><![CDATA[${buildBeaconUrl(opts.baseUrl, {
                sessionId: opts.sessionId,
                event: 'clickTracking',
                adId: opts.adId,
                podId: opts.podId,
              })}]]></ClickTracking>
            </VideoClicks>
            <MediaFiles>
              <MediaFile id="mf-${escapeXml(opts.adId)}" delivery="progressive" type="${mime}" bitrate="1200" width="1280" height="720" codec="avc1.4d401f"${apiAttr} scalable="true"><![CDATA[${opts.mediaUrl}]]></MediaFile>
            </MediaFiles>
          </Linear>
        </Creative>${companionBlock}
      </Creatives>
    </InLine>
  </Ad>`;
}

export function generateMockVastXml(scenario: MockScenarioType, ctx: MockBuildContext): string {
  const version = ctx.vastVersion ?? '4.0';
  const durationSec = ctx.durationSec ?? 8;
  const baseUrl = ctx.baseUrl.replace(/\/$/, '');
  const sessionId = ctx.sessionId || 'default';

  if (scenario === 'gam-vmap-pod' || scenario === 'vmap-schedule') {
    return generateMockVmapXml(ctx);
  }

  if (scenario === 'error-no-fill') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<VAST version="${version}">
  <Error><![CDATA[${buildBeaconUrl(baseUrl, {
    sessionId,
    event: 'error',
    adId: 'no-fill',
    podId: 'preroll',
    extra: 'errorCode=[ERRORCODE]',
  })}]]></Error>
</VAST>`;
  }

  if (scenario === 'error-media-404') {
    const adXml = buildLinearAdXml({
      baseUrl,
      sessionId,
      podId: 'error-pod',
      adId: 'broken-media-404',
      title: 'Broken MediaFile 404 Error Test',
      durationSec,
      mediaUrl: `${baseUrl}/media/does-not-exist-404.mp4`,
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<VAST version="${version}">\n${adXml}\n</VAST>`;
  }

  if (scenario === 'error-vpaid-only') {
    const adXml = buildLinearAdXml({
      baseUrl,
      sessionId,
      podId: 'vpaid-pod',
      adId: 'unsupported-js-vpaid',
      title: 'Unsupported JS VPAID Creative Test (RAF Error 403)',
      durationSec,
      mediaUrl: `${baseUrl}/media/mock-vpaid.js`,
      mimeType: 'application/javascript',
      apiFramework: 'VPAID',
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<VAST version="${version}">\n${adXml}\n</VAST>`;
  }

  if (scenario === 'wrapper-chain') {
    const maxHops = Math.max(1, Math.min(8, ctx.wrapperDepth ?? 2));
    const currentHop = ctx.currentHop ?? 1;
    if (currentHop <= maxHops) {
      const nextUrl =
        currentHop < maxHops
          ? `${baseUrl}/mock/vast/wrapper-chain.xml?session=${encodeURIComponent(sessionId)}&depth=${maxHops}&hop=${currentHop + 1}`
          : `${baseUrl}/mock/vast/single-preroll.xml?session=${encodeURIComponent(sessionId)}`;
      const wrapperAdId = `wrapper-hop-${currentHop}`;
      return `<?xml version="1.0" encoding="UTF-8"?>
<VAST version="${version}">
  <Ad id="${wrapperAdId}">
    <Wrapper>
      <AdSystem>RokuRAFWrapperHop-${currentHop}</AdSystem>
      <VASTAdTagURI><![CDATA[${nextUrl}]]></VASTAdTagURI>
      <Error><![CDATA[${buildBeaconUrl(baseUrl, {
        sessionId,
        event: 'error',
        adId: wrapperAdId,
        podId: 'wrapper-pod',
        extra: `hop=${currentHop}&errorCode=[ERRORCODE]`,
      })}]]></Error>
      <Impression id="imp-${wrapperAdId}"><![CDATA[${buildBeaconUrl(baseUrl, {
        sessionId,
        event: 'impression',
        adId: wrapperAdId,
        podId: 'wrapper-pod',
        extra: `hop=${currentHop}`,
      })}]]></Impression>
      <Creatives>
        <Creative id="cr-${wrapperAdId}">
          <Linear>
            <TrackingEvents>
              <Tracking event="start"><![CDATA[${buildBeaconUrl(baseUrl, {
                sessionId,
                event: 'start',
                adId: wrapperAdId,
                podId: 'wrapper-pod',
                extra: `hop=${currentHop}`,
              })}]]></Tracking>
              <Tracking event="complete"><![CDATA[${buildBeaconUrl(baseUrl, {
                sessionId,
                event: 'complete',
                adId: wrapperAdId,
                podId: 'wrapper-pod',
                extra: `hop=${currentHop}`,
              })}]]></Tracking>
            </TrackingEvents>
          </Linear>
        </Creative>
      </Creatives>
    </Wrapper>
  </Ad>
</VAST>`;
    }
  }

  if (scenario === 'pod-3-ads' || scenario === 'springserve-pod') {
    const isSpring = scenario === 'springserve-pod';
    const count = Math.max(2, Math.min(6, ctx.podSize ?? 3));
    const clips = ['ad-spot-1.mp4', 'ad-spot-2.mp4', 'ad-spot-3.mp4'];
    const adsXml: string[] = [];
    for (let i = 1; i <= count; i++) {
      const clip = clips[(i - 1) % clips.length];
      adsXml.push(
        buildLinearAdXml({
          baseUrl,
          sessionId,
          podId: isSpring ? 'springserve-pod' : 'pod-main',
          adId: `${isSpring ? 'ss' : 'pod'}-spot-${i}`,
          adSystem: isSpring ? 'SpringServe' : 'RokuRAFAdToolMockServer',
          title: `${isSpring ? 'SpringServe CTV' : 'RAF Pod'} Spot ${i} of ${count}`,
          sequence: i,
          durationSec: clip === 'ad-spot-3.mp4' ? 6 : durationSec,
          mediaUrl: `${baseUrl}/media/${clip}`,
          skippableAfterSec: i === 2 ? ctx.skippableAfterSec ?? 5 : undefined,
          includeCompanion: ctx.includeCompanion && i === 1,
        })
      );
    }
    adsXml.push(
      buildLinearAdXml({
        baseUrl,
        sessionId,
        podId: isSpring ? 'springserve-pod' : 'pod-main',
        adId: 'pod-buffet-fallback',
        adSystem: isSpring ? 'SpringServe' : 'RokuRAFAdToolMockServer',
        title: 'RAF Pod Buffet Fallback Creative',
        durationSec: 6,
        mediaUrl: `${baseUrl}/media/ad-spot-3.mp4`,
      })
    );
    return `<?xml version="1.0" encoding="UTF-8"?>\n<VAST version="${isSpring ? '4.0' : '3.0'}">\n${adsXml.join('\n')}\n</VAST>`;
  }

  if (scenario === 'skippable-preroll') {
    const adXml = buildLinearAdXml({
      baseUrl,
      sessionId,
      podId: 'skippable-pod',
      adId: 'skippable-spot-1',
      title: '12s Skippable Creative (skipoffset=00:00:05)',
      durationSec: 12,
      mediaUrl: `${baseUrl}/media/ad-spot-skip.mp4`,
      skippableAfterSec: 5,
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<VAST version="4.0">\n${adXml}\n</VAST>`;
  }

  if (scenario === 'interactive-overlay') {
    const adId = 'interactive-omid-spot-1';
    const podId = 'interactive-pod';
    return `<?xml version="1.0" encoding="UTF-8"?>
<VAST version="4.1">
  <Ad id="${adId}" sequence="1">
    <InLine>
      <AdSystem version="1.0">RokuRAFInteractiveServer</AdSystem>
      <AdTitle><![CDATA[Interactive Overlay + OMID Verification Creative]]></AdTitle>
      <Error><![CDATA[${buildBeaconUrl(baseUrl, { sessionId, event: 'error', adId, podId, extra: 'errorCode=[ERRORCODE]' })}]]></Error>
      <Impression id="imp-${adId}"><![CDATA[${buildBeaconUrl(baseUrl, { sessionId, event: 'impression', adId, podId })}]]></Impression>
      <AdVerifications>
        <Verification vendor="iabtechlab.com-omid">
          <JavaScriptResource apiFramework="omid" browserOptional="true"><![CDATA[${baseUrl}/media/omid-validation.js]]></JavaScriptResource>
        </Verification>
      </AdVerifications>
      <Extensions>
        <Extension type="BrightLine">
          <AdFormat>InteractiveOverlay</AdFormat>
        </Extension>
      </Extensions>
      <Creatives>
        <Creative id="cr-${adId}" adId="${adId}">
          <Linear>
            <Duration>00:00:08</Duration>
            <TrackingEvents>
              <Tracking event="start"><![CDATA[${buildBeaconUrl(baseUrl, { sessionId, event: 'start', adId, podId })}]]></Tracking>
              <Tracking event="firstQuartile"><![CDATA[${buildBeaconUrl(baseUrl, { sessionId, event: 'firstQuartile', adId, podId })}]]></Tracking>
              <Tracking event="midpoint"><![CDATA[${buildBeaconUrl(baseUrl, { sessionId, event: 'midpoint', adId, podId })}]]></Tracking>
              <Tracking event="thirdQuartile"><![CDATA[${buildBeaconUrl(baseUrl, { sessionId, event: 'thirdQuartile', adId, podId })}]]></Tracking>
              <Tracking event="complete"><![CDATA[${buildBeaconUrl(baseUrl, { sessionId, event: 'complete', adId, podId })}]]></Tracking>
            </TrackingEvents>
            <MediaFiles>
              <MediaFile id="mf-${adId}" delivery="progressive" type="video/mp4" bitrate="1800" width="1280" height="720" codec="avc1.4d401f"><![CDATA[${baseUrl}/media/ad-spot-1.mp4]]></MediaFile>
              <InteractiveCreativeFile type="application/json" apiFramework="BrightLine"><![CDATA[${baseUrl}/media/interactive-overlay.json]]></InteractiveCreativeFile>
            </MediaFiles>
          </Linear>
        </Creative>
      </Creatives>
    </InLine>
  </Ad>
</VAST>`;
  }

  const isFreeWheel = scenario === 'freewheel-vast';
  const activePodId = ctx.podId || 'preroll';
  const adXml = buildLinearAdXml({
    baseUrl,
    sessionId,
    podId: activePodId,
    adId: isFreeWheel ? 'fw-preroll-1' : `${activePodId}-spot-1`,
    adSystem: isFreeWheel ? 'FreeWheel' : 'RokuRAFAdToolMockServer',
    title: isFreeWheel ? 'FreeWheel CTV VAST 4.0 Spot' : 'Roku RAF Linear Preroll Spot',
    durationSec,
    mediaUrl: `${baseUrl}/media/ad-spot-1.mp4`,
    skippableAfterSec: ctx.skippableAfterSec,
    includeCompanion: ctx.includeCompanion,
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<VAST version="${version}">\n${adXml}\n</VAST>`;
}

export function generateMockVmapXml(ctx: MockBuildContext): string {
  const baseUrl = ctx.baseUrl.replace(/\/$/, '');
  const sessionId = ctx.sessionId || 'default';

  const breaks = [
    {
      id: 'preroll',
      offset: 'start',
      tag: `${baseUrl}/mock/vast/single-preroll.xml?session=${encodeURIComponent(sessionId)}&pod=preroll`,
    },
    {
      id: 'midroll-1',
      offset: '00:00:10',
      tag: `${baseUrl}/mock/vast/pod-3-ads.xml?session=${encodeURIComponent(sessionId)}&pod=midroll-1`,
    },
    {
      id: 'postroll',
      offset: 'end',
      tag: `${baseUrl}/mock/vast/single-preroll.xml?session=${encodeURIComponent(sessionId)}&pod=postroll`,
    },
  ];

  const breakXml = breaks
    .map(
      (b) => `  <vmap:AdBreak timeOffset="${b.offset}" breakType="linear" breakId="${b.id}">
    <vmap:AdSource id="src-${b.id}" allowMultipleAds="true" followRedirects="true">
      <vmap:AdTagURI templateType="vast3"><![CDATA[${b.tag}]]></vmap:AdTagURI>
    </vmap:AdSource>
    <vmap:TrackingEvents>
      <vmap:Tracking event="breakStart"><![CDATA[${buildBeaconUrl(baseUrl, {
        sessionId,
        event: 'breakStart',
        adId: b.id,
        podId: b.id,
      })}]]></vmap:Tracking>
      <vmap:Tracking event="breakEnd"><![CDATA[${buildBeaconUrl(baseUrl, {
        sessionId,
        event: 'breakEnd',
        adId: b.id,
        podId: b.id,
      })}]]></vmap:Tracking>
      <vmap:Tracking event="error"><![CDATA[${buildBeaconUrl(baseUrl, {
        sessionId,
        event: 'error',
        adId: b.id,
        podId: b.id,
        extra: 'errorCode=[ERRORCODE]',
      })}]]></vmap:Tracking>
    </vmap:TrackingEvents>
  </vmap:AdBreak>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap" version="1.0">
${breakXml}
</vmap:VMAP>`;
}

export function generateSsaiMediaPlaylist(baseUrl: string): string {
  const root = baseUrl.replace(/\/$/, '');
  return `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-PROGRAM-DATE-TIME:2026-11-22T00:00:00.000Z
#EXTINF:5.000,
${root}/media/hls/content-seg1.ts
#EXTINF:5.000,
${root}/media/hls/content-seg2.ts
#EXT-X-DISCONTINUITY
#EXT-X-CUE-OUT:DURATION=10.0
#EXT-X-DATERANGE:ID="raf-ssai-pod-1",START-DATE="2026-11-22T00:00:10.000Z",DURATION=10.0,SCTE35-OUT=0xFC301100000000000000FFF000000500015F90
#EXTINF:5.000,
${root}/media/hls/ad-seg1.ts
#EXTINF:5.000,
${root}/media/hls/ad-seg2.ts
#EXT-X-CUE-IN
#EXT-X-DISCONTINUITY
#EXTINF:5.000,
${root}/media/hls/content-seg3.ts
#EXTINF:5.000,
${root}/media/hls/content-seg4.ts
#EXT-X-ENDLIST
`;
}

export function generateSsaiRafMetadata(baseUrl: string, sessionId: string) {
  const root = baseUrl.replace(/\/$/, '');
  const adId = 'ssai-stitched-ad-1';
  const podId = 'ssai-midroll-1';
  const mkTrack = (event: string, time: number) => ({
    event,
    url: buildBeaconUrl(root, { sessionId, event, adId, podId }),
    time,
    triggered: false,
  });

  return [
    {
      viewed: false,
      renderSequence: 'midroll',
      duration: 10,
      renderTime: 10,
      ads: [
        {
          adServer: root,
          adId,
          adTitle: 'SSAI Stitched Midroll Spot (10s)',
          duration: 10,
          streamFormat: 'hls',
          streams: [],
          companionAds: [],
          tracking: [
            mkTrack('Impression', 10.0),
            mkTrack('Start', 10.1),
            mkTrack('FirstQuartile', 12.5),
            mkTrack('Midpoint', 15.0),
            mkTrack('ThirdQuartile', 17.5),
            mkTrack('Complete', 19.9),
          ],
        },
      ],
    },
  ];
}

export function generateSsaiAbrMasterPlaylist(baseUrl: string, sessionId = 'default'): string {
  const root = baseUrl.replace(/\/$/, '');
  const q = `session=${encodeURIComponent(sessionId)}`;
  return `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=520000,AVERAGE-BANDWIDTH=480000,RESOLUTION=416x234,CODECS="avc1.4d4015,mp4a.40.2"
${root}/mock/ssai-abr/variant-234p.m3u8?${q}
#EXT-X-STREAM-INF:BANDWIDTH=1120000,AVERAGE-BANDWIDTH=1050000,RESOLUTION=768x432,CODECS="avc1.4d401e,mp4a.40.2"
${root}/mock/ssai-abr/variant-432p.m3u8?${q}
#EXT-X-STREAM-INF:BANDWIDTH=2400000,AVERAGE-BANDWIDTH=2250000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
${root}/mock/ssai-abr/variant-720p.m3u8?${q}
`;
}

export function generateSsaiAbrVariantPlaylist(baseUrl: string, rung: '234p' | '432p' | '720p'): string {
  const root = baseUrl.replace(/\/$/, '');
  return `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-PROGRAM-DATE-TIME:2026-11-24T00:00:00.000Z
#EXTINF:5.000,
${root}/media/hls/abr-${rung}-content-1.ts
#EXT-X-DISCONTINUITY
#EXT-X-CUE-OUT:DURATION=10.0
#EXT-X-DATERANGE:ID="raf-abr-pod-1",START-DATE="2026-11-24T00:00:05.000Z",DURATION=10.0,SCTE35-OUT=0xFC301100000000000000FFF000000500015F90
#EXTINF:5.000,
${root}/media/hls/abr-${rung}-ad-brand.ts
#EXTINF:5.000,
${root}/media/hls/abr-${rung}-ad-promo.ts
#EXT-X-CUE-IN
#EXT-X-DISCONTINUITY
#EXTINF:5.000,
${root}/media/hls/abr-${rung}-content-2.ts
#EXT-X-DISCONTINUITY
#EXT-X-CUE-OUT:DURATION=5.0
#EXT-X-DATERANGE:ID="raf-abr-pod-2",START-DATE="2026-11-24T00:00:20.000Z",DURATION=5.0,SCTE35-OUT=0xFC301100000000000000FFF00000050000AFC8
#EXTINF:5.000,
${root}/media/hls/abr-${rung}-ad-bumper.ts
#EXT-X-CUE-IN
#EXT-X-DISCONTINUITY
#EXTINF:5.000,
${root}/media/hls/abr-${rung}-content-3.ts
#EXT-X-ENDLIST
`;
}

export function generateSsaiAbrRafMetadata(baseUrl: string, sessionId: string) {
  const root = baseUrl.replace(/\/$/, '');
  const mkSpot = (podId: string, adId: string, adTitle: string, startSec: number, durSec: number) => {
    const mkTrack = (event: string, frac: number) => ({
      event,
      url: buildBeaconUrl(root, { sessionId, event, adId, podId }),
      time: Number((startSec + durSec * frac).toFixed(2)),
      triggered: false,
    });
    return {
      adServer: root,
      adId,
      adTitle,
      duration: durSec,
      streamFormat: 'hls',
      streams: [],
      companionAds: [],
      tracking: [
        mkTrack('Impression', 0),
        mkTrack('Start', 0.02),
        mkTrack('FirstQuartile', 0.25),
        mkTrack('Midpoint', 0.5),
        mkTrack('ThirdQuartile', 0.75),
        mkTrack('Complete', 0.98),
      ],
    };
  };

  return [
    {
      id: 'raf-abr-pod-1',
      viewed: false,
      renderSequence: 'midroll',
      renderTime: 5,
      duration: 10,
      ads: [
        mkSpot('raf-abr-pod-1', 'abr-brand-spot-1', 'ABR Stitched Brand Commercial (5s)', 5, 5),
        mkSpot('raf-abr-pod-1', 'abr-promo-spot-2', 'ABR Stitched Promo Spot (5s)', 10, 5),
      ],
    },
    {
      id: 'raf-abr-pod-2',
      viewed: false,
      renderSequence: 'midroll',
      renderTime: 20,
      duration: 5,
      ads: [mkSpot('raf-abr-pod-2', 'abr-bumper-spot-3', 'ABR Stitched Sponsor Bumper (5s)', 20, 5)],
    },
  ];
}

export function buildFromCustomConfig(cfg: CustomMockConfig, baseUrl: string): string {
  const ctx: MockBuildContext = {
    baseUrl,
    sessionId: cfg.sessionId || 'default',
    vastVersion: cfg.vastVersion,
    durationSec: cfg.durationSec,
    podSize: cfg.podSize,
    skippableAfterSec: cfg.skippableAfterSec,
    wrapperDepth: cfg.wrapperDepth,
    includeCompanion: cfg.includeCompanion,
  };
  if (cfg.scenario === 'vmap-schedule' || cfg.scenario === 'gam-vmap-pod') {
    return generateMockVmapXml(ctx);
  }
  return generateMockVastXml(cfg.scenario, ctx);
}
