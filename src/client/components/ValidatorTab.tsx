import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  Code2,
  Copy,
  Film,
  Play,
  RefreshCw,
  Search,
  Send,
  Sliders,
  Wrench,
} from 'lucide-react';
import { api } from '../api.js';
import type { RepoScanReport } from '../../shared/repoScanner.js';
import { VENDOR_LABELS } from '../../shared/vendorTemplates.js';
import type {
  ManifestInspectionReport,
  RafMacroValues,
  RafPlaybackMode,
  RafRuntimePrefs,
  RokuMediaType,
  ValidationReport,
  VendorBuildParams,
  VendorId,
  VendorRequestAudit,
} from '../../shared/types.js';

interface Props {
  lanBaseUrl: string;
  sessionId: string;
  initialUrl: string;
  defaultMacros?: RafMacroValues;
  rafPrefs: RafRuntimePrefs;
  onSendToRoku: (url: string, mode?: RafPlaybackMode) => void;
}

const SAMPLE_INLINE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<VAST version="4.0">
  <Ad id="sample-spot-1" sequence="1">
    <InLine>
      <AdSystem>RokuRAFValidatorSample</AdSystem>
      <AdTitle>Sample 8s Roku Preroll</AdTitle>
      <Error><![CDATA[https://example.com/error?code=[ERRORCODE]]]></Error>
      <Impression><![CDATA[https://example.com/impression?cb=[CACHEBUSTING]]]></Impression>
      <Creatives>
        <Creative id="cr-1">
          <Linear skipoffset="00:00:05">
            <Duration>00:00:08</Duration>
            <TrackingEvents>
              <Tracking event="start"><![CDATA[https://example.com/start]]></Tracking>
              <Tracking event="firstQuartile"><![CDATA[https://example.com/q1]]></Tracking>
              <Tracking event="midpoint"><![CDATA[https://example.com/mid]]></Tracking>
              <Tracking event="thirdQuartile"><![CDATA[https://example.com/q3]]></Tracking>
              <Tracking event="complete"><![CDATA[https://example.com/complete]]></Tracking>
            </TrackingEvents>
            <MediaFiles>
              <MediaFile delivery="progressive" type="video/mp4" bitrate="1200" width="1280" height="720"><![CDATA[http://127.0.0.1:4321/media/ad-spot-1.mp4]]></MediaFile>
            </MediaFiles>
          </Linear>
        </Creative>
      </Creatives>
    </InLine>
  </Ad>
</VAST>`;

export function ValidatorTab({
  lanBaseUrl,
  sessionId,
  initialUrl,
  defaultMacros,
  rafPrefs,
  onSendToRoku,
}: Props) {
  const [subTab, setSubTab] = useState<'vast' | 'manifest' | 'vendor' | 'repo'>('vast');

  // 4. Static BrightScript Repo Scanner state
  const [repoPath, setRepoPath] = useState<string>('');
  const [repoReport, setRepoReport] = useState<RepoScanReport | null>(null);
  const [scanningRepo, setScanningRepo] = useState<boolean>(false);

  // 1. VAST / VMAP state
  const [mode, setMode] = useState<'url' | 'xml'>('url');
  const [tagUrl, setTagUrl] = useState<string>(initialUrl);
  const [rawXml, setRawXml] = useState<string>(SAMPLE_INLINE_XML);
  const [showMacros, setShowMacros] = useState<boolean>(false);
  const [macros, setMacros] = useState<Partial<RafMacroValues>>({});
  const [policyMediaType, setPolicyMediaType] = useState<string>('');
  const [policyLengthSec, setPolicyLengthSec] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [previewMediaUrl, setPreviewMediaUrl] = useState<string | null>(null);

  // 2. HLS / DASH Manifest Inspector state
  const [manifestUrl, setManifestUrl] = useState<string>(`${lanBaseUrl}/mock/ssai/stream.m3u8?session=${sessionId}`);
  const [manifestRaw, setManifestRaw] = useState<string>('');
  const [manifestInputMode, setManifestInputMode] = useState<'url' | 'text'>('url');
  const [manifestReport, setManifestReport] = useState<ManifestInspectionReport | null>(null);

  // 3. Vendor Request Builder, Parameter Auditor & BrightScript Generator state
  const [vendorParams, setVendorParams] = useState<VendorBuildParams>({
    vendor: 'gam',
    networkOrSupplyId: '21775744923',
    adUnitOrProfile: '/21775744923/roku_ctv_video',
    cmsId: '2548831',
    videoId: 'tears-of-steel',
    assetKey: 'sample-dai-live-asset',
    podMaxDurationSec: 90,
    maxAdDurationSec: 30,
    outputFormat: 'vmap',
    usPrivacy: '1YNN',
    gpp: '',
    gppSid: '',
    coppa: false,
    customTargeting: 'genre=scifi&device=roku',
    useRokuMacros: true,
  });
  const [useLocalMockHost, setUseLocalMockHost] = useState<boolean>(true);
  const [builtVendorUrl, setBuiltVendorUrl] = useState<string>('');
  const [vendorAudit, setVendorAudit] = useState<VendorRequestAudit | null>(null);
  const [brsMode, setBrsMode] = useState<RafPlaybackMode>('csai');
  const [brsSnippet, setBrsSnippet] = useState<string>('');

  useEffect(() => {
    if (initialUrl) {
      setTagUrl(initialUrl);
      if (initialUrl.includes('.m3u8') || initialUrl.includes('.mpd')) {
        setManifestUrl(initialUrl);
        setSubTab('manifest');
      }
    }
  }, [initialUrl]);

  useEffect(() => {
    if (defaultMacros && Object.keys(macros).length === 0) {
      setMacros(defaultMacros);
    }
  }, [defaultMacros]);

  const runValidation = async (overrideUrl?: string) => {
    setLoading(true);
    setError(null);
    try {
      const target = overrideUrl ?? tagUrl;
      const policy =
        policyMediaType || policyLengthSec
          ? {
              mediaType: policyMediaType ? (policyMediaType as RokuMediaType) : undefined,
              contentLengthSec: policyLengthSec ? Number(policyLengthSec) : undefined,
            }
          : undefined;
      const res =
        mode === 'url' || overrideUrl
          ? await api.validate({ url: target, macros, policy })
          : await api.validate({ xml: rawXml, policy });
      setReport(res);
      const firstPlayable = res.parsed.ads
        .flatMap((a) => a.linears)
        .flatMap((l) => l.mediaFiles)
        .find((m) => m.rafCompatible && m.type?.includes('mp4'));
      setPreviewMediaUrl(firstPlayable?.url ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const runManifestInspect = async (overrideUrl?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res =
        manifestInputMode === 'url' || overrideUrl
          ? await api.inspectManifest({ url: overrideUrl ?? manifestUrl })
          : await api.inspectManifest({ text: manifestRaw });
      setManifestReport(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleBuildVendor = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.buildVendorUrl(vendorParams, useLocalMockHost);
      setBuiltVendorUrl(res.requestUrl);
      setVendorAudit(res.audit);

      const autoMode: RafPlaybackMode = vendorParams.vendor.startsWith('google-dai')
        ? 'google-dai'
        : brsMode;
      setBrsMode(autoMode);

      const brs = await api.generateBrsSnippet({
        mode: autoMode,
        adTagOrStreamUrl: res.requestUrl,
        contentUrl: `${lanBaseUrl}/media/content-main.mp4`,
        prefs: rafPrefs,
      });
      setBrsSnippet(brs.code);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleAuditManualUrl = async () => {
    if (!builtVendorUrl.trim()) return;
    const audit = await api.auditVendorUrl(builtVendorUrl.trim());
    setVendorAudit(audit);
    const brs = await api.generateBrsSnippet({
      mode: brsMode,
      adTagOrStreamUrl: builtVendorUrl.trim(),
      contentUrl: `${lanBaseUrl}/media/content-main.mp4`,
      prefs: rafPrefs,
    });
    setBrsSnippet(brs.code);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Sub-mode Selector */}
      <div className="btn-row">
        <button
          className={`btn ${subTab === 'vast' ? 'btn-primary' : ''}`}
          onClick={() => setSubTab('vast')}
        >
          <Search size={14} /> VAST / VMAP Tag Validator
        </button>
        <button
          className={`btn ${subTab === 'manifest' ? 'btn-primary' : ''}`}
          onClick={() => setSubTab('manifest')}
        >
          <Film size={14} /> HLS (.m3u8) & MPEG-DASH (.mpd) Inspector
        </button>
        <button
          className={`btn ${subTab === 'vendor' ? 'btn-primary' : ''}`}
        onClick={() => setSubTab('vendor')}
        >
          <Wrench size={14} /> GAM / DAI / SpringServe / Publica / FreeWheel Builder & BRS Codegen
        </button>
        <button
          className={`btn ${subTab === 'repo' ? 'btn-primary' : ''}`}
          onClick={() => {
            setSubTab('repo');
            if (!repoReport) {
              setScanningRepo(true);
              api
                .scanRepo(repoPath || undefined)
                .then(setRepoReport)
                .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setScanningRepo(false));
            }
          }}
        >
          <Code2 size={14} /> BrightScript Repo Scanner
        </button>
      </div>

      {error && (
        <div className="issue-item error">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* SUB-TAB 1: VAST / VMAP VALIDATOR */}
      {subTab === 'vast' && (
        <>
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">
                <Search size={16} /> VAST 2.0–4.2 & VMAP 1.0 Tag Validator (Roku RAF Ruleset)
              </h2>
              <div className="btn-row">
                <button
                  className={`btn btn-sm ${mode === 'url' ? 'btn-primary' : ''}`}
                  onClick={() => setMode('url')}
                >
                  Fetch Tag URL
                </button>
                <button
                  className={`btn btn-sm ${mode === 'xml' ? 'btn-primary' : ''}`}
                  onClick={() => setMode('xml')}
                >
                  Paste Raw XML
                </button>
                <button className="btn btn-sm" onClick={() => setShowMacros((s) => !s)}>
                  <Sliders size={13} /> RAF Macros & Ad-Load Policy
                </button>
              </div>
            </div>

            {mode === 'url' ? (
              <div>
                <div className="field">
                  <label>Ad Tag URL (expands ROKU_ADS_* macros & unrolls Wrapper hops)</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="text"
                      value={tagUrl}
                      onChange={(e) => setTagUrl(e.target.value)}
                    />
                    <button
                      className="btn btn-primary"
                      disabled={loading || !tagUrl.trim()}
                      onClick={() => runValidation()}
                    >
                      <RefreshCw size={14} /> {loading ? 'Validating...' : 'Fetch & Validate'}
                    </button>
                    <button
                      className="btn"
                      disabled={!tagUrl.trim()}
                      onClick={() => onSendToRoku(tagUrl, 'csai')}
                    >
                      <Send size={14} /> Test on Roku
                    </button>
                  </div>
                </div>

                <div className="btn-row" style={{ marginTop: 6 }}>
                  <span className="muted" style={{ fontSize: 12 }}>Local Mock Presets:</span>
                  {[
                    { label: 'Single Preroll', path: `/mock/vast/single-preroll.xml?session=${sessionId}&cb=ROKU_ADS_CACHE_BUSTER` },
                    { label: '3-Ad Pod + Buffet', path: `/mock/vast/pod-3-ads.xml?session=${sessionId}` },
                    { label: 'SpringServe Pod', path: `/mock/vast/springserve-pod.xml?session=${sessionId}` },
                    { label: 'GAM VMAP Schedule', path: `/mock/vast/gam-vmap-pod.xml?session=${sessionId}` },
                    { label: '2-Hop Wrapper', path: `/mock/vast/wrapper-chain.xml?session=${sessionId}&depth=2` },
                    { label: 'JS VPAID Error (403)', path: `/mock/vast/error-vpaid-only.xml?session=${sessionId}` },
                  ].map((p) => (
                    <button
                      key={p.label}
                      className="btn btn-sm"
                      onClick={() => {
                        const u = `${lanBaseUrl}${p.path}`;
                        setTagUrl(u);
                        runValidation(u);
                      }}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                <div className="btn-row" style={{ marginTop: 6 }}>
                  <span className="muted" style={{ fontSize: 12 }}>Public Live Samples:</span>
                  {[
                    {
                      label: 'Google GAM Live VAST',
                      url: 'https://pubads.g.doubleclick.net/gampad/ads?iu=/21775744923/external/single_ad_samples&sz=640x480&cust_params=sample_ct%3Dlinear&ciu_szs=300x250%2C728x90&gdfp_req=1&output=vast&unviewed_position_start=1&env=vp&correlator=ROKU_ADS_CACHE_BUSTER',
                    },
                    {
                      label: 'Google GAM Live VMAP',
                      url: 'https://pubads.g.doubleclick.net/gampad/ads?sz=640x480&iu=/124319096/external/ad_rule_samples&ciu_szs=300x250&ad_rule=1&impl=s&gdfp_req=1&env=vp&output=vmap&unviewed_position_start=1&cust_params=deployment%3Ddevsite%26sample_ar%3Dpremidpost&cmsid=496&vid=short_onecue&correlator=ROKU_ADS_CACHE_BUSTER',
                    },
                    {
                      label: 'Roku Official SmartXML',
                      url: 'https://devtools.web.roku.com/samples/sample.xml',
                    },
                  ].map((s) => (
                    <button
                      key={s.label}
                      className="btn btn-sm"
                      onClick={() => {
                        setTagUrl(s.url);
                        runValidation(s.url);
                      }}
                    >
                      {s.label}
                    </button>
                  ))}
                  {!tagUrl.startsWith(lanBaseUrl) && /^https?:\/\//i.test(tagUrl) && (
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() =>
                        onSendToRoku(
                          `${lanBaseUrl}/proxy/tag?session=${encodeURIComponent(sessionId)}&forward=1&url=${encodeURIComponent(tagUrl)}`,
                          'csai'
                        )
                      }
                    >
                      <Send size={12} /> Proxy & Audit on Roku
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div>
                <div className="field">
                  <label>Raw VAST or VMAP XML Document</label>
                  <textarea
                    className="code-input"
                    rows={10}
                    value={rawXml}
                    onChange={(e) => setRawXml(e.target.value)}
                  />
                </div>
                <button className="btn btn-primary" disabled={loading} onClick={() => runValidation()}>
                  <CheckCircle size={14} /> Validate XML
                </button>
              </div>
            )}

            {showMacros && (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                <div className="grid-2" style={{ marginBottom: 12 }}>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>Roku Ad-Load Policy: Content mediaType</label>
                    <select value={policyMediaType} onChange={(e) => setPolicyMediaType(e.target.value)}>
                      <option value="">(Unconstrained / Generic Test)</option>
                      <option value="episode">episode (Long-Form Episodic)</option>
                      <option value="movie">movie (Long-Form Feature)</option>
                      <option value="shortFormVideo">shortFormVideo (&lt;15m — Midrolls Prohibited)</option>
                      <option value="live">live (Linear Stream)</option>
                    </select>
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>Content Duration (seconds, for midroll spacing & short-form check)</label>
                    <input
                      type="number"
                      placeholder="e.g. 600 for 10m clip, 2700 for 45m episode"
                      value={policyLengthSec}
                      onChange={(e) => setPolicyLengthSec(e.target.value)}
                    />
                  </div>
                </div>
                <div className="grid-2">
                  {Object.entries(macros).map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="mono muted" style={{ minWidth: 215, fontSize: 11.5 }}>{k}</span>
                      <input
                        type="text"
                        value={v ?? ''}
                        onChange={(e) => setMacros((prev) => ({ ...prev, [k]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {report && (
            <div className="grid-2">
              <div className="card">
                <div className="card-header">
                  <h3 className="card-title">
                    <AlertTriangle size={15} /> Score: {report.score}/100 • Diagnostics ({report.issues.length})
                  </h3>
                  <span className={`pill ${report.validForRaf ? 'ok' : 'err'}`}>
                    {report.validForRaf ? 'RAF Compatible' : 'Has Blockers'}
                  </span>
                </div>
                {report.issues.length === 0 ? (
                  <div className="pill ok">Clean Roku RAF tag — zero warnings or errors!</div>
                ) : (
                  <div className="issue-list">
                    {report.issues.map((iss, idx) => (
                      <div key={idx} className={`issue-item ${iss.severity}`}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <strong style={{ textTransform: 'uppercase', fontSize: 11.5 }}>
                            [{iss.severity}] {iss.code}
                          </strong>
                          {iss.location && <span className="mono muted" style={{ fontSize: 11 }}>{iss.location}</span>}
                        </div>
                        <div style={{ marginTop: 4 }}>{iss.message}</div>
                        {iss.rafHint && (
                          <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                            <strong>RAF Hint:</strong> {iss.rafHint}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {report.parsed.wrapperHops && report.parsed.wrapperHops.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>
                      Wrapper Waterfall ({report.parsed.wrapperHops.length} hop(s))
                    </h4>
                    <div className="issue-list">
                      {report.parsed.wrapperHops.map((h) => (
                        <div key={h.hop} className="issue-item info">
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <strong>Hop #{h.hop} — {h.isWrapper ? 'Wrapper' : h.tagType}</strong>
                            <span className="mono muted">HTTP {h.status} • {h.durationMs}ms</span>
                          </div>
                          <div className="mono muted" style={{ fontSize: 11.5, marginTop: 3 }}>{h.url}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="card">
                <div className="card-header">
                  <h3 className="card-title">Parsed Pods, MediaFiles & Raw XML</h3>
                </div>
                {previewMediaUrl && (
                  <video
                    key={previewMediaUrl}
                    src={previewMediaUrl}
                    controls
                    style={{ width: '100%', maxHeight: 210, background: '#000', borderRadius: 8, marginBottom: 12 }}
                  />
                )}
                {report.parsed.adBreaks.length > 0 && (
                  <div className="table-wrap" style={{ marginBottom: 12 }}>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Break</th>
                          <th>Offset</th>
                          <th>AdTagURI</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {report.parsed.adBreaks.map((b, i) => (
                          <tr key={i}>
                            <td className="mono">{b.id}</td>
                            <td className="mono">{b.timeOffset}</td>
                            <td className="mono" style={{ maxWidth: 230, wordBreak: 'break-all' }}>{b.adTagUri}</td>
                            <td>
                              {b.adTagUri && (
                                <button className="btn btn-sm" onClick={() => { setTagUrl(b.adTagUri!); runValidation(b.adTagUri!); }}>
                                  Inspect
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {report.parsed.ads.map((ad) => (
                  <div key={ad.id} className="issue-item" style={{ marginBottom: 10 }}>
                    <strong>{ad.adTitle || ad.id}</strong>{' '}
                    <span className="pill mono">{ad.sequence !== undefined ? `seq=${ad.sequence}` : 'buffet'}</span>
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      Impressions: {ad.impressions.length} • Errors: {ad.errors.length} • Tracking: {ad.linears[0]?.trackingEvents.length ?? 0}
                    </div>
                    {ad.linears.flatMap((l) => l.mediaFiles).map((mf, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, fontSize: 12 }}>
                        <span className="mono">
                          <span className={`pill ${mf.rafCompatible ? 'ok' : 'err'}`} style={{ marginRight: 6 }}>
                            {mf.rafCompatible ? 'OK' : 'Unsupported'}
                          </span>
                          {mf.type} {mf.width ? `${mf.width}x${mf.height}` : ''} {mf.bitrate ? `@ ${mf.bitrate}k` : ''}
                        </span>
                        {mf.rafCompatible && mf.type?.includes('mp4') && (
                          <button className="btn btn-sm" onClick={() => setPreviewMediaUrl(mf.url)}>
                            <Play size={11} /> Preview
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
                <details style={{ marginTop: 10 }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 12.5 }}>View Raw XML</summary>
                  <pre className="code-box" style={{ marginTop: 8, maxHeight: 300 }}>{report.rawXml}</pre>
                </details>
              </div>
            </div>
          )}
        </>
      )}

      {/* SUB-TAB 2: HLS & MPEG-DASH MANIFEST INSPECTOR */}
      {subTab === 'manifest' && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">
              <Film size={16} /> HLS (.m3u8) & MPEG-DASH (.mpd) Stream & SCTE-35 Inspector
            </h2>
            <div className="btn-row">
              <button
                className={`btn btn-sm ${manifestInputMode === 'url' ? 'btn-primary' : ''}`}
                onClick={() => setManifestInputMode('url')}
              >
                Fetch URL
              </button>
              <button
                className={`btn btn-sm ${manifestInputMode === 'text' ? 'btn-primary' : ''}`}
                onClick={() => setManifestInputMode('text')}
              >
                Paste Manifest
              </button>
            </div>
          </div>

          {manifestInputMode === 'url' ? (
            <div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <input
                  type="text"
                  value={manifestUrl}
                  onChange={(e) => setManifestUrl(e.target.value)}
                  className="mono"
                />
                <button className="btn btn-primary" onClick={() => runManifestInspect()}>
                  Inspect Stream
                </button>
                <button className="btn" onClick={() => onSendToRoku(manifestUrl, manifestReport?.isLive ? 'ssai-live' : 'ssai')}>
                  <Send size={13} /> Play on Roku
                </button>
              </div>
              <div className="btn-row">
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    const u = `${lanBaseUrl}/mock/ssai/stream.m3u8?session=${sessionId}`;
                    setManifestUrl(u);
                    runManifestInspect(u);
                  }}
                >
                  Load VOD SSAI Playlist
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    const u = `${lanBaseUrl}/mock/live/playlist.m3u8?session=${sessionId}`;
                    setManifestUrl(u);
                    runManifestInspect(u);
                  }}
                >
                  Load Live Sliding-Window Playlist
                </button>
              </div>
            </div>
          ) : (
            <div>
              <textarea
                className="code-input"
                rows={9}
                value={manifestRaw}
                onChange={(e) => setManifestRaw(e.target.value)}
                placeholder="#EXTM3U or <MPD ...>"
              />
              <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => runManifestInspect()}>
                Inspect Manifest Text
              </button>
            </div>
          )}

          {manifestReport && (
            <div className="grid-2" style={{ marginTop: 16 }}>
              <div>
                <div className="issue-item info" style={{ marginBottom: 12 }}>
                  <strong>Format:</strong> {manifestReport.format} •{' '}
                  <strong>Type:</strong> {manifestReport.isMaster ? 'Master / Multivariant' : manifestReport.isLive ? 'Live Sliding-Window' : 'VOD'} •{' '}
                  <strong>Segments/Periods:</strong> {manifestReport.segmentCount} •{' '}
                  <strong>Window Duration:</strong> {manifestReport.totalDurationSec}s
                  {manifestReport.mediaSequence !== undefined && (
                    <> • <strong>MediaSeq:</strong> {manifestReport.mediaSequence}</>
                  )}
                </div>

                <h4 style={{ margin: '0 0 8px' }}>Detected Ad Cues & SCTE-35 Markers ({manifestReport.adCues.length})</h4>
                <div className="issue-list">
                  {manifestReport.adCues.map((c, idx) => (
                    <div key={idx} className="issue-item">
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span className="pill ok">{c.type}</span>
                        <span className="mono muted">
                          {c.offsetSec !== undefined ? `@ +${c.offsetSec}s` : ''}{' '}
                          {c.durationSec !== undefined ? `(${c.durationSec}s)` : ''}
                        </span>
                      </div>
                      {c.scte35Payload && (
                        <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>
                          SCTE-35: {c.scte35Payload}
                        </div>
                      )}
                      <div className="mono muted" style={{ fontSize: 11, marginTop: 3 }}>{c.rawLine}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h4 style={{ margin: '0 0 8px' }}>Diagnostics & Raw Manifest</h4>
                <div className="issue-list" style={{ marginBottom: 12 }}>
                  {manifestReport.issues.map((iss, idx) => (
                    <div key={idx} className={`issue-item ${iss.severity}`}>
                      <strong>[{iss.severity}] {iss.code}:</strong> {iss.message}
                    </div>
                  ))}
                </div>
                <pre className="code-box" style={{ maxHeight: 320 }}>{manifestReport.rawText}</pre>
              </div>
            </div>
          )}
        </div>
      )}

      {/* SUB-TAB 3: VENDOR REQUEST BUILDER, PARAMETER AUDITOR & BRS CODEGEN */}
      {subTab === 'vendor' && (
        <div className="grid-sidebar">
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">
                <Wrench size={16} /> CTV Vendor Request Builder
              </h2>
            </div>

            <div className="field">
              <label>Ad Server / SSAI Ecosystem</label>
              <select
                value={vendorParams.vendor}
                onChange={(e) => setVendorParams((p) => ({ ...p, vendor: e.target.value as VendorId }))}
              >
                {Object.entries(VENDOR_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
            </div>

            <div className="grid-2">
              <div className="field">
                <label>Network / Supply ID</label>
                <input
                  type="text"
                  value={vendorParams.networkOrSupplyId}
                  onChange={(e) => setVendorParams((p) => ({ ...p, networkOrSupplyId: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>Ad Unit / Profile</label>
                <input
                  type="text"
                  value={vendorParams.adUnitOrProfile}
                  onChange={(e) => setVendorParams((p) => ({ ...p, adUnitOrProfile: e.target.value }))}
                />
              </div>
            </div>

            {vendorParams.vendor === 'google-dai-vod' && (
              <div className="grid-2">
                <div className="field">
                  <label>DAI CMS ID</label>
                  <input
                    type="text"
                    value={vendorParams.cmsId ?? ''}
                    onChange={(e) => setVendorParams((p) => ({ ...p, cmsId: e.target.value }))}
                  />
                </div>
                <div className="field">
                  <label>DAI Video ID</label>
                  <input
                    type="text"
                    value={vendorParams.videoId ?? ''}
                    onChange={(e) => setVendorParams((p) => ({ ...p, videoId: e.target.value }))}
                  />
                </div>
              </div>
            )}

            {vendorParams.vendor === 'google-dai-live' && (
              <div className="field">
                <label>DAI Live Asset Key</label>
                <input
                  type="text"
                  value={vendorParams.assetKey ?? ''}
                  onChange={(e) => setVendorParams((p) => ({ ...p, assetKey: e.target.value }))}
                />
              </div>
            )}

            <div className="grid-2">
              <div className="field">
                <label>Max Pod Duration (s)</label>
                <input
                  type="number"
                  value={vendorParams.podMaxDurationSec}
                  onChange={(e) => setVendorParams((p) => ({ ...p, podMaxDurationSec: Number(e.target.value) }))}
                />
              </div>
              <div className="field">
                <label>IAB US Privacy String</label>
                <input
                  type="text"
                  value={vendorParams.usPrivacy}
                  onChange={(e) => setVendorParams((p) => ({ ...p, usPrivacy: e.target.value }))}
                />
              </div>
            </div>

            <div className="field">
              <label>GPP Consent String (optional)</label>
              <input
                type="text"
                value={vendorParams.gpp ?? ''}
                placeholder="DBACNYA~CPXxRfAPXxRfAAfKABENB..."
                onChange={(e) => setVendorParams((p) => ({ ...p, gpp: e.target.value }))}
              />
            </div>

            <div className="field">
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-main)' }}>
                <input
                  type="checkbox"
                  checked={vendorParams.useRokuMacros}
                  onChange={(e) => setVendorParams((p) => ({ ...p, useRokuMacros: e.target.checked }))}
                />
                Use unexpanded <span className="mono">ROKU_ADS_*</span> runtime macros
              </label>
            </div>

            <div className="field">
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-main)' }}>
                <input
                  type="checkbox"
                  checked={useLocalMockHost}
                  onChange={(e) => setUseLocalMockHost(e.target.checked)}
                />
                Target local Mock Emulator ({lanBaseUrl}) for immediate Roku testing
              </label>
            </div>

            <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={handleBuildVendor}>
              Build Request, Audit Params & Generate BrightScript
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Outbound Roku Ad Request URL & Parameter Auditor</h3>
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <input
                  type="text"
                  className="mono"
                  value={builtVendorUrl}
                  onChange={(e) => setBuiltVendorUrl(e.target.value)}
                  placeholder="Paste any GAM / SpringServe / Publica / FreeWheel / DAI URL to audit..."
                />
                <button className="btn" onClick={handleAuditManualUrl}>Audit URL</button>
                {builtVendorUrl && (
                  <button
                    className="btn btn-primary"
                    onClick={() =>
                      onSendToRoku(
                        builtVendorUrl,
                        vendorParams.vendor.startsWith('google-dai') ? 'google-dai' : brsMode
                      )
                    }
                  >
                    <Send size={13} /> Roku
                  </button>
                )}
              </div>

              {vendorAudit && (
                <div>
                  <div className="btn-row" style={{ marginBottom: 10 }}>
                    <span className={`pill ${vendorAudit.score >= 85 ? 'ok' : 'warn'}`}>
                      Compliance Score: {vendorAudit.score}/100
                    </span>
                    <span className="pill mono">Detected Vendor: {vendorAudit.detectedVendor}</span>
                  </div>
                  <div className="issue-list">
                    {vendorAudit.findings.map((f, idx) => (
                      <div key={idx} className={`issue-item ${f.severity}`}>
                        <strong>[{f.status.toUpperCase()}] {f.param}</strong>
                        {f.value ? <span className="mono muted"> = {f.value}</span> : null}
                        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{f.message}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-header">
                <h3 className="card-title">
                  <Code2 size={16} /> Generated Roku BrightScript / SceneGraph RAF Integration Snippet
                </h3>
                <div className="btn-row">
                  <select
                    value={brsMode}
                    onChange={async (e) => {
                      const nextMode = e.target.value as RafPlaybackMode;
                      setBrsMode(nextMode);
                      if (builtVendorUrl) {
                        const res = await api.generateBrsSnippet({
                          mode: nextMode,
                          adTagOrStreamUrl: builtVendorUrl,
                          contentUrl: `${lanBaseUrl}/media/content-main.mp4`,
                          prefs: rafPrefs,
                        });
                        setBrsSnippet(res.code);
                      }
                    }}
                  >
                    <option value="csai">Standard CSAI (showAds)</option>
                    <option value="csai-stitched">Client-Stitched (constructStitchedStream)</option>
                    <option value="csai-skippable">Custom Skippable UI (skipoffset + OK Skip)</option>
                    <option value="ssai">SSAI VOD (stitchedAdsInit)</option>
                    <option value="ssai-live">SSAI Live HLS</option>
                    <option value="google-dai">Google DAI Session</option>
                  </select>
                  {brsSnippet && (
                    <button className="btn btn-sm" onClick={() => navigator.clipboard.writeText(brsSnippet)}>
                      <Copy size={12} /> Copy .brs
                    </button>
                  )}
                </div>
              </div>
              <pre className="code-box" style={{ maxHeight: 380 }}>
                {brsSnippet || '// Click "Build Request" or "Audit URL" above to generate tailored Roku_Ads.brs code.'}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* SUB-TAB 4: STATIC BRIGHTSCRIPT CHANNEL REPO SCANNER */}
      {subTab === 'repo' && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">
              <Code2 size={16} /> Static BrightScript / SceneGraph RAF Channel Scanner
            </h2>
          </div>

          <div className="field">
            <label>Roku Channel Source Directory (leave blank to scan built-in roku-channel/)</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                className="mono"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                placeholder="/path/to/your-roku-channel"
              />
              <button
                className="btn btn-primary"
                disabled={scanningRepo}
                onClick={async () => {
                  setScanningRepo(true);
                  setError(null);
                  try {
                    const res = await api.scanRepo(repoPath || undefined);
                    setRepoReport(res);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setScanningRepo(false);
                  }
                }}
              >
                <Search size={14} /> {scanningRepo ? 'Scanning...' : 'Scan Channel Repo'}
              </button>
            </div>
          </div>

          {repoReport && (
            <div style={{ marginTop: 14 }}>
              <div className="btn-row" style={{ marginBottom: 12 }}>
                <span className={`pill ${repoReport.rafReady ? 'ok' : 'err'}`}>
                  {repoReport.rafReady ? 'RAF Ready' : 'Certification Blockers'} • Score: {repoReport.score}/100
                </span>
                <span className="pill mono">{repoReport.repoPath}</span>
                <span className="pill">
                  manifest: {repoReport.filesScanned.manifestFound ? 'Yes' : 'No'} • {repoReport.filesScanned.brsFiles} .brs • {repoReport.filesScanned.xmlFiles} .xml
                </span>
              </div>

              {repoReport.findings.length === 0 ? (
                <div className="issue-item info">
                  <strong>Zero RAF static issues found.</strong> Manifest includes <span className="mono">bs_libs_required=roku_ads_lib</span>, SceneGraph Task isolation is clean, RIDA/LAT checks are present, and no Roku OS 16 runtime traps were detected.
                </div>
              ) : (
                <div className="issue-list">
                  {repoReport.findings.map((f, i) => (
                    <div key={i} className={`issue-item ${f.severity}`}>
                      <div>
                        <strong>[{f.severity.toUpperCase()}] {f.code}</strong>{' '}
                        <span className="mono muted">
                          ({f.file}{f.line ? `:${f.line}` : ''})
                        </span>
                      </div>
                      <div style={{ marginTop: 3 }}>{f.message}</div>
                      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                        <strong>Fix:</strong> {f.fixHint}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
