import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  extractExpectedBeaconsFromParsedTag,
  runBeaconAndCertAudit,
} from '../src/shared/beaconAuditor.js';
import { generateBrightScriptSnippet } from '../src/shared/brsCodeGenerator.js';
import { importHarArchive } from '../src/shared/harImporter.js';
import { inspectStreamManifest } from '../src/shared/manifestInspector.js';
import { generateSsaiMediaPlaylist } from '../src/shared/mockGenerator.js';
import { scanRokuChannelRepo } from '../src/shared/repoScanner.js';
import { DEFAULT_RAF_RUNTIME_PREFS } from '../src/shared/types.js';
import { parseAdXml } from '../src/shared/vastParser.js';
import {
  auditVendorAdRequestUrl,
  buildVendorRequestTemplate,
} from '../src/shared/vendorTemplates.js';

describe('v2 Manifest Inspector, Vendor Auditor, BRS Codegen, Beacon Diff & HAR Import', () => {
  it('inspects HLS playlists with #EXT-X-DATERANGE and SCTE-35 cues and MPEG-DASH manifests', () => {
    const hls = generateSsaiMediaPlaylist('http://192.0.2.10:4321');
    const hlsReport = inspectStreamManifest(hls);
    expect(hlsReport.format).toBe('HLS');
    expect(hlsReport.isLive).toBe(false);
    expect(hlsReport.adCues.some((c) => c.type === 'DATERANGE')).toBe(true);
    expect(hlsReport.adCues.some((c) => c.type === 'DISCONTINUITY')).toBe(true);

    const mpd = `<?xml version="1.0"?>
      <MPD type="static" mediaPresentationDuration="PT30S">
        <Period id="p1" start="PT0S" duration="PT15S">
          <AdaptationSet mimeType="video/mp4" codecs="avc1.4d401f">
            <Representation id="1" width="1920" height="1080" bandwidth="3000000" />
          </AdaptationSet>
        </Period>
        <Period id="ad-pod" start="PT15S" duration="PT15S">
          <EventStream schemeIdUri="urn:scte:scte35:2013:xml" timescale="1">
            <Event id="cue-1" presentationTime="0" duration="15" />
          </EventStream>
        </Period>
      </MPD>`;
    const dashReport = inspectStreamManifest(mpd);
    expect(dashReport.format).toBe('DASH');
    expect(dashReport.adCues.some((c) => c.type === 'DASH_EVENT')).toBe(true);
  });

  it('builds & audits GAM, SpringServe, Publica & FreeWheel URLs and flags LAT+RIDA leaks', () => {
    const gam = buildVendorRequestTemplate({
      vendor: 'gam',
      networkOrSupplyId: '21775744923',
      adUnitOrProfile: '/21775744923/roku_video',
      podMaxDurationSec: 90,
      usPrivacy: '1YNN',
      coppa: false,
      useRokuMacros: true,
    });
    const gamAudit = auditVendorAdRequestUrl(gam.requestUrl);
    expect(gamAudit.detectedVendor).toBe('gam');
    expect(gamAudit.score).toBe(100);

    // Non-zero UUID passed while is_lat=1 should trigger privacy warning
    const leakyUrl =
      'https://pubads.g.doubleclick.net/gampad/ads?iu=/123/ctv&rdid=8a9e4c12-51f0-4f88-9b30-77d1c0ffee42&idtype=rida&is_lat=1&correlator=999&us_privacy=1YNN';
    const leakAudit = auditVendorAdRequestUrl(leakyUrl);
    expect(leakAudit.findings.some((f) => f.status === 'warning' && f.param.includes('is_lat=1'))).toBe(true);
  });

  it('generates valid SceneGraph BrightScript code for constructStitchedStream and Google DAI', () => {
    const stitchedBrs = generateBrightScriptSnippet({
      mode: 'csai-stitched',
      adTagOrStreamUrl: 'https://ads.example.com/pod.xml',
      prefs: { ...DEFAULT_RAF_RUNTIME_PREFS, maxResolution: '4k' },
    });
    expect(stitchedBrs).toContain('videoNode.maxVideoDecodeResolution = [3840, 2160]');
    expect(stitchedBrs).toContain('raf.constructStitchedStream');

    const daiBrs = generateBrightScriptSnippet({
      mode: 'google-dai',
      adTagOrStreamUrl: 'https://dai.google.com/ondemand/hls/content/123/vid/abc/streams',
      prefs: DEFAULT_RAF_RUNTIME_PREFS,
    });
    expect(daiBrs).toContain('raf.stitchedAdsInit');
    expect(daiBrs).toContain('idtype=rida');
  });

  it('audits expected-vs-actual beacons, timing drift, and imports .har traffic captures', () => {
    const vastXml = `<?xml version="1.0"?>
      <VAST version="4.0">
        <Ad id="har-spot-1">
          <InLine>
            <Impression>https://trk.example.com/imp</Impression>
            <Error>https://trk.example.com/err?code=[ERRORCODE]</Error>
            <Creatives>
              <Creative>
                <Linear>
                  <Duration>00:00:10</Duration>
                  <TrackingEvents>
                    <Tracking event="start">https://trk.example.com/start</Tracking>
                    <Tracking event="firstQuartile">https://trk.example.com/q1</Tracking>
                    <Tracking event="midpoint">https://trk.example.com/mid</Tracking>
                    <Tracking event="thirdQuartile">https://trk.example.com/q3</Tracking>
                    <Tracking event="complete">https://trk.example.com/complete</Tracking>
                  </TrackingEvents>
                  <MediaFiles>
                    <MediaFile type="video/mp4" width="1280" height="720" bitrate="1200">https://cdn.example.com/ad.mp4</MediaFile>
                  </MediaFiles>
                </Linear>
              </Creative>
            </Creatives>
          </InLine>
        </Ad>
      </VAST>`;

    const { parsed } = parseAdXml(vastXml);
    const expected = extractExpectedBeaconsFromParsedTag(parsed, 's-audit');
    expect(expected).toHaveLength(6);

    // Import synthetic HAR containing VAST response + Impression + Start + drifted Q1 (at +6s instead of +2.5s)
    const harPayload = JSON.stringify({
      log: {
        entries: [
          {
            startedDateTime: '2026-11-22T10:00:00.000Z',
            request: {
              method: 'GET',
              url: 'https://ads.example.com/vast.xml',
              headers: [{ name: 'User-Agent', value: 'Roku/DVP-12.5' }],
            },
            response: { status: 200, content: { text: vastXml } },
          },
          {
            startedDateTime: '2026-11-22T10:00:01.000Z',
            request: {
              method: 'GET',
              url: 'https://trk.example.com/imp',
              headers: [{ name: 'User-Agent', value: 'Roku/DVP-12.5' }],
            },
            response: { status: 200, content: {} },
          },
          {
            startedDateTime: '2026-11-22T10:00:01.050Z',
            request: {
              method: 'GET',
              url: 'https://trk.example.com/start',
              headers: [{ name: 'User-Agent', value: 'Roku/DVP-12.5' }],
            },
            response: { status: 200, content: {} },
          },
          {
            startedDateTime: '2026-11-22T10:00:07.500Z',
            request: {
              method: 'GET',
              url: 'https://trk.example.com/q1',
              headers: [{ name: 'User-Agent', value: 'Roku/DVP-12.5' }],
            },
            response: { status: 200, content: {} },
          },
        ],
      },
    });

    const snap = importHarArchive(harPayload, 'Unit Test HAR');
    expect(snap.source).toBe('har_import');
    expect(snap.auditReport.matchedCount).toBe(2); // imp + start
    expect(snap.auditReport.driftedCount).toBe(1); // q1 drifted
    expect(snap.auditReport.missingCount).toBe(3); // mid, q3, complete

    // Verify LAT leak fail check in runBeaconAndCertAudit
    const leakAudit = runBeaconAndCertAudit({
      sessionId: 'lat-test',
      expected: [],
      events: [
        {
          id: '1',
          sessionId: 'lat-test',
          timestamp: new Date().toISOString(),
          epochMs: 1000,
          relativeMs: 0,
          kind: 'tag_request',
          eventName: 'TAG',
          requestUrl: 'https://ads.example.com/vast?rdid=8a9e4c12-51f0-4f88-9b30-77d1c0ffee42&is_lat=1',
          method: 'GET',
        },
      ],
    });
    expect(leakAudit.certChecks.find((c) => c.id === 'rida-lat-compliance')?.status).toBe('fail');
  });

  it('statically scans BrightScript/SceneGraph channels for RAF compliance and catches common Roku OS 16 crashes', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const cleanScan = scanRokuChannelRepo(join(repoRoot, 'roku-channel'));
    expect(cleanScan.rafReady).toBe(true);
    expect(cleanScan.score).toBe(100);
    expect(cleanScan.summary.errors).toBe(0);

    // Create a broken synthetic SceneGraph channel with Render-thread RAF, missing manifest lib, and RIDA leak
    const badDir = mkdtempSync(join(tmpdir(), 'bad-roku-ch-'));
    try {
      writeFileSync(join(badDir, 'manifest'), 'title=Broken Channel\nmajor_version=1\n');
      mkdirSync(join(badDir, 'components'));
      writeFileSync(
        join(badDir, 'components', 'BadScene.xml'),
        '<component name="BadScene" extends="Scene"><script type="text/brightscript" uri="pkg:/components/BadScene.brs" /></component>'
      );
      writeFileSync(
        join(badDir, 'components', 'BadScene.brs'),
        [
          'sub init()',
          '  raf = Roku_Ads()',
          '  raf.setMaxVideoDecodeResolution(1920, 1080)',
          '  di = CreateObject("roDeviceInfo")',
          '  id = di.GetRIDA()',
          '  raf.showAds(pods)',
          'end sub',
        ].join('\n')
      );

      const badScan = scanRokuChannelRepo(badDir);
      expect(badScan.rafReady).toBe(false);
      const codes = badScan.findings.map((f) => f.code);
      expect(codes).toContain('MANIFEST_MISSING_RAF_LIB');
      expect(codes).toContain('BRS_MISSING_RAF_LIBRARY_IMPORT');
      expect(codes).toContain('SG_RAF_ON_RENDER_THREAD');
      expect(codes).toContain('RAF_INVALID_MAX_RES_METHOD');
      expect(codes).toContain('RIDA_WITHOUT_LAT_CHECK');
      expect(codes).toContain('SHOW_ADS_MISSING_VIEW_NODE');
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });
});
