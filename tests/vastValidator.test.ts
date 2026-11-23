import { describe, expect, it } from 'vitest';
import { expandRafMacros } from '../src/shared/rafMacros.js';
import { mergeWrapperIntoInline, parseAdXml } from '../src/shared/vastParser.js';
import { validateAdTag } from '../src/shared/rafValidator.js';

describe('Roku RAF Macro Expansion & VAST/VMAP Validation', () => {
  it('expands ROKU_ADS_* and [CACHEBUSTING] macros cleanly', () => {
    const raw =
      'https://ads.example.com/vast?did=ROKU_ADS_TRACKING_ID&lat=ROKU_ADS_LIMIT_TRACKING&cb=[CACHEBUSTING]';
    const expanded = expandRafMacros(raw, {
      ROKU_ADS_TRACKING_ID: 'roku-uuid-123',
      ROKU_ADS_LIMIT_TRACKING: '1',
      ROKU_ADS_CACHE_BUSTER: '777888',
    });
    expect(expanded).toContain('did=roku-uuid-123');
    expect(expanded).toContain('lat=1');
    expect(expanded).toContain('cb=777888');
  });

  it('validates a compliant Roku RAF VAST 4.0 Linear tag with high score', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <VAST version="4.0">
        <Ad id="spot-1" sequence="1">
          <InLine>
            <AdSystem>TestServer</AdSystem>
            <AdTitle>Valid Roku Ad</AdTitle>
            <Error><![CDATA[https://ads.example.com/err?c=[ERRORCODE]]]></Error>
            <Impression><![CDATA[https://ads.example.com/imp]]></Impression>
            <Creatives>
              <Creative id="c1">
                <Linear skipoffset="00:00:05">
                  <Duration>00:00:15</Duration>
                  <TrackingEvents>
                    <Tracking event="start">https://ads.example.com/start</Tracking>
                    <Tracking event="firstQuartile">https://ads.example.com/q1</Tracking>
                    <Tracking event="midpoint">https://ads.example.com/mid</Tracking>
                    <Tracking event="thirdQuartile">https://ads.example.com/q3</Tracking>
                    <Tracking event="complete">https://ads.example.com/done</Tracking>
                  </TrackingEvents>
                  <MediaFiles>
                    <MediaFile delivery="progressive" type="video/mp4" bitrate="1500" width="1280" height="720">
                      https://cdn.example.com/ad.mp4
                    </MediaFile>
                  </MediaFiles>
                </Linear>
              </Creative>
            </Creatives>
          </InLine>
        </Ad>
      </VAST>`;

    const report = validateAdTag(xml);
    expect(report.validForRaf).toBe(true);
    expect(report.score).toBe(100);
    expect(report.parsed.ads[0].linears[0].durationSeconds).toBe(15);
  });

  it('flags JS VPAID-only creatives as incompatible with Roku RAF', () => {
    const vpaidXml = `<?xml version="1.0"?>
      <VAST version="3.0">
        <Ad id="vpaid-1">
          <InLine>
            <Impression>https://ads.example.com/imp</Impression>
            <Creatives>
              <Creative>
                <Linear>
                  <Duration>00:00:15</Duration>
                  <MediaFiles>
                    <MediaFile delivery="progressive" type="application/javascript" apiFramework="VPAID">
                      https://cdn.example.com/vpaid.js
                    </MediaFile>
                  </MediaFiles>
                </Linear>
              </Creative>
            </Creatives>
          </InLine>
        </Ad>
      </VAST>`;

    const report = validateAdTag(vpaidXml);
    expect(report.validForRaf).toBe(false);
    expect(report.issues.some((i) => i.code === 'NO_RAF_COMPATIBLE_MEDIA')).toBe(true);
  });

  it('parses VMAP 1.0 schedules and merges Wrapper impressions/tracking into InLine ads', () => {
    const vmapXml = `<?xml version="1.0" encoding="UTF-8"?>
      <vmap:VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap" version="1.0">
        <vmap:AdBreak timeOffset="start" breakType="linear" breakId="preroll">
          <vmap:AdSource id="s1">
            <vmap:AdTagURI templateType="vast3"><![CDATA[https://ads.example.com/preroll.xml]]></vmap:AdTagURI>
          </vmap:AdSource>
        </vmap:AdBreak>
      </vmap:VMAP>`;

    const vmapReport = validateAdTag(vmapXml);
    expect(vmapReport.validForRaf).toBe(true);
    expect(vmapReport.parsed.tagType).toBe('VMAP');
    expect(vmapReport.parsed.adBreaks).toHaveLength(1);

    const wrapperRes = parseAdXml(`<VAST version="3.0"><Ad id="w1"><Wrapper>
      <VASTAdTagURI>https://ads.example.com/inline.xml</VASTAdTagURI>
      <Impression>https://ads.example.com/wrap-imp</Impression>
      <Creatives><Creative><Linear><TrackingEvents>
        <Tracking event="start">https://ads.example.com/wrap-start</Tracking>
      </TrackingEvents></Linear></Creative></Creatives>
    </Wrapper></Ad></VAST>`);

    const inlineRes = parseAdXml(`<VAST version="3.0"><Ad id="i1"><InLine>
      <Impression>https://ads.example.com/inline-imp</Impression>
      <Creatives><Creative><Linear><Duration>00:00:10</Duration><TrackingEvents>
        <Tracking event="complete">https://ads.example.com/inline-complete</Tracking>
      </TrackingEvents><MediaFiles>
        <MediaFile type="video/mp4" width="1280" height="720" bitrate="1200">https://cdn.example.com/a.mp4</MediaFile>
      </MediaFiles></Linear></Creative></Creatives>
    </InLine></Ad></VAST>`);

    const merged = mergeWrapperIntoInline(wrapperRes.parsed.ads, inlineRes.parsed);
    expect(merged.ads[0].impressions).toEqual([
      'https://ads.example.com/wrap-imp',
      'https://ads.example.com/inline-imp',
    ]);
    expect(merged.ads[0].linears[0].trackingEvents.map((t) => t.event)).toEqual(['start', 'complete']);
  });

  it('parses FreeWheel SmartXML (<adResponse>) schedules natively like Roku RAF', () => {
    const smrxXml = `<adResponse networkId="83583" version="1">
      <ads>
        <ad adId="1">
          <creatives>
            <creative creativeId="12" duration="30.0">
              <creativeRenditions>
                <creativeRendition width="640" height="360">
                  <asset bytes="1014433" mimeType="video/mp4" url="http://devtools.web.roku.com/samples/test_ad_1.mp4" />
                </creativeRendition>
              </creativeRenditions>
            </creative>
          </creatives>
        </ad>
      </ads>
      <siteSection customId="sample_channel">
        <videoPlayer><videoAsset customId="150926"><adSlots>
          <temporalAdSlot customId="pre1" timePosition="0" timePositionClass="preroll">
            <selectedAds><adReference adId="1" creativeId="12" /></selectedAds>
          </temporalAdSlot>
        </adSlots></videoAsset></videoPlayer>
      </siteSection>
    </adResponse>`;

    const report = validateAdTag(smrxXml);
    expect(report.validForRaf).toBe(true);
    expect(report.parsed.tagType).toBe('SMRX');
    expect(report.parsed.ads).toHaveLength(1);
    expect(report.parsed.adBreaks).toHaveLength(1);
  });
});
