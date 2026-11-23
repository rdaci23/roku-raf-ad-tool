import React, { useEffect, useState } from 'react';
import { Copy, Eye, FileCode2, Plus, Radio, Send, Trash2, Zap } from 'lucide-react';
import { api } from '../api.js';
import type {
  ChaosConfig,
  ChaosFaultMode,
  CustomMockConfig,
  LiveAdCueState,
  MockScenarioType,
  RafPlaybackMode,
} from '../../shared/types.js';

interface Props {
  lanBaseUrl: string;
  sessionId: string;
  onInspectTag: (url: string) => void;
  onSendToRoku: (url: string, mode?: RafPlaybackMode) => void;
}

const BUILTIN_ENDPOINTS: Array<{
  title: string;
  desc: string;
  path: string;
  mode: RafPlaybackMode;
}> = [
  {
    title: 'Single Linear Preroll (VAST 4.0)',
    desc: '8s H.264/AAC MP4 creative with full impression, quartile, click & error beacons.',
    path: '/mock/vast/single-preroll.xml',
    mode: 'csai',
  },
  {
    title: '3-Spot Ad Pod + Skippable + Buffet (Client-Stitched Ready)',
    desc: 'Sequenced 3-ad pod (spot #2 skippable at 5s) plus an unsequenced buffet fallback ad.',
    path: '/mock/vast/pod-3-ads.xml',
    mode: 'csai-stitched',
  },
  {
    title: 'Google Ad Manager (GAM) VMAP Schedule',
    desc: 'VMAP 1.0 break schedule with preroll, midroll at 00:00:10 (3-spot pod), and postroll.',
    path: '/mock/vast/gam-vmap-pod.xml',
    mode: 'csai',
  },
  {
    title: 'SpringServe 3-Spot CTV Pod (VAST 4.0)',
    desc: 'Emulates SpringServe CTV pod response with sequenced spots and pod tracking.',
    path: '/mock/vast/springserve-pod.xml',
    mode: 'csai',
  },
  {
    title: 'FreeWheel SmartXML / VAST 4.0 Preroll',
    desc: 'Emulates FreeWheel CTV Linear VAST 4.0 creative.',
    path: '/mock/vast/freewheel-vast.xml',
    mode: 'csai',
  },
  {
    title: '2-Hop VAST Wrapper Chain',
    desc: 'Tests Roku RAF wrapper following and merged wrapper + inline quartile tracking.',
    path: '/mock/vast/wrapper-chain.xml?depth=2',
    mode: 'csai',
  },
  {
    title: 'SSAI VOD Stitched HLS + #EXT-X-DATERANGE / SCTE-35',
    desc: 'VOD HLS playlist with #EXT-X-DISCONTINUITY + SCTE-35 DATERANGE break at 10s.',
    path: '/mock/ssai/stream.m3u8',
    mode: 'ssai',
  },
  {
    title: 'Google DAI — VOD Stream Bootstrap Endpoint (POST)',
    desc: 'Emulates Google DAI VOD /ondemand/hls/.../streams session creation + pod metadata.',
    path: '/mock/dai/ondemand/hls/content/2548831/vid/pilot/streams',
    mode: 'google-dai',
  },
  {
    title: 'Google DAI — Live Linear Stream Bootstrap Endpoint (POST)',
    desc: 'Emulates Google DAI Live /live/hls/asset/.../streams backed by the Live SCTE-35 HLS engine.',
    path: '/mock/dai/live/hls/asset/live-fast-01/streams',
    mode: 'google-dai',
  },
  {
    title: 'Error Scenario: Broken MediaFile 404 (RAF 401/405)',
    desc: 'Valid VAST XML pointing to missing MP4 so Roku RAF fires <Error> with error code.',
    path: '/mock/vast/error-media-404.xml',
    mode: 'csai',
  },
  {
    title: 'Error Scenario: JS VPAID Only (RAF 403)',
    desc: 'Serves unsupported application/javascript VPAID to trigger RAF Error 403.',
    path: '/mock/vast/error-vpaid-only.xml',
    mode: 'csai',
  },
];

export function MockServerTab({ lanBaseUrl, sessionId, onInspectTag, onSendToRoku }: Props) {
  const [customMocks, setCustomMocks] = useState<CustomMockConfig[]>([]);
  const [name, setName] = useState('Custom 4-Spot Skippable Pod');
  const [scenario, setScenario] = useState<MockScenarioType>('pod-3-ads');
  const [vastVersion, setVastVersion] = useState<'3.0' | '4.0'>('4.0');
  const [podSize, setPodSize] = useState<number>(4);
  const [durationSec, setDurationSec] = useState<number>(8);
  const [skippableAfterSec, setSkippableAfterSec] = useState<number>(4);
  const [wrapperDepth, setWrapperDepth] = useState<number>(2);
  const [delayMs, setDelayMs] = useState<number>(0);
  const [includeCompanion, setIncludeCompanion] = useState<boolean>(true);
  const [previewXml, setPreviewXml] = useState<string>('');
  const [previewTitle, setPreviewTitle] = useState<string>('');

  // Live Linear HLS SCTE-35 studio state
  const [liveMediaSeq, setLiveMediaSeq] = useState<number>(0);
  const [liveCues, setLiveCues] = useState<LiveAdCueState[]>([]);
  const [cueDurationSec, setCueDurationSec] = useState<number>(10);
  const [cueBanner, setCueBanner] = useState<string>('');

  // Chaos / Network Fault Injector state
  const [chaos, setChaos] = useState<ChaosConfig>({ mode: 'none', delayMs: 0, dropAtHop: 2 });

  const refreshMocks = () => {
    api.getCustomMocks().then((d) => setCustomMocks(d.customMocks)).catch(() => {});
    api.getChaos().then(setChaos).catch(() => {});
  };

  const refreshLiveState = () => {
    api
      .getLiveState(sessionId)
      .then((st) => {
        setLiveMediaSeq(st.mediaSequence);
        setLiveCues(st.cues);
      })
      .catch(() => {});
  };

  useEffect(() => {
    refreshMocks();
    refreshLiveState();
    const timer = setInterval(refreshLiveState, 5000);
    return () => clearInterval(timer);
  }, [sessionId]);

  const buildFullUrl = (path: string) => {
    const sep = path.includes('?') ? '&' : '?';
    return `${lanBaseUrl}${path}${sep}session=${encodeURIComponent(sessionId)}`;
  };

  const handleCueLiveBreak = async () => {
    const res = await api.cueLiveBreak(sessionId, cueDurationSec);
    setCueBanner(
      `Cued ${res.cue.durationSec}s SCTE-35 Ad Break (${res.cue.id}) starting at Media Sequence #${res.cue.startMediaSeq}!`
    );
    refreshLiveState();
  };

  const handlePreviewUrl = async (title: string, url: string, mode: RafPlaybackMode) => {
    setPreviewTitle(title);
    const localPath = url.replace(lanBaseUrl, '');
    const resp = await fetch(localPath, {
      method: mode === 'google-dai' ? 'POST' : 'GET',
    });
    const text = await resp.text();
    try {
      setPreviewXml(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      setPreviewXml(text);
    }
  };

  const handleCreateCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    await api.saveCustomMock({
      name,
      scenario,
      vastVersion,
      podSize,
      durationSec,
      skippableAfterSec: skippableAfterSec > 0 ? skippableAfterSec : undefined,
      wrapperDepth,
      delayMs,
      includeCompanion,
      sessionId,
    });
    refreshMocks();
  };

  const liveMasterUrl = `${lanBaseUrl}/mock/live/master.m3u8?session=${encodeURIComponent(sessionId)}`;
  const liveMediaUrl = `${lanBaseUrl}/mock/live/playlist.m3u8?session=${encodeURIComponent(sessionId)}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Live Linear FAST / HLS SCTE-35 Ad Break Studio */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">
            <Radio size={16} /> Live Linear HLS Sliding-Window Stream & On-Demand SCTE-35 Cue Trigger
          </h2>
          <div className="btn-row">
            <span className="pill ok mono">Live MediaSeq #{liveMediaSeq}</span>
            <span className="pill mono">Active Breaks: {liveCues.length}</span>
          </div>
        </div>

        <div className="grid-2" style={{ alignItems: 'end' }}>
          <div>
            <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
              Master HLS URL: <span className="mono">{liveMasterUrl}</span>
            </div>
            <div className="btn-row">
              <button className="btn btn-sm" onClick={() => navigator.clipboard.writeText(liveMasterUrl)}>
                <Copy size={12} /> Copy Master M3U8
              </button>
              <button className="btn btn-sm" onClick={() => handlePreviewUrl('Live Sliding Media Playlist', liveMediaUrl, 'ssai-live')}>
                <Eye size={12} /> Inspect Live Window
              </button>
              <button className="btn btn-sm" onClick={() => onInspectTag(liveMediaUrl)}>
                Validate Manifest
              </button>
              <button className="btn btn-sm btn-primary" onClick={() => onSendToRoku(liveMasterUrl, 'ssai-live')}>
                <Send size={12} /> Play Live Stream on Roku
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <select
              style={{ width: 150 }}
              value={cueDurationSec}
              onChange={(e) => setCueDurationSec(Number(e.target.value))}
            >
              <option value={10}>10s Break (2 segs)</option>
              <option value={15}>15s Break (3 segs)</option>
              <option value={30}>30s Break (6 segs)</option>
            </select>
            <button className="btn btn-primary" onClick={handleCueLiveBreak}>
              <Zap size={14} /> Cue Live SCTE-35 / DATERANGE Ad Break Now
            </button>
          </div>
        </div>

        {cueBanner && (
          <div className="issue-item info" style={{ marginTop: 10 }}>
            <strong>Live Cue Injected:</strong> {cueBanner}
          </div>
        )}
      </div>

      {/* Ad Chaos / Network Fault Injector */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">
            <Zap size={16} /> Ad Chaos & Network Fault Injector (Black-Screen Hang Resilience)
          </h2>
          <span className={`pill mono ${chaos.mode === 'none' ? 'ok' : 'warn'}`}>
            Active Fault: {chaos.mode.toUpperCase()}
          </span>
        </div>

        <div className="grid-2" style={{ alignItems: 'end' }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Proxy & Mock Server Fault Mode (applies globally or via ?chaos=)</label>
            <select
              value={chaos.mode}
              onChange={async (e) => {
                const nextMode = e.target.value as ChaosFaultMode;
                const updated = await api.setChaos({
                  mode: nextMode,
                  delayMs: nextMode === 'latency' ? 3500 : 0,
                  dropAtHop: chaos.dropAtHop,
                });
                setChaos(updated);
              }}
            >
              <option value="none">None — Normal 200 OK Responses</option>
              <option value="http-503">HTTP 503 Service Unavailable (Upstream Outage)</option>
              <option value="http-429">HTTP 429 Too Many Requests (Rate Limited)</option>
              <option value="corrupt-xml">Malformed / Truncated VAST XML Payload</option>
              <option value="empty-vast-303">Empty VAST No-Fill (&lt;VAST/&gt; Error 303)</option>
              <option value="drop-wrapper-hop">Drop Wrapper Hop #2 (Mid-Chain 503 Failure)</option>
              <option value="media-500">MP4 Creative CDN HTTP 500 Failure</option>
              <option value="latency">High Ad Server Latency (+3500ms)</option>
              <option value="timeout-hang">Ad Server Socket Hang (9.5s Timeout)</option>
            </select>
          </div>
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button
              className="btn"
              onClick={async () => {
                const reset = await api.setChaos({ mode: 'none', delayMs: 0, dropAtHop: 2 });
                setChaos(reset);
              }}
            >
              Reset Faults
            </button>
            <button
              className="btn btn-primary"
              onClick={() =>
                onSendToRoku(
                  `${lanBaseUrl}/mock/vast/single-preroll.xml?session=${encodeURIComponent(sessionId)}&chaos=${
                    chaos.mode === 'none' ? 'http-503' : chaos.mode
                  }`,
                  'csai'
                )
              }
            >
              <Send size={13} /> Test Chaos Fallback on Roku
            </button>
          </div>
        </div>
      </div>

      <div className="grid-sidebar">
        {/* Left Column: Custom Mock Builder */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">
              <Plus size={16} /> Custom VAST / VMAP Profile Builder
            </h2>
          </div>

          <form onSubmit={handleCreateCustom}>
            <div className="field">
              <label>Profile Name</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>

            <div className="field">
              <label>Scenario Template</label>
              <select value={scenario} onChange={(e) => setScenario(e.target.value as MockScenarioType)}>
                <option value="single-preroll">Single Linear Preroll</option>
                <option value="pod-3-ads">Multi-Spot Ad Pod (+ Buffet)</option>
                <option value="springserve-pod">SpringServe CTV Pod</option>
                <option value="gam-vmap-pod">GAM VMAP Schedule (Pre + Mid + Post)</option>
                <option value="freewheel-vast">FreeWheel VAST 4</option>
                <option value="wrapper-chain">Multi-Hop Wrapper Chain</option>
                <option value="error-no-fill">Empty VAST (No-Fill)</option>
                <option value="error-media-404">Broken Media 404</option>
                <option value="error-vpaid-only">Unsupported JS VPAID</option>
              </select>
            </div>

            <div className="grid-2">
              <div className="field">
                <label>VAST Version</label>
                <select value={vastVersion} onChange={(e) => setVastVersion(e.target.value as '3.0' | '4.0')}>
                  <option value="4.0">VAST 4.0</option>
                  <option value="3.0">VAST 3.0</option>
                </select>
              </div>
              <div className="field">
                <label>Spot Duration (sec)</label>
                <input type="number" min={1} max={120} value={durationSec} onChange={(e) => setDurationSec(Number(e.target.value))} />
              </div>
            </div>

            <div className="grid-2">
              <div className="field">
                <label>Pod Spot Count (2–6)</label>
                <input type="number" min={2} max={6} value={podSize} onChange={(e) => setPodSize(Number(e.target.value))} />
              </div>
              <div className="field">
                <label>Skip Offset (sec, 0=off)</label>
                <input
                  type="number"
                  min={0}
                  max={60}
                  value={skippableAfterSec}
                  onChange={(e) => setSkippableAfterSec(Number(e.target.value))}
                />
              </div>
            </div>

            <div className="grid-2">
              <div className="field">
                <label>Wrapper Hops (1–8)</label>
                <input type="number" min={1} max={8} value={wrapperDepth} onChange={(e) => setWrapperDepth(Number(e.target.value))} />
              </div>
              <div className="field">
                <label>Server Latency (ms)</label>
                <input type="number" min={0} max={15000} step={250} value={delayMs} onChange={(e) => setDelayMs(Number(e.target.value))} />
              </div>
            </div>

            <div className="field">
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-main)' }}>
                <input
                  type="checkbox"
                  checked={includeCompanion}
                  onChange={(e) => setIncludeCompanion(e.target.checked)}
                />
                Include 300x250 Static Companion Ad
              </label>
            </div>

            <button type="submit" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
              <Plus size={14} /> Save Custom Mock to SQLite
            </button>
          </form>
        </div>

        {/* Right Column: Live Endpoints */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {previewXml && (
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Live Payload Preview: {previewTitle}</h3>
                <button className="btn btn-sm" onClick={() => setPreviewXml('')}>Close</button>
              </div>
              <pre className="code-box" style={{ maxHeight: 320 }}>{previewXml}</pre>
            </div>
          )}

          {customMocks.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Saved Custom Mock Endpoints ({customMocks.length})</h3>
              </div>
              <div className="issue-list">
                {customMocks.map((m) => {
                  const url = `${lanBaseUrl}/mock/custom/${m.id}.xml?session=${encodeURIComponent(sessionId)}`;
                  return (
                    <div key={m.id} className="issue-item">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <div>
                          <strong>{m.name}</strong> <span className="pill mono">{m.scenario}</span>
                        </div>
                        <div className="btn-row">
                          <button className="btn btn-sm" onClick={() => navigator.clipboard.writeText(url)}>
                            <Copy size={12} /> Copy
                          </button>
                          <button className="btn btn-sm" onClick={() => handlePreviewUrl(m.name, url, 'csai')}>
                            <Eye size={12} /> XML
                          </button>
                          <button className="btn btn-sm" onClick={() => onInspectTag(url)}>
                            Validate
                          </button>
                          <button className="btn btn-sm btn-primary" onClick={() => onSendToRoku(url, 'csai')}>
                            <Send size={12} /> Roku
                          </button>
                          <button className="btn btn-sm" onClick={() => api.deleteCustomMock(m.id).then(refreshMocks)}>
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                      <div className="mono muted" style={{ fontSize: 11.5, marginTop: 4 }}>{url}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-header">
              <h3 className="card-title">
                <FileCode2 size={16} /> Built-In CSAI, Vendor, SSAI & Google DAI Endpoints
              </h3>
            </div>
            <div className="issue-list">
              {BUILTIN_ENDPOINTS.map((ep) => {
                const url = buildFullUrl(ep.path);
                return (
                  <div key={ep.path} className="issue-item">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <div>
                        <strong>{ep.title}</strong>{' '}
                        <span className="pill mono">{ep.mode}</span>
                      </div>
                      <div className="btn-row">
                        <button className="btn btn-sm" onClick={() => navigator.clipboard.writeText(url)}>
                          <Copy size={12} /> Copy
                        </button>
                        <button className="btn btn-sm" onClick={() => handlePreviewUrl(ep.title, url, ep.mode)}>
                          <Eye size={12} /> Payload
                        </button>
                        {ep.mode !== 'google-dai' && (
                          <button className="btn btn-sm" onClick={() => onInspectTag(url)}>
                            Inspect
                          </button>
                        )}
                        <button className="btn btn-sm btn-primary" onClick={() => onSendToRoku(url, ep.mode)}>
                          <Send size={12} /> Roku
                        </button>
                      </div>
                    </div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>{ep.desc}</div>
                    <div className="mono muted" style={{ fontSize: 11.5, marginTop: 4 }}>{url}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
