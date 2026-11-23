import React, { useEffect, useState } from 'react';
import { Archive, Download, Eye, FileJson, FileText, Save, Trash2, Upload } from 'lucide-react';
import { api } from '../api.js';
import type { SessionSnapshot } from '../../shared/types.js';

interface Props {
  sessionId: string;
  activeTagUrl: string;
}

export function SessionsTab({ sessionId, activeTagUrl }: Props) {
  const [snapshots, setSnapshots] = useState<
    Array<{
      id: string;
      name: string;
      source: string;
      sessionId: string;
      createdAt: string;
      certScore: number;
      eventCount: number;
      screenshotCount: number;
    }>
  >([]);
  const [selectedSnap, setSelectedSnap] = useState<SessionSnapshot | null>(null);
  const [snapName, setSnapName] = useState<string>(`QA Run — ${sessionId}`);
  const [harName, setHarName] = useState<string>('Charles / mitmproxy Capture');
  const [statusMsg, setStatusMsg] = useState<string>('');

  const refreshList = () => {
    api.listSnapshots().then((d) => setSnapshots(d.snapshots)).catch(() => {});
  };

  useEffect(() => {
    refreshList();
  }, []);

  const handleSaveCurrentSession = async () => {
    const created = await api.saveSnapshot({
      name: snapName,
      sessionId,
      adTagUrl: activeTagUrl,
    });
    setStatusMsg(`Saved snapshot "${created.name}" (${created.events.length} events).`);
    setSelectedSnap(created);
    refreshList();
  };

  const handleHarFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = await api.importHar(text, harName || file.name);
      setStatusMsg(
        `Imported HAR "${imported.name}" -> Cert Score ${imported.auditReport.certScore}/100 (${imported.events.length} ad/beacon events).`
      );
      setSelectedSnap(imported);
      refreshList();
    } catch (err) {
      setStatusMsg(`HAR import error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleJsonBundleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as SessionSnapshot;
      const imported = await api.importSnapshotJson(parsed);
      setStatusMsg(`Imported JSON snapshot "${imported.name}".`);
      setSelectedSnap(imported);
      refreshList();
    } catch (err) {
      setStatusMsg(`JSON import error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="grid-sidebar">
      {/* Left Column: Save Snapshot + Import HAR / JSON + Archive List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">
              <Save size={16} /> Snapshot Active Session & Import Traffic
            </h2>
          </div>

          <div className="field">
            <label>Snapshot Active Session ({sessionId})</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="text" value={snapName} onChange={(e) => setSnapName(e.target.value)} />
              <button className="btn btn-primary" onClick={handleSaveCurrentSession}>
                <Save size={13} /> Save
              </button>
            </div>
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '14px 0' }} />

          <div className="field">
            <label>Import Charles / mitmproxy .har File (Offline Channel Traffic Audit)</label>
            <input
              type="text"
              value={harName}
              onChange={(e) => setHarName(e.target.value)}
              placeholder="Label for imported HAR run"
              style={{ marginBottom: 6 }}
            />
            <label className="btn" style={{ justifyContent: 'center', cursor: 'pointer' }}>
              <Upload size={13} /> Choose .har Capture File
              <input type="file" accept=".har,application/json" style={{ display: 'none' }} onChange={handleHarFileUpload} />
            </label>
          </div>

          <div className="field" style={{ marginBottom: 0 }}>
            <label>Import Portable Snapshot Bundle (.json)</label>
            <label className="btn" style={{ justifyContent: 'center', cursor: 'pointer' }}>
              <FileJson size={13} /> Import Snapshot .json
              <input type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={handleJsonBundleUpload} />
            </label>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              <Archive size={16} /> SQLite Snapshot Archive ({snapshots.length})
            </h3>
          </div>
          {snapshots.length === 0 ? (
            <div className="muted">No saved snapshots yet.</div>
          ) : (
            <div className="issue-list">
              {snapshots.map((s) => (
                <div key={s.id} className="issue-item">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                    <strong>{s.name}</strong>
                    <span className={`pill ${s.certScore >= 85 ? 'ok' : 'warn'}`}>{s.certScore}/100</span>
                  </div>
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                    Source: <span className="mono">{s.source}</span> • Events: {s.eventCount} •{' '}
                    {new Date(s.createdAt).toLocaleString()}
                  </div>
                  <div className="btn-row" style={{ marginTop: 8 }}>
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => api.getSnapshot(s.id).then(setSelectedSnap)}
                    >
                      <Eye size={12} /> Inspect
                    </button>
                    <a className="btn btn-sm" href={`/api/snapshots/${s.id}/export.md`} download>
                      <FileText size={12} /> .md Report
                    </a>
                    <a className="btn btn-sm" href={`/api/snapshots/${s.id}/export.json`} download>
                      <Download size={12} /> .json Bundle
                    </a>
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        api.deleteSnapshot(s.id).then(() => {
                          if (selectedSnap?.id === s.id) setSelectedSnap(null);
                          refreshList();
                        });
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right Column: Snapshot / HAR Audit Report Viewer */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {statusMsg && <div className="issue-item info">{statusMsg}</div>}

        {!selectedSnap ? (
          <div className="card muted">
            Select a saved session snapshot on the left, snapshot your live run, or import a <span className="mono">.har</span> file to view its full Expected-vs-Actual Beacon Diff and Roku Certification Scorecard.
          </div>
        ) : (
          <>
            <div className="card">
              <div className="card-header">
                <div>
                  <h2 className="card-title">{selectedSnap.name}</h2>
                  <div className="muted" style={{ fontSize: 12 }}>
                    ID: <span className="mono">{selectedSnap.id}</span> • Source:{' '}
                    <span className="mono">{selectedSnap.source}</span> • Created:{' '}
                    {new Date(selectedSnap.createdAt).toLocaleString()}
                  </div>
                </div>
                <div className="btn-row">
                  <span className={`pill ${selectedSnap.auditReport.certScore >= 85 ? 'ok' : 'warn'}`}>
                    Cert Score: {selectedSnap.auditReport.certScore}/100
                  </span>
                  <a className="btn btn-sm" href={`/api/snapshots/${selectedSnap.id}/export.md`} download>
                    <FileText size={12} /> Export Markdown
                  </a>
                  <a className="btn btn-sm" href={`/api/snapshots/${selectedSnap.id}/export.json`} download>
                    <Download size={12} /> Export JSON
                  </a>
                </div>
              </div>

              {selectedSnap.adTagUrl && (
                <div className="mono muted" style={{ fontSize: 12, marginBottom: 12 }}>
                  Tag/Stream URL: {selectedSnap.adTagUrl}
                </div>
              )}

              <div className="grid-2">
                <div>
                  <h4 style={{ margin: '0 0 8px' }}>Roku Certification Checks</h4>
                  <div className="issue-list">
                    {selectedSnap.auditReport.certChecks.map((c) => (
                      <div
                        key={c.id}
                        className={`issue-item ${
                          c.status === 'fail' ? 'error' : c.status === 'warn' ? 'warning' : 'info'
                        }`}
                      >
                        <strong>[{c.status.toUpperCase()}] {c.title}</strong>
                        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{c.detail}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <h4 style={{ margin: '0 0 8px' }}>
                    Expected-vs-Actual Beacons ({selectedSnap.auditReport.matchedCount}/{selectedSnap.auditReport.expectedCount})
                  </h4>
                  <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Status</th>
                          <th>Ad</th>
                          <th>Event</th>
                          <th>Drift</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedSnap.auditReport.diffItems.map((d) => (
                          <tr key={d.spec.id}>
                            <td>
                              <span className={`pill ${d.status === 'matched' ? 'ok' : d.status === 'missing' ? 'err' : 'warn'}`}>
                                {d.status}
                              </span>
                            </td>
                            <td className="mono">{d.spec.adId}</td>
                            <td className="mono">{d.spec.event}</td>
                            <td className="mono">
                              {d.driftSec !== undefined ? `${d.driftSec > 0 ? '+' : ''}${d.driftSec}s` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {selectedSnap.screenshots.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <h4 style={{ margin: '0 0 8px' }}>Captured Roku Screenshots</h4>
                  <div className="grid-2">
                    {selectedSnap.screenshots.map((s) => (
                      <img
                        key={s.id}
                        src={s.dataUrl}
                        alt="Roku screenshot"
                        style={{ width: '100%', borderRadius: 6, border: '1px solid var(--border)' }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
