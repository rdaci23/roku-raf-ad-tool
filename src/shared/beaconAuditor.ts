import { randomUUID } from 'node:crypto';
import type {
  AdTimingMetrics,
  BeaconAuditReport,
  BeaconDiffItem,
  BeaconEvent,
  CertCheckResult,
  ExpectedBeaconSpec,
  ParsedAdTag,
  RokuPerfSnapshot,
} from './types.js';

const QUARTILE_FRACTIONS: Record<string, number> = {
  impression: 0,
  start: 0,
  firstquartile: 0.25,
  midpoint: 0.5,
  thirdquartile: 0.75,
  complete: 1.0,
};

const QUARTILE_ORDER = ['start', 'firstquartile', 'midpoint', 'thirdquartile', 'complete'];

export function extractExpectedBeaconsFromParsedTag(
  parsed: ParsedAdTag,
  sessionId: string,
  defaultPodId = 'preroll'
): ExpectedBeaconSpec[] {
  const specs: ExpectedBeaconSpec[] = [];

  for (const brk of parsed.adBreaks) {
    const podId = brk.id || defaultPodId;
    if (brk.inlineVast) {
      specs.push(...extractExpectedBeaconsFromParsedTag(brk.inlineVast, sessionId, podId));
    }
  }

  for (const ad of parsed.ads) {
    // Unsequenced buffet fallback ads are optional unless a sequenced ad fails; only enforce sequenced ads or single-ad tags
    const hasSequencedPeers = parsed.ads.some((a) => a.sequence !== undefined);
    if (hasSequencedPeers && ad.sequence === undefined) {
      continue;
    }

    const durSec = ad.linears[0]?.durationSeconds;
    for (const impUrl of ad.impressions) {
      const isWrapperHop = /hop=\d+/i.test(impUrl);
      specs.push({
        id: randomUUID(),
        sessionId,
        podId: defaultPodId,
        adId: ad.id,
        event: 'impression',
        url: impUrl,
        source: isWrapperHop ? 'wrapper' : 'inline',
        expectedOffsetSec: 0,
        creativeDurationSec: durSec,
      });
    }

    for (const lin of ad.linears) {
      for (const trk of lin.trackingEvents) {
        const lower = trk.event.toLowerCase();
        // Only require core impression + quartiles as mandatory expected beacons (mute/pause/skip are user-initiated!)
        if (!(lower in QUARTILE_FRACTIONS)) continue;
        const frac = QUARTILE_FRACTIONS[lower];
        specs.push({
          id: randomUUID(),
          sessionId,
          podId: defaultPodId,
          adId: ad.id,
          event: trk.event,
          url: trk.url,
          source: trk.sourceHop ? 'wrapper' : 'inline',
          wrapperHop: trk.sourceHop,
          expectedOffsetSec: durSec !== undefined ? Number((durSec * frac).toFixed(2)) : undefined,
          creativeDurationSec: durSec,
        });
      }
    }
  }

  return specs;
}

export function extractExpectedBeaconsFromSsaiPods(
  pods: Array<{
    id?: string;
    renderSequence?: string;
    duration?: number;
    ads?: Array<{
      adId?: string;
      duration?: number;
      tracking?: Array<{ event: string; url: string; time?: number }>;
    }>;
  }>,
  sessionId: string,
  source: 'ssai' | 'dai' = 'ssai'
): ExpectedBeaconSpec[] {
  const specs: ExpectedBeaconSpec[] = [];
  for (const [pIdx, pod] of pods.entries()) {
    const podId = pod.id || pod.renderSequence || `ssai-pod-${pIdx + 1}`;
    for (const ad of pod.ads ?? []) {
      const adId = ad.adId || `ssai-ad-${pIdx + 1}`;
      const dur = ad.duration ?? pod.duration;
      const baseStart = ad.tracking?.find((t) => t.event.toLowerCase() === 'impression')?.time ?? 0;
      for (const trk of ad.tracking ?? []) {
        const lower = trk.event.toLowerCase();
        if (!(lower in QUARTILE_FRACTIONS)) continue;
        specs.push({
          id: randomUUID(),
          sessionId,
          podId,
          adId,
          event: trk.event,
          url: trk.url,
          source,
          expectedOffsetSec:
            trk.time !== undefined ? Number(Math.max(0, trk.time - baseStart).toFixed(2)) : undefined,
          creativeDurationSec: dur,
        });
      }
    }
  }
  return specs;
}

export function runBeaconAndCertAudit(opts: {
  sessionId: string;
  expected: ExpectedBeaconSpec[];
  events: BeaconEvent[];
  toleranceSec?: number;
  simulateLat?: boolean;
  rokuPerf8080?: RokuPerfSnapshot;
}): BeaconAuditReport {
  const toleranceSec = opts.toleranceSec ?? 1.5;
  const sessionEvents = opts.events.filter((e) => e.sessionId === opts.sessionId);

  const beaconHits = sessionEvents.filter((e) =>
    ['impression', 'quartile', 'tracking', 'error', 'click', 'vmap'].includes(e.kind)
  );
  const tagRequests = sessionEvents.filter((e) => e.kind === 'tag_request');
  const telemetryEvents = sessionEvents.filter((e) => e.kind === 'raf_telemetry');

  // Compute start anchor epoch and early skip/close epoch per adId
  const adAnchorMs = new Map<string, number>();
  const adSkipOrCloseMs = new Map<string, number>();
  for (const hit of beaconHits) {
    const key = hit.adId || 'default';
    const lower = hit.eventName.toLowerCase();
    if ((lower === 'impression' || lower === 'start') && !adAnchorMs.has(key)) {
      adAnchorMs.set(key, hit.epochMs);
    }
    if ((lower === 'skip' || lower === 'closelinear') && !adSkipOrCloseMs.has(key)) {
      adSkipOrCloseMs.set(key, hit.epochMs);
    }
  }

  const matchedHitIds = new Set<string>();
  const diffItems: BeaconDiffItem[] = [];

  for (const spec of opts.expected) {
    const specLower = spec.event.toLowerCase();
    const candidates = beaconHits.filter((h) => {
      if (h.eventName.toLowerCase() !== specLower) return false;
      if (spec.url && h.originalUrl) {
        return h.originalUrl === spec.url && (!h.podId || h.podId === spec.podId);
      }
      if (spec.url && h.requestUrl === spec.url) return true;
      if (h.adId && (h.adId === spec.adId || h.adId === 'proxied-ad')) return true;
      return false;
    });

    for (const c of candidates) matchedHitIds.add(c.id);

    if (candidates.length === 0) {
      const startEpoch = adAnchorMs.get(spec.adId);
      const exitEpoch = adSkipOrCloseMs.get(spec.adId);
      if (
        startEpoch !== undefined &&
        exitEpoch !== undefined &&
        spec.expectedOffsetSec !== undefined &&
        spec.expectedOffsetSec > (exitEpoch - startEpoch) / 1000 - 0.25
      ) {
        diffItems.push({
          spec,
          status: 'matched',
          actualCount: 0,
          note: `Correctly suppressed after intentional user skip/exit at +${((exitEpoch - startEpoch) / 1000).toFixed(1)}s.`,
        });
        continue;
      }
      diffItems.push({
        spec,
        status: 'missing',
        actualCount: 0,
        note: `Expected ${spec.source} <${spec.event}> beacon did not fire.`,
      });
      continue;
    }

    const firstHit = candidates[0];
    const anchor = adAnchorMs.get(firstHit.adId || spec.adId) ?? firstHit.epochMs;
    const actualOffsetSec = Number(((firstHit.epochMs - anchor) / 1000).toFixed(2));
    const driftSec =
      spec.expectedOffsetSec !== undefined
        ? Number((actualOffsetSec - spec.expectedOffsetSec).toFixed(2))
        : undefined;

    if (candidates.length > 1 && opts.expected.filter((e) => e.adId === spec.adId && e.event.toLowerCase() === specLower).length === 1) {
      diffItems.push({
        spec,
        status: 'duplicate',
        actualCount: candidates.length,
        actualOffsetSec,
        driftSec,
        note: `Beacon fired ${candidates.length} times (expected once).`,
      });
    } else if (driftSec !== undefined && Math.abs(driftSec) > toleranceSec) {
      diffItems.push({
        spec,
        status: 'drifted',
        actualCount: candidates.length,
        actualOffsetSec,
        driftSec,
        note: `Fired at +${actualOffsetSec}s vs expected +${spec.expectedOffsetSec}s (drift ${driftSec > 0 ? '+' : ''}${driftSec}s > ±${toleranceSec}s).`,
      });
    } else {
      diffItems.push({
        spec,
        status: 'matched',
        actualCount: candidates.length,
        actualOffsetSec,
        driftSec,
      });
    }
  }

  // Check chronological ordering per adId
  let outOfOrderCount = 0;
  const byAd = new Map<string, BeaconEvent[]>();
  for (const hit of beaconHits) {
    const k = hit.adId || 'default';
    const arr = byAd.get(k) ?? [];
    arr.push(hit);
    byAd.set(k, arr);
  }
  for (const [adId, hits] of byAd.entries()) {
    let highestStage = -1;
    for (const h of hits) {
      const idx = QUARTILE_ORDER.indexOf(h.eventName.toLowerCase());
      if (idx !== -1) {
        if (idx < highestStage) {
          outOfOrderCount += 1;
          const targetItem = diffItems.find(
            (d) => d.spec.adId === adId && d.spec.event.toLowerCase() === h.eventName.toLowerCase()
          );
          if (targetItem) {
            targetItem.status = 'out_of_order';
            targetItem.note = `Quartile "${h.eventName}" arrived out of chronological sequence.`;
          }
        } else {
          highestStage = idx;
        }
      }
    }
  }

  const unexpectedEvents = beaconHits.filter((h) => !matchedHitIds.has(h.id));

  // --- Roku Advertising Certification Checks ---
  const certChecks: CertCheckResult[] = [];

  // 1. RIDA & Limit Ad Tracking Check
  const allRequestUrls = [...tagRequests.map((t) => t.originalUrl || t.requestUrl), ...beaconHits.map((b) => b.requestUrl)];
  const latLeak = allRequestUrls.some((u) => {
    const isLatActive = opts.simulateLat || /[?&](is_lat|dnt|lmt|_fw_is_lat)=1\b/i.test(u);
    if (!isLatActive) return false;
    const ridaMatch = u.match(/[?&](rdid|did|_fw_vcid2)=([0-9a-f-]{32,36})/i);
    return Boolean(ridaMatch && ridaMatch[2] !== '00000000-0000-0000-0000-000000000000');
  });
  certChecks.push({
    id: 'rida-lat-compliance',
    category: 'privacy',
    title: 'Roku RIDA & Limit Ad Tracking (LAT) Compliance',
    status: latLeak ? 'fail' : 'pass',
    detail: latLeak
      ? 'Non-zero RIDA UUID was transmitted while Limit Ad Tracking (LAT=1) was active.'
      : 'No personal RIDA leak detected under Limit Ad Tracking.',
  });

  // 2. Roku User-Agent Check
  const rokuUaPresent = beaconHits.length === 0 || beaconHits.some((b) => /Roku\/DVP/i.test(b.userAgent || ''));
  certChecks.push({
    id: 'roku-user-agent',
    category: 'headers',
    title: 'Roku DVP User-Agent Header',
    status: rokuUaPresent ? 'pass' : 'warn',
    detail: rokuUaPresent
      ? 'Requests include standard Roku/DVP User-Agent header.'
      : 'Beacon hits did not carry a Roku/DVP User-Agent (may originate from browser/non-Roku player).',
  });

  // 3. Impression <-> Start Parity
  let impStartMismatch = false;
  for (const [, hits] of byAd.entries()) {
    const hasImp = hits.some((h) => h.eventName.toLowerCase() === 'impression');
    const hasStart = hits.some((h) => h.eventName.toLowerCase() === 'start');
    const hasErr = hits.some((h) => h.kind === 'error');
    if (!hasErr && hasImp !== hasStart) {
      impStartMismatch = true;
    }
  }
  certChecks.push({
    id: 'impression-start-parity',
    category: 'lifecycle',
    title: 'Impression & Start Beacon Parity',
    status: beaconHits.length === 0 ? 'warn' : impStartMismatch ? 'fail' : 'pass',
    detail:
      beaconHits.length === 0
        ? 'No ad beacons recorded yet in this session.'
        : impStartMismatch
          ? 'At least one ad fired Impression without Start (or Start without Impression).'
          : 'Every rendered ad spot fired both Impression and Start.',
  });

  // 4. Early Exit Suppression Check
  const exitEvent = telemetryEvents.find((t) => /EXIT|CLOSE|ABORT/i.test(t.eventName));
  const completeAfterExit =
    exitEvent &&
    beaconHits.some((b) => b.eventName.toLowerCase() === 'complete' && b.epochMs > exitEvent.epochMs + 250);
  certChecks.push({
    id: 'early-exit-suppression',
    category: 'lifecycle',
    title: 'Back-Button Early Exit Quartile Suppression',
    status: completeAfterExit ? 'fail' : 'pass',
    detail: completeAfterExit
      ? 'A "complete" beacon fired AFTER the user exited the ad break.'
      : 'No post-exit false completion beacons detected.',
  });

  // 5. Error Macro [ERRORCODE] Substitution Check
  const errorBeacons = beaconHits.filter((b) => b.kind === 'error');
  const literalMacroLeft = errorBeacons.some(
    (b) => b.errorCode === '[ERRORCODE]' || /\[ERRORCODE\]/i.test(b.requestUrl)
  );
  certChecks.push({
    id: 'error-macro-expansion',
    category: 'error_handling',
    title: 'VAST [ERRORCODE] Runtime Macro Substitution',
    status: literalMacroLeft ? 'fail' : 'pass',
    detail: literalMacroLeft
      ? 'Error beacon fired with literal unexpanded "[ERRORCODE]" instead of numeric VAST error code.'
      : errorBeacons.length > 0
        ? `All ${errorBeacons.length} error beacon(s) resolved numeric VAST error codes cleanly.`
        : 'No unexpanded [ERRORCODE] macros observed.',
  });

  // 6. Quartile Timing Accuracy Check
  const driftedCount = diffItems.filter((d) => d.status === 'drifted').length;
  certChecks.push({
    id: 'quartile-timing-accuracy',
    category: 'timing',
    title: `Quartile Timing Drift Within ±${toleranceSec}s`,
    status: driftedCount > 0 ? 'warn' : 'pass',
    detail:
      driftedCount > 0
        ? `${driftedCount} quartile beacon(s) drifted beyond ±${toleranceSec}s of expected creative duration.`
        : 'All matched quartile beacons fired within timing tolerance.',
  });

  // 7. BrightScript Runtime & Debugger Health (:8085 Console)
  const consoleLines = sessionEvents
    .filter((e) => e.kind === 'console_log')
    .map((e) => String(e.details?.line ?? ''));
  const crashLine = consoleLines.find((l) =>
    /runtime error &h|compile error &h|Compilation Failed|BrightScript Micro Debugger/i.test(l)
  );
  certChecks.push({
    id: 'brightscript-runtime-health',
    category: 'lifecycle',
    title: 'Zero BrightScript Runtime Crashes (:8085)',
    status: crashLine ? 'fail' : 'pass',
    detail: crashLine
      ? `BrightScript runtime crash detected on port 8085: ${crashLine}`
      : 'No BrightScript runtime exceptions observed on port 8085.',
  });

  // 8. Ad Server Network / Firewall Reachability (:8085 RAF Transport Check)
  const timeoutLine = consoleLines.find((l) => /\[RAF\.err\]\s*getStringFromUrl.*Request timed out/i.test(l));
  if (timeoutLine) {
    certChecks.push({
      id: 'ad-server-reachability',
      category: 'error_handling',
      title: 'Ad Server / Local LAN Host Reachability',
      status: 'fail',
      detail: `${timeoutLine} — If targeting the local Mock/Proxy server, allow TCP port 4321 through your host firewall (e.g. sudo ufw allow from <roku-ip> to any port 4321 proto tcp).`,
    });
  }

  // Compute Ad Startup & TTFF Timing Metrics
  const timingMetrics: AdTimingMetrics = {};
  const fetchTagEv =
    telemetryEvents.find((t) => t.eventName === 'FETCH_TAG') ?? tagRequests[0];
  const podsParsedEv = telemetryEvents.find((t) => t.eventName === 'PODS_PARSED');
  if (fetchTagEv && podsParsedEv && podsParsedEv.epochMs >= fetchTagEv.epochMs) {
    timingMetrics.tagFetchLatencyMs = podsParsedEv.epochMs - fetchTagEv.epochMs;
  }

  const prerollStartEv =
    telemetryEvents.find((t) => /PREROLL_START|CSAI_STITCH_RENDER|SSAI_INIT/i.test(t.eventName)) ??
    fetchTagEv;
  const firstRenderHit = beaconHits.find((b) =>
    ['impression', 'start'].includes(b.eventName.toLowerCase())
  );
  if (prerollStartEv && firstRenderHit && firstRenderHit.epochMs >= prerollStartEv.epochMs) {
    timingMetrics.adTtffMs = firstRenderHit.epochMs - prerollStartEv.epochMs;
  }

  for (const line of consoleLines) {
    const vodMatch = line.match(/\|VODStartComplete\s*-+>\s*Duration\((\d+)\s*ms\)/i);
    if (vodMatch) {
      timingMetrics.vodStartDurationMs = Number.parseInt(vodMatch[1], 10);
      break;
    }
  }

  // 9. Optional :8080 Texture Memory / VRAM Headroom Check
  if (opts.rokuPerf8080?.reachable && opts.rokuPerf8080.textureUtilizationPct !== undefined) {
    const highVram = opts.rokuPerf8080.textureUtilizationPct > 85;
    certChecks.push({
      id: 'roku-vram-headroom',
      category: 'lifecycle',
      title: 'Roku SceneGraph Texture VRAM & RAM Headroom (:8080)',
      status: highVram ? 'warn' : 'pass',
      detail: `Channel RAM: ${opts.rokuPerf8080.channelMemMb ?? '?'} MB | Texture VRAM: ${opts.rokuPerf8080.textureUsedMb ?? '?'} MB (${opts.rokuPerf8080.textureUtilizationPct}%) | CPU: ${opts.rokuPerf8080.cpuTotalPct ?? '?'}%`,
    });
  }

  const matchedCount = diffItems.filter((d) => d.status === 'matched').length;
  const missingCount = diffItems.filter((d) => d.status === 'missing').length;
  const duplicateCount = diffItems.filter((d) => d.status === 'duplicate').length;

  const certFails = certChecks.filter((c) => c.status === 'fail').length;
  const certWarns = certChecks.filter((c) => c.status === 'warn').length;

  let certScore = 100 - certFails * 25 - certWarns * 6 - missingCount * 10 - duplicateCount * 8 - outOfOrderCount * 15 - driftedCount * 5;
  certScore = Math.max(0, Math.min(100, certScore));

  return {
    sessionId: opts.sessionId,
    certScore,
    toleranceSec,
    expectedCount: opts.expected.length,
    matchedCount,
    missingCount,
    duplicateCount,
    driftedCount,
    outOfOrderCount,
    unexpectedEvents,
    diffItems,
    certChecks,
    timingMetrics,
    rokuPerf8080: opts.rokuPerf8080,
  };
}
