import { randomUUID } from 'node:crypto';
import { runBeaconAndCertAudit } from '../shared/beaconAuditor.js';
import type {
  RafRuntimePrefs,
  SuiteCaseResult,
  SuiteCaseSpec,
  SuiteRunReport,
} from '../shared/types.js';
import type { BeaconStore } from './beaconStore.js';
import type { AppDatabase } from './db.js';
import type { LiveHlsEngine } from './liveHlsEngine.js';
import {
  captureRokuScreenshot,
  launchTagOnRoku,
  queryRokuPerformance8080,
  sendRokuKeypress,
  type RokuDebugConsoleBridge,
} from './rokuBridge.js';

const GAM_EXTERNAL_SAMPLE_VAST =
  'https://pubads.g.doubleclick.net/gampad/ads?iu=/21775744923/external/single_ad_samples&sz=640x480&cust_params=sample_ct%3Dlinear&ciu_szs=300x250%2C728x90&gdfp_req=1&output=vast&unviewed_position_start=1&env=vp&impl=s&correlator=ROKU_ADS_CACHE_BUSTER';

export interface ExtendedSuiteCaseSpec extends SuiteCaseSpec {
  interaction?:
    | 'lat-enforced'
    | 'back-at-2s'
    | 'pause-resume'
    | 'proxy-gam'
    | 'dash-content'
    | 'custom-skip'
    | 'chaos-recovery';
}

export const DEFAULT_SUITE_CASES: ExtendedSuiteCaseSpec[] = [
  {
    id: 'preroll-vast4',
    title: '1. Single Preroll VAST 4.0 (Standard showAds)',
    scenario: 'single-preroll',
    adMode: 'csai',
    adTagPath: '/mock/vast/single-preroll.xml',
    timeoutSec: 20,
  },
  {
    id: 'stitched-pod',
    title: '2. 3-Spot Pod + Skippable + Buffet (constructStitchedStream)',
    scenario: 'pod-3-ads',
    adMode: 'csai-stitched',
    adTagPath: '/mock/vast/pod-3-ads.xml',
    timeoutSec: 42,
  },
  {
    id: 'gam-vmap',
    title: '3. GAM VMAP Schedule (Preroll + Midroll @ 10s + Postroll)',
    scenario: 'gam-vmap-pod',
    adMode: 'csai',
    adTagPath: '/mock/vast/gam-vmap-pod.xml',
    timeoutSec: 98,
  },
  {
    id: 'springserve-pod',
    title: '4. SpringServe 3-Spot CTV Pod (showAds)',
    scenario: 'springserve-pod',
    adMode: 'csai',
    adTagPath: '/mock/vast/springserve-pod.xml',
    timeoutSec: 36,
  },
  {
    id: 'freewheel-vast',
    title: '5. FreeWheel VAST 4.0 Linear Preroll',
    scenario: 'freewheel-vast',
    adMode: 'csai',
    adTagPath: '/mock/vast/freewheel-vast.xml',
    timeoutSec: 20,
  },
  {
    id: 'wrapper-2hop',
    title: '6. 2-Hop VAST Wrapper Chain (Merged Beacons)',
    scenario: 'wrapper-chain',
    adMode: 'csai',
    adTagPath: '/mock/vast/wrapper-chain.xml?depth=2',
    timeoutSec: 22,
  },
  {
    id: 'ssai-vod',
    title: '7. SSAI VOD Stitched HLS + DATERANGE (stitchedAdsInit)',
    scenario: 'ssai-hls',
    adMode: 'ssai',
    adTagPath: '/mock/ssai/stream.m3u8',
    timeoutSec: 38,
  },
  {
    id: 'ssai-live',
    title: '8. SSAI Live Linear HLS + Cued SCTE-35 Ad Break',
    scenario: 'ssai-live',
    adMode: 'ssai-live',
    adTagPath: '/mock/live/master.m3u8',
    timeoutSec: 36,
  },
  {
    id: 'google-dai-vod',
    title: '9. Google DAI VOD Stream Session Bootstrap (POST)',
    scenario: 'google-dai-vod',
    adMode: 'google-dai',
    adTagPath: '/mock/dai/ondemand/hls/content/2548831/vid/pilot/streams',
    timeoutSec: 38,
  },
  {
    id: 'error-media-404',
    title: '10. Error Resilience: Broken MediaFile 404 (VAST 401/405)',
    scenario: 'error-media-404',
    adMode: 'csai',
    adTagPath: '/mock/vast/error-media-404.xml',
    timeoutSec: 16,
    expectError: true,
  },
  {
    id: 'error-vpaid-403',
    title: '11. Error Resilience: Unsupported JS VPAID Only (RAF 403)',
    scenario: 'error-vpaid-only',
    adMode: 'csai',
    adTagPath: '/mock/vast/error-vpaid-only.xml',
    timeoutSec: 15,
    expectError: true,
  },
  {
    id: 'lat-privacy-zeroed',
    title: '12. Privacy Certification: Limit Ad Tracking (LAT=1 + Zeroed RIDA)',
    scenario: 'single-preroll',
    adMode: 'csai',
    adTagPath: '/mock/vast/single-preroll.xml',
    timeoutSec: 20,
    interaction: 'lat-enforced',
  },
  {
    id: 'mid-ad-back-exit',
    title: '13. User Interaction: Mid-Ad Back Exit (Suppresses Trailing Quartiles)',
    scenario: 'single-preroll',
    adMode: 'csai',
    adTagPath: '/mock/vast/single-preroll.xml',
    timeoutSec: 16,
    interaction: 'back-at-2s',
  },
  {
    id: 'mid-ad-pause-resume',
    title: '14. User Interaction: Mid-Ad Pause & Resume Tracking Beacons',
    scenario: 'single-preroll',
    adMode: 'csai',
    adTagPath: '/mock/vast/single-preroll.xml',
    timeoutSec: 26,
    interaction: 'pause-resume',
  },
  {
    id: 'external-gam-proxy',
    title: '15. Live External GAM VAST via Local Proxy (forward=1)',
    scenario: 'single-preroll',
    adMode: 'csai',
    adTagPath: `/proxy/tag?forward=1&url=${encodeURIComponent(GAM_EXTERNAL_SAMPLE_VAST)}`,
    timeoutSec: 28,
    interaction: 'proxy-gam',
  },
  {
    id: 'google-dai-live',
    title: '16. Google DAI Live Linear Stream Session (POST + SCTE-35)',
    scenario: 'google-dai-live',
    adMode: 'google-dai',
    adTagPath: '/mock/dai/live/hls/asset/live-fast-01/streams',
    timeoutSec: 36,
  },
  {
    id: 'interactive-omid-dash',
    title: '17. Interactive BrightLine + OMID Ad + MPEG-DASH (.mpd) Content',
    scenario: 'interactive-overlay',
    adMode: 'csai',
    adTagPath: '/mock/vast/interactive-overlay.xml',
    timeoutSec: 24,
    interaction: 'dash-content',
  },
  {
    id: 'csai-skippable',
    title: '18. Custom SceneGraph Skippable Ad UI (5s Countdown + OK Skip)',
    scenario: 'skippable-preroll',
    adMode: 'csai-skippable',
    adTagPath: '/mock/vast/skippable-preroll.xml',
    timeoutSec: 24,
    interaction: 'custom-skip',
  },
  {
    id: 'chaos-http-503',
    title: '19. Chaos Resilience: Ad Server HTTP 503 Graceful Content Fallback',
    scenario: 'single-preroll',
    adMode: 'csai',
    adTagPath: '/mock/vast/single-preroll.xml?chaos=http-503',
    timeoutSec: 18,
    interaction: 'chaos-recovery',
  },
  {
    id: 'chaos-corrupt-xml',
    title: '20. Chaos Resilience: Malformed / Truncated VAST XML Recovery',
    scenario: 'single-preroll',
    adMode: 'csai',
    adTagPath: '/mock/vast/single-preroll.xml?chaos=corrupt-xml',
    timeoutSec: 18,
    interaction: 'chaos-recovery',
  },
];

export class AutomatedSuiteRunner {
  private activeRun: SuiteRunReport | null = null;
  private abortRequested = false;

  constructor(
    private readonly beaconStore: BeaconStore,
    private readonly db: AppDatabase,
    private readonly consoleBridge?: RokuDebugConsoleBridge,
    private readonly liveEngine?: LiveHlsEngine
  ) {}

  public getActiveRun(): SuiteRunReport | null {
    return this.activeRun;
  }

  public abort(): void {
    this.abortRequested = true;
    if (this.activeRun && this.activeRun.status === 'running') {
      this.activeRun.status = 'aborted';
      this.activeRun.finishedAt = new Date().toISOString();
      this.db.saveSuiteRun(this.activeRun);
      this.beaconStore.broadcast({ type: 'suite_update', run: this.activeRun });
    }
  }

  public async startSuite(opts: {
    name?: string;
    deviceIp: string;
    password?: string;
    captureScreenshots?: boolean;
    simulateWithoutDevice?: boolean;
    baseUrl: string;
    caseIds?: string[];
    rafPrefs?: Partial<RafRuntimePrefs>;
  }): Promise<SuiteRunReport> {
    if (this.activeRun && this.activeRun.status === 'running') {
      throw new Error('A certification suite is already running.');
    }

    const selectedCases =
      opts.caseIds && opts.caseIds.length > 0
        ? DEFAULT_SUITE_CASES.filter((c) => opts.caseIds!.includes(c.id))
        : DEFAULT_SUITE_CASES;

    const runId = `suite-${randomUUID().slice(0, 8)}`;
    const report: SuiteRunReport = {
      id: runId,
      name: opts.name || `Roku RAF Cert Suite (${new Date().toLocaleTimeString()})`,
      deviceIp: opts.simulateWithoutDevice ? 'simulated-roku' : opts.deviceIp,
      startedAt: new Date().toISOString(),
      status: 'running',
      overallScore: 0,
      passedCount: 0,
      totalCount: selectedCases.length,
      cases: [],
    };

    this.activeRun = report;
    this.abortRequested = false;
    this.db.saveSuiteRun(report);
    this.beaconStore.broadcast({ type: 'suite_update', run: report });

    void this.executeLoop(report, selectedCases, opts);
    return report;
  }

  private async executeLoop(
    report: SuiteRunReport,
    cases: ExtendedSuiteCaseSpec[],
    opts: {
      deviceIp: string;
      password?: string;
      captureScreenshots?: boolean;
      simulateWithoutDevice?: boolean;
      baseUrl: string;
      rafPrefs?: Partial<RafRuntimePrefs>;
    }
  ): Promise<void> {
    for (const spec of cases) {
      if (this.abortRequested) break;
      const caseSessionId = `${report.id}-${spec.id}`;
      const startedMs = Date.now();
      const sep = spec.adTagPath.includes('?') ? '&' : '?';
      const tagUrl = `${opts.baseUrl}${spec.adTagPath}${sep}session=${encodeURIComponent(caseSessionId)}`;

      try {
        if (opts.simulateWithoutDevice) {
          await this.runSimulatedCase(spec, caseSessionId, tagUrl, opts.baseUrl);
        } else {
          await this.runHardwareCase(spec, caseSessionId, tagUrl, opts);
        }

        let screenshotDataUrl: string | undefined;
        if (!opts.simulateWithoutDevice && opts.captureScreenshots && opts.password) {
          try {
            const shot = await captureRokuScreenshot({
              ip: opts.deviceIp,
              password: opts.password,
              sessionId: caseSessionId,
            });
            this.beaconStore.addScreenshot(shot);
            screenshotDataUrl = shot.dataUrl;
          } catch {
            // screenshot optional
          }
        }

        const caseRes = this.evaluateCase(spec, caseSessionId, startedMs, Boolean(opts.simulateWithoutDevice), screenshotDataUrl);
        report.cases.push(caseRes);
        this.recomputeTotals(report);
        this.db.saveSuiteRun(report);
        this.beaconStore.broadcast({ type: 'suite_update', run: report });
      } catch (err) {
        report.cases.push({
          caseId: spec.id,
          title: spec.title,
          sessionId: caseSessionId,
          passed: false,
          certScore: 0,
          durationMs: Date.now() - startedMs,
          beaconsFired: 0,
          summary: `Execution error: ${err instanceof Error ? err.message : String(err)}`,
        });
        this.recomputeTotals(report);
        this.db.saveSuiteRun(report);
        this.beaconStore.broadcast({ type: 'suite_update', run: report });
      }
    }

    if (report.status === 'running') {
      report.status = 'completed';
    }
    report.finishedAt = new Date().toISOString();
    this.recomputeTotals(report);
    this.db.saveSuiteRun(report);
    this.beaconStore.broadcast({ type: 'suite_update', run: report });
  }

  private async runSimulatedCase(
    spec: ExtendedSuiteCaseSpec,
    caseSessionId: string,
    tagUrl: string,
    baseUrl: string
  ): Promise<void> {
    if (spec.interaction !== 'proxy-gam') {
      await fetch(tagUrl, {
        method: spec.adMode === 'google-dai' ? 'POST' : 'GET',
        headers: { 'User-Agent': 'Roku/DVP-16.0 (SuiteSimulator)' },
      });
    }
    if (spec.adMode === 'ssai') {
      await fetch(`${baseUrl}/mock/ssai/raf-metadata.json?session=${encodeURIComponent(caseSessionId)}`);
    } else if (spec.adMode === 'ssai-live') {
      this.liveEngine?.cueAdBreak({ sessionId: caseSessionId, durationSec: 10, leadSegments: 4 });
      await fetch(`${baseUrl}/mock/live/raf-metadata.json?session=${encodeURIComponent(caseSessionId)}`);
    }

    const expected = this.beaconStore.getExpectedBeacons(caseSessionId);
    if (spec.expectError) {
      this.beaconStore.record({
        sessionId: caseSessionId,
        kind: 'error',
        eventName: 'error',
        adId: spec.id,
        podId: 'error-pod',
        errorCode: spec.scenario === 'error-media-404' ? '405' : '403',
        requestUrl: `${baseUrl}/api/beacon/hit?session=${caseSessionId}&event=error&errorCode=403`,
        userAgent: 'Roku/DVP-16.0 (SuiteSimulator)',
      });
      return;
    }

    if (spec.interaction === 'lat-enforced') {
      this.beaconStore.record({
        sessionId: caseSessionId,
        kind: 'tag_request',
        eventName: 'LAT_ENFORCED_TAG_REQUEST',
        requestUrl: `${tagUrl}&is_lat=1&rdid=00000000-0000-0000-0000-000000000000`,
        userAgent: 'Roku/DVP-16.0 (SuiteSimulator)',
      });
    }

    if (spec.interaction === 'back-at-2s') {
      for (const ev of ['impression', 'start', 'closeLinear']) {
        this.beaconStore.record({
          sessionId: caseSessionId,
          kind: ev === 'impression' ? 'impression' : ev === 'start' ? 'quartile' : 'tracking',
          eventName: ev,
          adId: 'preroll-spot-1',
          podId: 'preroll',
          requestUrl: `${baseUrl}/api/beacon/hit?session=${caseSessionId}&event=${ev}`,
          userAgent: 'Roku/DVP-16.0 (SuiteSimulator)',
        });
      }
      return;
    }

    if (spec.interaction === 'pause-resume') {
      for (const ev of ['impression', 'start', 'pause', 'resume', 'firstQuartile', 'midpoint', 'thirdQuartile', 'complete']) {
        this.beaconStore.record({
          sessionId: caseSessionId,
          kind: ev === 'impression' ? 'impression' : ['pause', 'resume'].includes(ev) ? 'tracking' : 'quartile',
          eventName: ev,
          adId: 'preroll-spot-1',
          podId: 'preroll',
          requestUrl: `${baseUrl}/api/beacon/hit?session=${caseSessionId}&event=${ev}`,
          userAgent: 'Roku/DVP-16.0 (SuiteSimulator)',
        });
      }
      return;
    }

    if (spec.interaction === 'custom-skip') {
      for (const ev of ['impression', 'start', 'firstQuartile', 'skip', 'closeLinear']) {
        this.beaconStore.record({
          sessionId: caseSessionId,
          kind: ev === 'impression' ? 'impression' : ['skip', 'closeLinear'].includes(ev) ? 'tracking' : 'quartile',
          eventName: ev,
          adId: 'skippable-spot-1',
          podId: 'skippable-pod',
          requestUrl: `${baseUrl}/api/beacon/hit?session=${caseSessionId}&event=${ev}`,
          userAgent: 'Roku/DVP-16.0 (SuiteSimulator)',
        });
      }
      return;
    }

    if (spec.interaction === 'chaos-recovery') {
      this.beaconStore.record({
        sessionId: caseSessionId,
        kind: 'raf_telemetry',
        eventName: 'CONTENT_PLAY',
        requestUrl: `${baseUrl}/api/roku/telemetry`,
        userAgent: 'Roku/DVP-16.0 (SuiteSimulator)',
        details: { detail: 'Graceful fallback to main content after chaos fault' },
      });
      return;
    }

    for (const exp of expected) {
      this.beaconStore.record({
        sessionId: caseSessionId,
        kind: exp.event.toLowerCase() === 'impression' ? 'impression' : 'quartile',
        eventName: exp.event,
        adId: exp.adId,
        podId: exp.podId,
        requestUrl: exp.url,
        originalUrl: exp.url,
        userAgent: 'Roku/DVP-16.0 (SuiteSimulator)',
        forwardedStatus: spec.interaction === 'proxy-gam' ? 200 : undefined,
      });
    }
  }

  private async runHardwareCase(
    spec: ExtendedSuiteCaseSpec,
    caseSessionId: string,
    tagUrl: string,
    opts: {
      deviceIp: string;
      baseUrl: string;
      rafPrefs?: Partial<RafRuntimePrefs>;
    }
  ): Promise<void> {
    if (this.consoleBridge) {
      await this.consoleBridge.connect(opts.deviceIp, caseSessionId).catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      this.beaconStore.clear(caseSessionId);
    }

    if ((spec.adMode === 'ssai-live' || spec.scenario === 'google-dai-live') && this.liveEngine) {
      this.liveEngine.cueAdBreak({ sessionId: caseSessionId, durationSec: 10, leadSegments: 4 });
    }

    const contentClip =
      spec.adMode === 'ssai' || spec.adMode === 'ssai-live'
        ? tagUrl
        : spec.adMode === 'csai-stitched'
          ? `${opts.baseUrl}/media/ad-spot-3.mp4`
          : spec.interaction === 'dash-content'
            ? `${opts.baseUrl}/mock/dash/stream.mpd`
            : `${opts.baseUrl}/media/content-main.mp4`;

    const ssaiMetaUrl =
      spec.adMode === 'ssai'
        ? `${opts.baseUrl}/mock/ssai/raf-metadata.json?session=${encodeURIComponent(caseSessionId)}`
        : spec.adMode === 'ssai-live'
          ? `${opts.baseUrl}/mock/live/raf-metadata.json?session=${encodeURIComponent(caseSessionId)}`
          : undefined;

    await launchTagOnRoku(
      {
        ip: opts.deviceIp,
        adTagUrl: tagUrl,
        contentUrl: contentClip,
        adMode: spec.adMode,
        ssaiMetaUrl,
        sessionId: caseSessionId,
        useInputIfRunning: false,
        rafPrefs: {
          ...(opts.rafPrefs ?? {}),
          ...(spec.interaction === 'lat-enforced' ? { simulateLat: true } : {}),
        },
      },
      opts.baseUrl
    );

    await this.waitForCaseFinish(spec, opts.deviceIp, caseSessionId, spec.timeoutSec * 1000);

    const perfSnap = await queryRokuPerformance8080(opts.deviceIp, 1800).catch(() => null);
    if (perfSnap && perfSnap.reachable) {
      this.beaconStore.setPerf8080(caseSessionId, perfSnap);
    }

    const curEvents = this.beaconStore.getEvents(caseSessionId);
    if (!curEvents.some((e) => e.eventName === 'SESSION_FINISHED')) {
      await sendRokuKeypress(opts.deviceIp, 'Back').catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  private evaluateCase(
    spec: ExtendedSuiteCaseSpec,
    caseSessionId: string,
    startedMs: number,
    isSimulated: boolean,
    screenshotDataUrl?: string
  ): SuiteCaseResult {
    const expected = this.beaconStore.getExpectedBeacons(caseSessionId);
    const events = this.beaconStore.getEvents(caseSessionId);
    const toleranceSec = spec.interaction === 'pause-resume' ? 6.0 : isSimulated ? 999 : 3.0;

    const audit = runBeaconAndCertAudit({
      sessionId: caseSessionId,
      expected,
      events,
      toleranceSec,
      simulateLat: spec.interaction === 'lat-enforced',
      rokuPerf8080: this.beaconStore.getPerf8080(caseSessionId),
    });

    const reachabilityFailed = audit.certChecks.some(
      (c) => c.id === 'ad-server-reachability' && c.status === 'fail'
    );
    const runtimeCrashed = audit.certChecks.some(
      (c) => c.id === 'brightscript-runtime-health' && c.status === 'fail'
    );

    if (reachabilityFailed || runtimeCrashed) {
      const failCheck = audit.certChecks.find((c) => c.status === 'fail');
      return {
        caseId: spec.id,
        title: spec.title,
        sessionId: caseSessionId,
        passed: false,
        certScore: audit.certScore,
        durationMs: Date.now() - startedMs,
        beaconsFired: 0,
        summary: failCheck?.detail ?? 'Certification check failed.',
        screenshotDataUrl,
      };
    }

    if (spec.interaction === 'lat-enforced') {
      const latTagHit = events.some(
        (e) =>
          e.kind === 'tag_request' &&
          e.requestUrl.includes('is_lat=1') &&
          e.requestUrl.includes('00000000-0000-0000-0000-000000000000')
      );
      const latCheckPassed =
        audit.certChecks.find((c) => c.id === 'rida-lat-compliance')?.status === 'pass';
      const passed = latTagHit && latCheckPassed && audit.matchedCount === audit.expectedCount;
      return {
        caseId: spec.id,
        title: spec.title,
        sessionId: caseSessionId,
        passed,
        certScore: passed ? 100 : 30,
        durationMs: Date.now() - startedMs,
        beaconsFired: events.filter((e) => ['impression', 'quartile'].includes(e.kind)).length,
        summary: passed
          ? `Verified is_lat=1 & zeroed RIDA (00000000-0000-0000-0000-000000000000) with ${audit.matchedCount}/${audit.expectedCount} beacons.`
          : `LAT compliance mismatch (latTagHit=${latTagHit}, latCheckPassed=${latCheckPassed}).`,
        screenshotDataUrl,
      };
    }

    if (spec.interaction === 'back-at-2s') {
      const impFired = events.some((e) => e.eventName.toLowerCase() === 'impression');
      const startFired = events.some((e) => e.eventName.toLowerCase() === 'start');
      const completeFired = events.some((e) => e.eventName.toLowerCase() === 'complete');
      const q3Fired = events.some((e) => e.eventName.toLowerCase() === 'thirdquartile');
      const passed = impFired && startFired && !q3Fired && !completeFired;
      return {
        caseId: spec.id,
        title: spec.title,
        sessionId: caseSessionId,
        passed,
        certScore: passed ? 100 : 30,
        durationMs: Date.now() - startedMs,
        beaconsFired: events.filter((e) => ['impression', 'quartile', 'tracking'].includes(e.kind)).length,
        summary: passed
          ? 'Verified mid-ad Back exit aborted playback cleanly and suppressed 75%/100% beacons.'
          : `Mid-ad exit check failed (imp=${impFired}, start=${startFired}, q3=${q3Fired}, complete=${completeFired}).`,
        screenshotDataUrl,
      };
    }

    if (spec.interaction === 'pause-resume') {
      const pauseFired = events.some((e) => e.eventName.toLowerCase() === 'pause');
      const resumeFired = events.some((e) => e.eventName.toLowerCase() === 'resume');
      const completeFired = events.some((e) => e.eventName.toLowerCase() === 'complete');
      const passed = pauseFired && resumeFired && completeFired && audit.matchedCount === audit.expectedCount;
      return {
        caseId: spec.id,
        title: spec.title,
        sessionId: caseSessionId,
        passed,
        certScore: passed ? 100 : 50,
        durationMs: Date.now() - startedMs,
        beaconsFired: events.filter((e) => ['impression', 'quartile', 'tracking'].includes(e.kind)).length,
        summary: passed
          ? `Verified <Tracking event="pause">, <Tracking event="resume">, and ${audit.matchedCount}/${audit.expectedCount} quartiles.`
          : `Pause/Resume check incomplete (pause=${pauseFired}, resume=${resumeFired}, complete=${completeFired}).`,
        screenshotDataUrl,
      };
    }

    if (spec.interaction === 'custom-skip') {
      const skipFired = events.some((e) => e.eventName.toLowerCase() === 'skip');
      const impFired = events.some((e) => e.eventName.toLowerCase() === 'impression');
      const startFired = events.some((e) => e.eventName.toLowerCase() === 'start');
      const completeFired = events.some((e) => e.eventName.toLowerCase() === 'complete');
      const passed = skipFired && impFired && startFired && !completeFired && audit.certScore >= 90;
      return {
        caseId: spec.id,
        title: spec.title,
        sessionId: caseSessionId,
        passed,
        certScore: passed ? 100 : 40,
        durationMs: Date.now() - startedMs,
        beaconsFired: events.filter((e) => ['impression', 'quartile', 'tracking'].includes(e.kind)).length,
        summary: passed
          ? 'Verified 5s SceneGraph countdown -> OK Skip fired <Tracking event="skip"> and suppressed post-skip quartiles.'
          : `Custom skip check incomplete (skip=${skipFired}, imp=${impFired}, start=${startFired}, complete=${completeFired}).`,
        screenshotDataUrl,
      };
    }

    if (spec.interaction === 'chaos-recovery') {
      const chaosHit = events.some((e) => e.eventName.startsWith('CHAOS_INJECTED'));
      const contentPlayed = events.some(
        (e) =>
          e.eventName === 'CONTENT_PLAY' ||
          /\|VODStartComplete/i.test(String(e.details?.line ?? ''))
      );
      const passed = (chaosHit || isSimulated) && contentPlayed && !runtimeCrashed;
      return {
        caseId: spec.id,
        title: spec.title,
        sessionId: caseSessionId,
        passed,
        certScore: passed ? 100 : 25,
        durationMs: Date.now() - startedMs,
        beaconsFired: 0,
        summary: passed
          ? 'Verified graceful fallback to main content video with zero black-screen hang or BrightScript crash.'
          : `Chaos recovery failed (chaosHit=${chaosHit}, contentPlayed=${contentPlayed}).`,
        screenshotDataUrl,
      };
    }

    if (spec.interaction === 'proxy-gam') {
      const forwardedHits = events.filter((e) => e.forwardedStatus !== undefined && e.forwardedStatus > 0);
      const passed = audit.matchedCount >= 6 && forwardedHits.length >= 6;
      return {
        caseId: spec.id,
        title: spec.title,
        sessionId: caseSessionId,
        passed,
        certScore: passed ? 100 : audit.certScore,
        durationMs: Date.now() - startedMs,
        beaconsFired: forwardedHits.length,
        summary: passed
          ? `Intercepted & forwarded ${forwardedHits.length} live GAM beacons upstream (HTTP ${forwardedHits[0]?.forwardedStatus}).`
          : `Proxy GAM check: matched=${audit.matchedCount}/${audit.expectedCount}, forwarded=${forwardedHits.length}.`,
        screenshotDataUrl,
      };
    }

    if (spec.expectError) {
      const errorFired = events.some((e) => e.kind === 'error');
      return {
        caseId: spec.id,
        title: spec.title,
        sessionId: caseSessionId,
        passed: errorFired,
        certScore: errorFired ? 100 : 20,
        durationMs: Date.now() - startedMs,
        beaconsFired: events.filter((e) => ['impression', 'quartile', 'error', 'tracking'].includes(e.kind)).length,
        summary: errorFired
          ? `Verified VAST Error beacon (${events.find((e) => e.kind === 'error')?.errorCode ?? 'fired'}) & graceful recovery.`
          : 'Expected VAST Error beacon did not fire.',
        screenshotDataUrl,
      };
    }

    const beaconsHits = events.filter((e) => ['impression', 'quartile'].includes(e.kind)).length;
    const passed = audit.certScore >= 80 && beaconsHits > 0 && (expected.length === 0 || audit.matchedCount > 0);
    const certScore = beaconsHits > 0 ? audit.certScore : Math.min(audit.certScore, 40);

    let extraNote = '';
    if (spec.interaction === 'dash-content') {
      const dashPlayed = events.some((e) => e.eventName === 'CONTENT_PLAY' || /VODStart/i.test(String(e.details?.line ?? '')));
      if (dashPlayed) extraNote = ' + MPEG-DASH (.mpd) content stream verified';
    }

    return {
      caseId: spec.id,
      title: spec.title,
      sessionId: caseSessionId,
      passed,
      certScore,
      durationMs: Date.now() - startedMs,
      beaconsFired: events.filter((e) => ['impression', 'quartile', 'error', 'vmap', 'tracking'].includes(e.kind)).length,
      summary:
        beaconsHits === 0
          ? 'Zero ad impression/quartile beacons fired.'
          : `Matched ${audit.matchedCount}/${audit.expectedCount} expected beacons (Cert Score ${certScore})${extraNote}.`,
      screenshotDataUrl,
    };
  }

  private recomputeTotals(report: SuiteRunReport): void {
    report.passedCount = report.cases.filter((c) => c.passed).length;
    report.overallScore =
      report.cases.length > 0
        ? Math.round(report.cases.reduce((acc, c) => acc + c.certScore, 0) / report.cases.length)
        : 0;
  }

  private async waitForCaseFinish(
    spec: ExtendedSuiteCaseSpec,
    deviceIp: string,
    sessionId: string,
    timeoutMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const isFullSchedule = spec.scenario === 'gam-vmap-pod' || spec.scenario === 'vmap-schedule';
    const isLiveStream = spec.adMode === 'ssai-live' || spec.scenario === 'google-dai-live';

    let interactionTriggered = false;
    let adStartedAtMs = 0;

    while (Date.now() < deadline && !this.abortRequested) {
      const evs = this.beaconStore.getEvents(sessionId);

      if (
        evs.some(
          (e) =>
            e.kind === 'console_log' &&
            /\[RAF\.err\]\s*getStringFromUrl.*Request timed out/i.test(String(e.details?.line ?? ''))
        )
      ) {
        await new Promise((r) => setTimeout(r, 400));
        return;
      }

      const startEv = evs.find((e) => e.eventName.toLowerCase() === 'start');
      if (startEv && adStartedAtMs === 0) {
        adStartedAtMs = startEv.epochMs;
      }

      // Drive automated remote interactions at precise playhead offsets!
      if (!interactionTriggered && adStartedAtMs > 0) {
        const elapsedAdMs = Date.now() - adStartedAtMs;
        if (spec.interaction === 'back-at-2s' && elapsedAdMs >= 2200) {
          interactionTriggered = true;
          await sendRokuKeypress(deviceIp, 'Back').catch(() => {});
          await new Promise((r) => setTimeout(r, 1200));
          return;
        } else if (spec.interaction === 'pause-resume' && elapsedAdMs >= 1800) {
          interactionTriggered = true;
          await sendRokuKeypress(deviceIp, 'Play').catch(() => {}); // Pause
          await new Promise((r) => setTimeout(r, 1700));
          await sendRokuKeypress(deviceIp, 'Play').catch(() => {}); // Resume
        } else if (
          spec.interaction === 'custom-skip' &&
          (evs.some((e) => e.eventName === 'SKIP_UNLOCKED') || elapsedAdMs >= 5600)
        ) {
          interactionTriggered = true;
          await new Promise((r) => setTimeout(r, 250));
          await sendRokuKeypress(deviceIp, 'Select').catch(() => {});
        }
      }

      if (isLiveStream) {
        if (evs.some((e) => e.eventName.toLowerCase() === 'complete')) {
          await new Promise((r) => setTimeout(r, 800));
          return;
        }
      } else if (isFullSchedule || spec.adMode === 'csai-stitched' || spec.adMode === 'ssai' || spec.scenario === 'google-dai-vod') {
        if (evs.some((e) => /SESSION_FINISHED|CSAI_STITCH_END|SSAI_END|CONTENT_ERROR/i.test(e.eventName))) {
          await new Promise((r) => setTimeout(r, 800));
          return;
        }
      } else {
        if (
          spec.interaction === 'chaos-recovery' &&
          evs.some(
            (e) =>
              e.eventName === 'CONTENT_PLAY' ||
              /\|VODStartComplete/i.test(String(e.details?.line ?? ''))
          )
        ) {
          await new Promise((r) => setTimeout(r, 1200));
          return;
        }
        const prerollEnded = evs.some((e) => /SESSION_FINISHED|PREROLL_END/i.test(e.eventName));
        if (prerollEnded) {
          // For DASH content check, let DASH content play 2.5s after PREROLL_END so Roku demuxes .mpd + .m4s segments!
          await new Promise((r) => setTimeout(r, spec.interaction === 'dash-content' ? 2500 : 800));
          return;
        }
        const emptyErrorDone =
          spec.expectError &&
          evs.some((e) => e.kind === 'error') &&
          evs.some((e) => e.eventName === 'PODS_PARSED' || e.eventName === 'CONTENT_PLAY');
        if (emptyErrorDone) {
          await new Promise((r) => setTimeout(r, 800));
          return;
        }
      }

      await new Promise((r) => setTimeout(r, 400));
    }
  }
}
