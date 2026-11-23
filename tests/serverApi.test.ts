import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createAppServer } from '../src/server/index.js';

describe('Roku RAF Ad Tool v2 HTTP Server Integration', () => {
  const { server, db } = createAppServer({ port: 0, dbPath: ':memory:' });
  let baseUrl = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  it('unrolls multi-hop wrapper chains via /api/validate', async () => {
    const wrapperUrl = `${baseUrl}/mock/vast/wrapper-chain.xml?session=test-wrap&depth=2`;
    const resp = await fetch(`${baseUrl}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: wrapperUrl }),
    });
    expect(resp.status).toBe(200);
    const report = await resp.json();
    expect(report.validForRaf).toBe(true);
    expect(report.parsed.wrapperHops).toHaveLength(3);
    expect(report.parsed.ads[0].impressions.length).toBeGreaterThanOrEqual(3);
  });

  it('registers expected beacons on tag serve, captures hits, and computes Certification Audit + Markdown Snapshot', async () => {
    const tagResp = await fetch(`${baseUrl}/mock/vast/single-preroll.xml?session=cert-run`);
    expect(tagResp.status).toBe(200);

    for (const ev of ['impression', 'start', 'firstQuartile', 'midpoint', 'thirdQuartile', 'complete']) {
      await fetch(
        `${baseUrl}/api/beacon/hit?session=cert-run&event=${ev}&adId=preroll-spot-1&podId=preroll`,
        { headers: { 'User-Agent': 'Roku/DVP-12.5' } }
      );
    }

    // With ±5s tolerance on an 8s ad fired instantaneously, Q3 (6s) and Complete (8s) are flagged as drifted
    const strictAuditResp = await fetch(`${baseUrl}/api/audit?session=cert-run&toleranceSec=5`);
    const strictAudit = await strictAuditResp.json();
    expect(strictAudit.expectedCount).toBe(6);
    expect(strictAudit.matchedCount).toBe(4);
    expect(strictAudit.driftedCount).toBe(2);

    // With ±10s tolerance, all 6 beacons match with 100/100 score
    const auditResp = await fetch(`${baseUrl}/api/audit?session=cert-run&toleranceSec=10`);
    const audit = await auditResp.json();
    expect(audit.matchedCount).toBe(6);
    expect(audit.certScore).toBe(100);

    // Save snapshot & export Markdown report
    const snapResp = await fetch(`${baseUrl}/api/snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Cert Run Snapshot', sessionId: 'cert-run', toleranceSec: 10 }),
    });
    expect(snapResp.status).toBe(201);
    const snap = await snapResp.json();

    const mdResp = await fetch(`${baseUrl}/api/snapshots/${snap.id}/export.md`);
    expect(mdResp.status).toBe(200);
    const mdText = await mdResp.text();
    expect(mdText).toContain('Certification Score**: **100 / 100**');
  });

  it('cues Live Linear HLS SCTE-35 breaks and emulates Google DAI VOD & Live stream sessions', async () => {
    const cueResp = await fetch(`${baseUrl}/api/live/cue-break`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'live-fast', durationSec: 10 }),
    });
    expect(cueResp.status).toBe(201);

    const liveM3u8Resp = await fetch(`${baseUrl}/mock/live/playlist.m3u8?session=live-fast`);
    const liveM3u8 = await liveM3u8Resp.text();
    expect(liveM3u8).toContain('#EXTM3U');
    expect(liveM3u8).toContain('#EXT-X-DATERANGE:ID="live-cue-');
    expect(liveM3u8).toContain('#EXT-X-OATCLS-SCTE35:');

    const daiVodResp = await fetch(
      `${baseUrl}/mock/dai/ondemand/hls/content/2548831/vid/pilot/streams?session=dai-s1`,
      {
        method: 'POST',
        body: 'rdid=8a9e4c12-51f0-4f88-9b30-77d1c0ffee42&idtype=rida&is_lat=0',
      }
    );
    expect(daiVodResp.status).toBe(201);
    const daiData = await daiVodResp.json();
    expect(daiData.stream_id).toContain('dai-vod-');
    expect(daiData.stream_manifest).toContain('/mock/ssai/stream.m3u8');
    expect(daiData.ad_pods).toHaveLength(1);
  });

  it('executes Automated Suite Runner in simulated mode and packages sideloadable Roku channel zip', async () => {
    const suiteResp = await fetch(`${baseUrl}/api/suite/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'CI Simulated Suite',
        deviceIp: '127.0.0.1',
        simulateWithoutDevice: true,
        caseIds: ['preroll-vast4', 'error-vpaid-403'],
      }),
    });
    expect(suiteResp.status).toBe(201);

    // Wait briefly for simulated suite async loop to complete
    let completedRun = null;
    for (let i = 0; i < 20; i++) {
      const runsResp = await fetch(`${baseUrl}/api/suite/runs`);
      const data = await runsResp.json();
      const first = data.runs[0];
      if (first && first.status === 'completed') {
        completedRun = first;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(completedRun).not.toBeNull();
    expect(completedRun.passedCount).toBe(2);
    expect(completedRun.overallScore).toBe(100);

    const zipResp = await fetch(`${baseUrl}/api/channel/package.zip?serverUrl=${encodeURIComponent(baseUrl)}`);
    expect(zipResp.status).toBe(200);
    const buf = Buffer.from(await zipResp.arrayBuffer());
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });
});
