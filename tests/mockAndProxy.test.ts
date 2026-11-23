import { describe, expect, it } from 'vitest';
import {
  generateMockVastXml,
  generateMockVmapXml,
  generateSsaiMediaPlaylist,
  generateSsaiRafMetadata,
} from '../src/shared/mockGenerator.js';
import { validateAdTag } from '../src/shared/rafValidator.js';
import { instrumentAdXmlForProxy } from '../src/server/tagProxy.js';

describe('Mock Ad Generator & Beacon Proxy Instrumentation', () => {
  const baseUrl = 'http://192.0.2.10:4321';

  it('generates RAF-valid 3-ad pod and VMAP schedule XML', () => {
    const podXml = generateMockVastXml('pod-3-ads', { baseUrl, sessionId: 's1' });
    const podReport = validateAdTag(podXml);
    expect(podReport.validForRaf).toBe(true);
    expect(podReport.parsed.ads).toHaveLength(4); // 3 sequenced + 1 buffet

    const vmapXml = generateMockVmapXml({ baseUrl, sessionId: 's1' });
    const vmapReport = validateAdTag(vmapXml);
    expect(vmapReport.validForRaf).toBe(true);
    expect(vmapReport.parsed.adBreaks).toHaveLength(3);
  });

  it('rewrites Impression, Error, Tracking & Wrapper URLs through local beacon collector while preserving [ERRORCODE]', () => {
    const raw = `<?xml version="1.0"?>
      <VAST version="4.0">
        <Ad id="a1">
          <Wrapper>
            <VASTAdTagURI><![CDATA[https://dsp.example.com/next.xml]]></VASTAdTagURI>
            <Error><![CDATA[https://dsp.example.com/err?e=[ERRORCODE]]]></Error>
            <Impression><![CDATA[https://dsp.example.com/imp]]></Impression>
            <Creatives>
              <Creative>
                <Linear>
                  <TrackingEvents>
                    <Tracking event="midpoint"><![CDATA[https://dsp.example.com/mid]]></Tracking>
                  </TrackingEvents>
                </Linear>
              </Creative>
            </Creatives>
          </Wrapper>
        </Ad>
      </VAST>`;

    const instrumented = instrumentAdXmlForProxy(raw, {
      baseUrl,
      sessionId: 'debug-run',
      forwardUpstream: false,
    });

    expect(instrumented).toContain('http://192.0.2.10:4321/proxy/tag?session=debug-run');
    expect(instrumented).toContain('http://192.0.2.10:4321/api/beacon/hit?session=debug-run&event=impression');
    expect(instrumented).toContain('event=midpoint');
    expect(instrumented).toContain('&errorCode=[ERRORCODE]');
  });

  it('generates SSAI HLS playlist with discontinuities and RAF stitchedAdsInit metadata', () => {
    const playlist = generateSsaiMediaPlaylist(baseUrl);
    expect(playlist).toContain('#EXT-X-DISCONTINUITY');
    expect(playlist).toContain('#EXT-X-DATERANGE:ID="raf-ssai-pod-1"');

    const meta = generateSsaiRafMetadata(baseUrl, 'ssai-test');
    expect(meta).toHaveLength(1);
    expect(meta[0].ads[0].tracking).toHaveLength(6);
  });
});
