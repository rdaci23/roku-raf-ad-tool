import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Award,
  Camera,
  Copy,
  Play,
  RefreshCw,
  Save,
  Send,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { api } from '../api.js';
import type {
  AdQuartileProgress,
  BeaconAuditReport,
  BeaconEvent,
  RafPlaybackMode,
} from '../../shared/types.js';

interface Props {
  lanBaseUrl: string;
  sessionId: string;
  events: BeaconEvent[];
  progress: AdQuartileProgress[];
  onRefresh: () => void;
  onSendToRoku: (url: string, mode?: RafPlaybackMode) => void;
  onGoToSnapshots: () => void;
}

export function BeaconDebuggerTab({
  lanBaseUrl,
  sessionId,
  events,
  progress,
  onRefresh,
  onSendToRoku,
  onGoToSnapshots,
}: Props) {
  const [upstreamTagUrl, setUpstreamTagUrl] = useState<string>(
    `${lanBaseUrl}/mock/vast/single-preroll.xml?session=${sessionId}`
  );
  const [forwardUpstream, setForwardUpstream] = useState<boolean>(false);
  const [filterSessionOnly, setFilterSessionOnly] = useState<boolean>(true);
  const [toleranceSec, setToleranceSec] = useState<number>(1.5);
  const [simulateLat, setSimulateLat] = useState<boolean>(false);
  const [auditReport, setAuditReport] = useState<BeaconAuditReport | null>(null);
  const [snapshotSavedMsg, setSnapshotSavedMsg] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);

  const instrumentedProxyUrl = useMemo(() => {
    const q = new URLSearchParams({
      session: sessionId,
      forward: forwardUpstream ? '1' : '0',
      url: upstreamTagUrl.trim(),
    });
    return `${lanBaseUrl}/proxy/tag?${q.toString()}`;
  }, [lanBaseUrl, sessionId, forwardUpstream, upstreamTagUrl]);

  const refreshAudit = () => {
    api
      .getAudit(sessionId, toleranceSec, simulateLat)
      .then(setAuditReport)
      .catch(() => {});
  };

  useEffect(() => {
    refreshAudit();
  }, [sessionId, events.length, toleranceSec, simulateLat]);

  const visibleEvents = useMemo(() => {
    const filtered = filterSessionOnly ? events.filter((e) => e.sessionId === sessionId) : events;
    return [...filtered].reverse();
  }, [events, filterSessionOnly, sessionId]);

  const visibleProgress = useMemo(() => {
    return filterSessionOnly ? progress.filter((p) => p.sessionId === sessionId) : progress;
  }, [progress, filterSessionOnly, sessionId]);

  const handleSaveSnapshot = async () => {
    const snap = await api.saveSnapshot({
      sessionId,
      name: `Session ${sessionId} (${new Date().toLocaleTimeString()})`,
      adTagUrl: upstreamTagUrl,
    });
    setSnapshotSavedMsg(`Saved snapshot "${snap.name}" (Cert Score: ${snap.auditReport.certScore}/100)`);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Proxy Instrumentation Bar */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">
            <Activity size={16} /> Tag Instrumentation Proxy & Session Controls
          </h2>
          <div className="btn-row">
            <button className="btn btn-sm btn-primary" onClick={handleSaveSnapshot}>
              <Save size={12} /> Save Session Snapshot
            </button>
            {snapshotSavedMsg && (
              <button className="btn btn-sm" onClick={onGoToSnapshots}>
                <Camera size={12} /> View in Archive
              </button>
            )}
          </div>
        </div>

        {snapshotSavedMsg && (
          <div className="issue-item info" style={{ marginBottom: 10 }}>{snapshotSavedMsg}</div>
        )}

        <div className="grid-2">
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Upstream VAST / VMAP Tag URL to Instrument</label>
            <input
              type="text"
              value={upstreamTagUrl}
              onChange={(e) => setUpstreamTagUrl(e.target.value)}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Instrumented Proxy URL (rewrites Impression/Quartile/Error/Wrapper URLs)</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="text" readOnly value={instrumentedProxyUrl} className="mono" />
              <button
                className="btn"
                onClick={() => {
                  navigator.clipboard.writeText(instrumentedProxyUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1400);
                }}
              >
                <Copy size={13} /> {copied ? 'Copied' : 'Copy'}
              </button>
              <button className="btn btn-primary" onClick={() => onSendToRoku(instrumentedProxyUrl, 'csai')}>
                <Send size={13} /> Roku
              </button>
            </div>
          </div>
        </div>

        <div className="btn-row" style={{ marginTop: 10 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={forwardUpstream}
              onChange={(e) => setForwardUpstream(e.target.checked)}
            />
            Forward captured beacons upstream to real ad server
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, marginLeft: 14 }}>
            <input
              type="checkbox"
              checked={simulateLat}
              onChange={(e) => setSimulateLat(e.target.checked)}
            />
            Audit assuming Limit Ad Tracking (LAT=1) enabled on device
          </label>
        </div>
      </div>

      {/* Roku Certification & Expected-vs-Actual Diff Grid */}
      {auditReport && (
        <div className="grid-2">
          {/* Roku Ad Certification Checks */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">
                <Award size={16} /> Roku Ad Certification & Privacy Compliance ({auditReport.certScore}/100)
              </h3>
              <button className="btn btn-sm" onClick={refreshAudit}>
                <RefreshCw size={12} /> Re-Audit
              </button>
            </div>

            {(auditReport.timingMetrics || auditReport.rokuPerf8080?.reachable) && (
              <div className="btn-row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
                {auditReport.timingMetrics?.tagFetchLatencyMs !== undefined && (
                  <span className="pill mono">Tag Fetch: {auditReport.timingMetrics.tagFetchLatencyMs}ms</span>
                )}
                {auditReport.timingMetrics?.adTtffMs !== undefined && (
                  <span className="pill ok mono">Ad TTFF: {auditReport.timingMetrics.adTtffMs}ms</span>
                )}
                {auditReport.timingMetrics?.vodStartDurationMs !== undefined && (
                  <span className="pill mono">VOD Start: {auditReport.timingMetrics.vodStartDurationMs}ms</span>
                )}
                {auditReport.rokuPerf8080?.reachable && (
                  <>
                    <span className="pill mono">RAM: {auditReport.rokuPerf8080.channelMemMb ?? '?'} MB</span>
                    <span className="pill mono">
                      VRAM: {auditReport.rokuPerf8080.textureUsedMb ?? '?'} MB ({auditReport.rokuPerf8080.textureUtilizationPct ?? '?'}%)
                    </span>
                    <span className="pill mono">CPU: {auditReport.rokuPerf8080.cpuTotalPct ?? '?'}%</span>
                  </>
                )}
              </div>
            )}
            <div className="issue-list">
              {auditReport.certChecks.map((chk) => (
                <div
                  key={chk.id}
                  className={`issue-item ${
                    chk.status === 'fail' ? 'error' : chk.status === 'warn' ? 'warning' : 'info'
                  }`}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong>{chk.title}</strong>
                    <span
                      className={`pill ${
                        chk.status === 'pass' ? 'ok' : chk.status === 'warn' ? 'warn' : 'err'
                      }`}
                    >
                      {chk.status.toUpperCase()}
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>{chk.detail}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Expected-vs-Actual Beacon Diff */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">
                Expected-vs-Actual Beacon Diff ({auditReport.matchedCount}/{auditReport.expectedCount} matched)
              </h3>
              <div className="btn-row">
                <span className="muted" style={{ fontSize: 12 }}>Drift ±s:</span>
                <input
                  type="number"
                  step={0.5}
                  min={0.5}
                  max={10}
                  value={toleranceSec}
                  onChange={(e) => setToleranceSec(Number(e.target.value))}
                  style={{ width: 68, padding: '3px 6px' }}
                />
              </div>
            </div>

            {auditReport.diffItems.length === 0 ? (
              <div className="muted" style={{ fontSize: 12.5 }}>
                No expected beacons registered for session <span className="mono">{sessionId}</span> yet. Fetch/play a mock or proxied tag, or click Simulate below.
              </div>
            ) : (
              <div className="table-wrap" style={{ maxHeight: 330, overflowY: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Ad ID</th>
                      <th>Event</th>
                      <th>Origin</th>
                      <th>Exp / Act</th>
                      <th>Drift</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditReport.diffItems.map((item) => (
                      <tr key={item.spec.id}>
                        <td>
                          <span
                            className={`pill ${
                              item.status === 'matched'
                                ? 'ok'
                                : item.status === 'missing'
                                  ? 'err'
                                  : 'warn'
                            }`}
                          >
                            {item.status}
                          </span>
                        </td>
                        <td className="mono">{item.spec.adId}</td>
                        <td className="mono" style={{ fontWeight: 700 }}>{item.spec.event}</td>
                        <td>{item.spec.source}</td>
                        <td className="mono">
                          {item.spec.expectedOffsetSec !== undefined ? `+${item.spec.expectedOffsetSec}s` : '—'} /{' '}
                          {item.actualOffsetSec !== undefined ? `+${item.actualOffsetSec}s` : '—'}
                        </td>
                        <td className="mono">
                          {item.driftSec !== undefined ? `${item.driftSec > 0 ? '+' : ''}${item.driftSec}s` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Quartile Matrix */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Live Pod Quartile Checklist ({visibleProgress.length} Ad(s))</h3>
          <div className="btn-row">
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={filterSessionOnly}
                onChange={(e) => setFilterSessionOnly(e.target.checked)}
              />
              Session &ldquo;{sessionId}&rdquo; only
            </label>
            <button
              className="btn btn-sm"
              onClick={() =>
                api.simulateBeacons({ sessionId, adId: 'preroll-spot-1', podId: 'preroll' }).then(onRefresh)
              }
            >
              <Play size={12} /> Simulate Full Ad Beacons
            </button>
            <button
              className="btn btn-sm"
              onClick={() =>
                api
                  .simulateBeacons({ sessionId, adId: 'sim-broken-ad', podId: 'preroll', includeError: true })
                  .then(onRefresh)
              }
            >
              <ShieldAlert size={12} /> Simulate RAF Error 403
            </button>
            <button
              className="btn btn-sm"
              onClick={() => api.clearBeacons(filterSessionOnly ? sessionId : undefined)}
            >
              <Trash2 size={12} /> Clear
            </button>
          </div>
        </div>

        {visibleProgress.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>No ad beacons captured yet for this view.</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Pod</th>
                  <th>Ad ID</th>
                  <th>Checkpoints</th>
                </tr>
              </thead>
              <tbody>
                {visibleProgress.map((p) => (
                  <tr key={p.key}>
                    <td className="mono">{p.sessionId}</td>
                    <td className="mono">{p.podId}</td>
                    <td className="mono">{p.adId}</td>
                    <td>
                      <div className="quartile-grid">
                        <span className={`q-step ${p.impression ? 'hit' : ''}`}>Impression</span>
                        <span className={`q-step ${p.start ? 'hit' : ''}`}>Start</span>
                        <span className={`q-step ${p.firstQuartile ? 'hit' : ''}`}>Q1 (25%)</span>
                        <span className={`q-step ${p.midpoint ? 'hit' : ''}`}>Mid (50%)</span>
                        <span className={`q-step ${p.thirdQuartile ? 'hit' : ''}`}>Q3 (75%)</span>
                        <span className={`q-step ${p.complete ? 'hit' : ''}`}>Complete</span>
                        {p.skip && <span className="q-step hit">Skip</span>}
                        {p.error && (
                          <span className="q-step hit-err">
                            ERROR {p.lastErrorCode ? `(${p.lastErrorCode})` : ''}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Raw Event Timeline */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Live HTTP Beacon, RAF Telemetry & :8085 Timeline ({visibleEvents.length})</h3>
        </div>
        <div className="table-wrap" style={{ maxHeight: 400, overflowY: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>+Offset</th>
                <th>Kind</th>
                <th>Event</th>
                <th>Ad / Pod</th>
                <th>Details / URL / User-Agent</th>
              </tr>
            </thead>
            <tbody>
              {visibleEvents.map((ev) => (
                <tr key={ev.id}>
                  <td className="mono muted">+{(ev.relativeMs / 1000).toFixed(2)}s</td>
                  <td>
                    <span className={`pill ${ev.kind === 'error' ? 'err' : ev.kind === 'impression' || ev.kind === 'quartile' ? 'ok' : ''}`}>
                      {ev.kind}
                    </span>
                  </td>
                  <td className="mono" style={{ fontWeight: 700 }}>
                    {ev.eventName}
                    {ev.errorCode && (
                      <div style={{ color: '#fca5a5', fontSize: 11 }}>
                        Code {ev.errorCode}: {ev.errorDescription || 'VAST Error'}
                      </div>
                    )}
                  </td>
                  <td className="mono">
                    {ev.adId || '—'}
                    {ev.podId ? <div className="muted" style={{ fontSize: 11 }}>{ev.podId}</div> : null}
                  </td>
                  <td style={{ maxWidth: 540, wordBreak: 'break-all' }}>
                    <span className="mono muted" style={{ fontSize: 11.5 }}>
                      {ev.details ? JSON.stringify(ev.details) : ev.originalUrl || ev.requestUrl}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
