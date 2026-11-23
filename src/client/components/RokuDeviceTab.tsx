import React, { useEffect, useMemo, useState } from 'react';
import {
  Camera,
  CheckSquare,
  Download,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Square,
  Terminal,
  Trash2,
  Tv,
  Upload,
  Wifi,
} from 'lucide-react';
import { api } from '../api.js';
import type {
  BeaconEvent,
  RafPlaybackMode,
  RafRuntimePrefs,
  RokuDeviceInfo,
  RokuMediaPlayerState,
  RokuMediaType,
  RokuPerfSnapshot,
  SavedRokuDevice,
  ScreenshotRecord,
  SuiteCaseSpec,
  SuiteRunReport,
} from '../../shared/types.js';

interface Props {
  lanBaseUrl: string;
  sessionId: string;
  launchTagUrl: string;
  launchMode: RafPlaybackMode;
  rafPrefs: RafRuntimePrefs;
  onChangeRafPrefs: (prefs: RafRuntimePrefs) => void;
  onChangeLaunchTagUrl: (url: string) => void;
  onChangeLaunchMode: (mode: RafPlaybackMode) => void;
  events: BeaconEvent[];
  screenshots: ScreenshotRecord[];
  latestSuiteRun: SuiteRunReport | null;
}

export function RokuDeviceTab({
  lanBaseUrl,
  sessionId,
  launchTagUrl,
  launchMode,
  rafPrefs,
  onChangeRafPrefs,
  onChangeLaunchTagUrl,
  onChangeLaunchMode,
  events,
  screenshots,
  latestSuiteRun,
}: Props) {
  const [savedDevices, setSavedDevices] = useState<SavedRokuDevice[]>([]);
  const [deviceName, setDeviceName] = useState<string>('Living Room Roku');
  const [rokuIp, setRokuIp] = useState<string>('');
  const [devPassword, setDevPassword] = useState<string>('');
  const [discovering, setDiscovering] = useState<boolean>(false);
  const [deviceInfo, setDeviceInfo] = useState<RokuDeviceInfo | null>(null);
  const [playerState, setPlayerState] = useState<RokuMediaPlayerState | null>(null);
  const [devSlotTitle, setDevSlotTitle] = useState<string>('');
  const [perfSnap, setPerfSnap] = useState<RokuPerfSnapshot | null>(null);
  const [attachChannelId, setAttachChannelId] = useState<string>('dev');
  const [attachContentId, setAttachContentId] = useState<string>('ep-101-pilot');
  const [attachMediaType, setAttachMediaType] = useState<RokuMediaType>('episode');
  const [attachHotInput, setAttachHotInput] = useState<boolean>(false);
  const [consoleConnected, setConsoleConnected] = useState<boolean>(false);
  const [contentUrl, setContentUrl] = useState<string>(`${lanBaseUrl}/media/content-main.mp4`);
  const [useInputIfRunning, setUseInputIfRunning] = useState<boolean>(false);
  const [statusBanner, setStatusBanner] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  // Suite runner state
  const [suitePresets, setSuitePresets] = useState<SuiteCaseSpec[]>([]);
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const [simulateSuite, setSimulateSuite] = useState<boolean>(false);
  const [suiteHistory, setSuiteHistory] = useState<SuiteRunReport[]>([]);

  const consoleEvents = useMemo(
    () => events.filter((e) => e.kind === 'console_log' || e.kind === 'raf_telemetry').slice(-80),
    [events]
  );

  const loadRosterAndSuites = () => {
    api.listDevices().then((d) => {
      setSavedDevices(d.devices);
      if (d.devices.length > 0 && !rokuIp) {
        setRokuIp(d.devices[0].ip);
        setDeviceName(d.devices[0].name);
        setDevPassword(d.devices[0].password);
      }
    }).catch(() => {});

    api.getSuitePresets().then((p) => {
      setSuitePresets(p.cases);
      setSelectedCaseIds(p.cases.map((c) => c.id));
    }).catch(() => {});

    api.getSuiteRuns().then((r) => setSuiteHistory(r.runs)).catch(() => {});
  };

  useEffect(() => {
    loadRosterAndSuites();
  }, []);

  useEffect(() => {
    if (latestSuiteRun) {
      setSuiteHistory((prev) => [
        latestSuiteRun,
        ...prev.filter((r) => r.id !== latestSuiteRun.id),
      ]);
    }
  }, [latestSuiteRun]);

  const handleSaveDeviceToRoster = async () => {
    const saved = await api.saveDevice({
      name: deviceName,
      ip: rokuIp,
      password: devPassword,
      modelName: deviceInfo?.modelName,
      softwareVersion: deviceInfo?.softwareVersion,
      serialNumber: deviceInfo?.serialNumber,
    });
    setSavedDevices((prev) => [saved, ...prev.filter((d) => d.id !== saved.id)]);
    setStatusBanner(`Saved "${saved.name}" (${saved.ip}) to SQLite device roster.`);
  };

  const handleDiscover = async () => {
    setDiscovering(true);
    try {
      const res = await api.discoverRokus();
      if (res.devices.length > 0) {
        setRokuIp(res.devices[0].ip);
        setStatusBanner(`Discovered ${res.devices.length} Roku device(s): ${res.devices.map((d) => d.ip).join(', ')}`);
      } else {
        setStatusBanner('No Roku replied to SSDP multicast (enter IP manually).');
      }
    } finally {
      setDiscovering(false);
    }
  };

  const handleConnectDevice = async () => {
    setBusy(true);
    try {
      const res = await api.getRokuDeviceInfo(rokuIp);
      setDeviceInfo(res.info);
      setPlayerState(res.player);
      setDevSlotTitle(res.devSlot?.devAppTitle || '');
      setConsoleConnected(res.console.connected);
      api.getRokuPerf(rokuIp, sessionId).then(setPerfSnap).catch(() => {});
      if (res.info.friendlyName) setDeviceName(res.info.friendlyName);
      setStatusBanner(
        res.info.reachable
          ? `Connected to ${res.info.friendlyName} (${res.info.modelName} • OS ${res.info.softwareVersion})`
          : `Unreachable: ${res.info.error}`
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSideload = async () => {
    if (!devPassword) {
      setStatusBanner('Enter Roku Developer password before sideloading.');
      return;
    }
    setBusy(true);
    setStatusBanner('Packaging 4-mode Roku harness and sideloading...');
    try {
      const res = await api.sideloadChannel({ ip: rokuIp, password: devPassword, serverUrl: lanBaseUrl });
      setStatusBanner(res.message);
    } catch (err) {
      setStatusBanner(`Sideload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleCaptureScreenshot = async () => {
    if (!devPassword) {
      setStatusBanner('Enter Roku Developer password to capture /plugin_inspect screenshots.');
      return;
    }
    setBusy(true);
    try {
      await api.captureScreenshot({ ip: rokuIp, password: devPassword, sessionId });
      setStatusBanner('Captured Roku screen image!');
    } catch (err) {
      setStatusBanner(`Screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleLaunchTest = async () => {
    setBusy(true);
    try {
      const ssaiMetaUrl =
        launchMode === 'ssai'
          ? `${lanBaseUrl}/mock/ssai/raf-metadata.json?session=${sessionId}`
          : launchMode === 'ssai-live'
            ? `${lanBaseUrl}/mock/live/raf-metadata.json?session=${sessionId}`
            : undefined;

      const res = await api.launchOnRoku({
        ip: rokuIp,
        adTagUrl: launchTagUrl,
        contentUrl: launchMode === 'ssai' || launchMode === 'ssai-live' ? launchTagUrl : contentUrl,
        adMode: launchMode,
        ssaiMetaUrl,
        sessionId,
        useInputIfRunning,
        rafPrefs,
      });
      setStatusBanner(`Launched [${launchMode}] on Roku (HTTP ${res.status})`);
    } catch (err) {
      setStatusBanner(`Launch failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleStartSuite = async () => {
    try {
      const run = await api.startSuite({
        deviceIp: rokuIp,
        password: devPassword || undefined,
        captureScreenshots: Boolean(devPassword && !simulateSuite),
        simulateWithoutDevice: simulateSuite,
        caseIds: selectedCaseIds,
        rafPrefs,
      });
      setStatusBanner(`Started Automated Certification Suite "${run.name}"`);
    } catch (err) {
      setStatusBanner(`Suite error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const toggleConsole = async () => {
    try {
      if (consoleConnected) {
        await api.disconnectConsole();
        setConsoleConnected(false);
      } else {
        const res = await api.connectConsole(rokuIp, sessionId);
        setConsoleConnected(res.connected);
      }
    } catch (err) {
      setStatusBanner(`Port 8085 error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const pressKey = (key: string) => {
    api.sendKeypress(rokuIp, key).catch(() => {});
  };

  const activeSuite = latestSuiteRun ?? suiteHistory[0] ?? null;

  return (
    <div className="grid-sidebar">
      {/* Left Column: Multi-Device Roster, Sideload, Screenshots & Remote */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">
              <Tv size={16} /> Multi-Roku Device Roster & Sideloader
            </h2>
            <button className="btn btn-sm" disabled={discovering} onClick={handleDiscover}>
              <Wifi size={13} /> {discovering ? 'Scanning...' : 'SSDP'}
            </button>
          </div>

          {savedDevices.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div className="muted" style={{ fontSize: 11.5, marginBottom: 5 }}>Saved Devices:</div>
              <div className="issue-list">
                {savedDevices.map((d) => (
                  <div
                    key={d.id}
                    className="issue-item"
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px' }}
                  >
                    <div
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        setDeviceName(d.name);
                        setRokuIp(d.ip);
                        setDevPassword(d.password);
                      }}
                    >
                      <strong>{d.name}</strong> <span className="mono muted">({d.ip})</span>
                    </div>
                    <button
                      className="btn btn-sm"
                      onClick={() =>
                        api.deleteDevice(d.id).then(() => setSavedDevices((p) => p.filter((x) => x.id !== d.id)))
                      }
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid-2">
            <div className="field">
              <label>Device Label</label>
              <input type="text" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
            </div>
            <div className="field">
              <label>Roku LAN IP</label>
              <input type="text" value={rokuIp} onChange={(e) => setRokuIp(e.target.value)} className="mono" />
            </div>
          </div>

          <div className="field">
            <label>Developer Password (for Sideload & Screenshots)</label>
            <input type="password" value={devPassword} onChange={(e) => setDevPassword(e.target.value)} />
          </div>

          <div className="btn-row" style={{ marginBottom: 10 }}>
            <button className="btn btn-sm" onClick={handleConnectDevice}>
              <RefreshCw size={12} /> Query ECP
            </button>
            <button className="btn btn-sm" onClick={handleSaveDeviceToRoster}>
              <Plus size={12} /> Save to Roster
            </button>
            <button className="btn btn-sm" onClick={handleCaptureScreenshot}>
              <Camera size={12} /> Screenshot
            </button>
          </div>

          {deviceInfo?.reachable && (
            <div className="issue-item info" style={{ marginBottom: 10, fontSize: 12 }}>
              <strong>{deviceInfo.friendlyName}</strong> ({deviceInfo.modelName}) • OS {deviceInfo.softwareVersion}
              {playerState?.state && <div className="mono muted">Player: {playerState.state} {playerState.position ?? ''}</div>}
            </div>
          )}

          <div className="btn-row">
            <button className="btn btn-primary" disabled={busy} onClick={handleSideload}>
              <Upload size={13} /> Sideload v2 Harness
            </button>
            <a
              className="btn"
              href={`/api/channel/package.zip?serverUrl=${encodeURIComponent(lanBaseUrl)}`}
              download="roku-raf-harness.zip"
            >
              <Download size={13} /> Download .zip
            </a>
          </div>

          {devSlotTitle && (
            <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              Current <span className="mono">dev</span> slot channel: <strong>{devSlotTitle}</strong>
            </div>
          )}
        </div>

        {/* :8080 Channel RAM, Texture VRAM & CPU Profiler */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Roku OS :8080 Memory & Texture VRAM Profiler</h3>
            <button
              className="btn btn-sm"
              disabled={!rokuIp}
              onClick={() =>
                api
                  .getRokuPerf(rokuIp, sessionId)
                  .then((p) => {
                    setPerfSnap(p);
                    const ramLabel = p.channelMemMb !== undefined ? `${p.channelMemMb} MB` : 'Idle (Home)';
                    const cpuLabel = p.cpuTotalPct !== undefined ? `${p.cpuTotalPct}%` : 'Idle';
                    setStatusBanner(
                      p.reachable
                        ? `Sampled :8080 — RAM ${ramLabel} | VRAM ${p.textureUsedMb ?? 0} MB (${p.textureUtilizationPct ?? 0}%) | CPU ${cpuLabel}`
                        : `Port :8080 unreachable: ${p.error}`
                    );
                  })
                  .catch((e) => setStatusBanner(e instanceof Error ? e.message : String(e)))
              }
            >
              <RefreshCw size={12} /> Sample :8080
            </button>
          </div>
          {perfSnap?.reachable ? (
            <div className="btn-row" style={{ flexWrap: 'wrap' }}>
              <span className="pill ok mono">
                RAM: {perfSnap.channelMemMb !== undefined ? `${perfSnap.channelMemMb} MB` : 'Idle (Home)'}
              </span>
              <span className={`pill mono ${(perfSnap.textureUtilizationPct ?? 0) > 85 ? 'warn' : 'ok'}`}>
                VRAM: {perfSnap.textureUsedMb ?? 0} MB ({perfSnap.textureUtilizationPct ?? 0}%)
              </span>
              <span className="pill mono">
                CPU: {perfSnap.cpuTotalPct !== undefined ? `${perfSnap.cpuTotalPct}%` : 'Idle'}
              </span>
              <span className="pill mono">
                SG Nodes: {perfSnap.sgNodeCount !== undefined ? perfSnap.sgNodeCount : 'Idle'}
              </span>
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 12 }}>
              Click <strong>Sample :8080</strong> during ad playback to inspect live SceneGraph RAM, GPU texture VRAM headroom, and CPU load.
            </div>
          )}
        </div>

        {/* Captured Screenshots Gallery */}
        {screenshots.length > 0 && (
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Captured Roku Screenshots ({screenshots.length})</h3>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {screenshots.slice(-3).reverse().map((s) => (
                <div key={s.id}>
                  <img
                    src={s.dataUrl}
                    alt="Roku screen capture"
                    style={{ width: '100%', borderRadius: 6, border: '1px solid var(--border)' }}
                  />
                  <div className="mono muted" style={{ fontSize: 11 }}>{s.deviceIp} • {s.timestamp}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ECP Virtual Remote */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">ECP Virtual Remote (:8060)</h3>
          </div>
          <div className="btn-row" style={{ justifyContent: 'center' }}>
            <button className="btn btn-sm" onClick={() => pressKey('Back')}>Back</button>
            <button className="btn btn-sm" onClick={() => pressKey('Home')}>Home</button>
            <button className="btn btn-sm" onClick={() => pressKey('Info')}>HUD (*)</button>
          </div>
          <div className="remote-pad">
            <div />
            <button className="btn" onClick={() => pressKey('Up')}>▲</button>
            <div />
            <button className="btn" onClick={() => pressKey('Left')}>◀</button>
            <button className="btn btn-primary" onClick={() => pressKey('Select')}>OK</button>
            <button className="btn" onClick={() => pressKey('Right')}>▶</button>
            <div />
            <button className="btn" onClick={() => pressKey('Down')}>▼</button>
            <div />
          </div>
          <div className="btn-row" style={{ justifyContent: 'center' }}>
            <button className="btn btn-sm" onClick={() => pressKey('Rev')}>⏪ Mode</button>
            <button className="btn btn-sm" onClick={() => pressKey('Play')}>⏯ Bookmarks</button>
            <button className="btn btn-sm" onClick={() => pressKey('Fwd')}>⏩ Mode</button>
          </div>
        </div>
      </div>

      {/* Right Column: 4-Mode Launcher + Runtime Prefs + Automated Suite Runner + :8085 Console */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {statusBanner && (
          <div className="issue-item info">
            <strong>Status:</strong> {statusBanner}
          </div>
        )}

        {/* 4-Mode Deep-Link Launcher & Runtime RAF Settings */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              <Tv size={16} /> Attach & Deep-Link Your Own Channel (Zero-Sideload Cert 4.x Tester)
            </h3>
          </div>
          <div className="grid-2">
            <div className="field">
              <label>Target Channel ID (keeps your dev slot intact)</label>
              <input
                type="text"
                className="mono"
                value={attachChannelId}
                onChange={(e) => setAttachChannelId(e.target.value)}
                placeholder="dev"
              />
            </div>
            <div className="field">
              <label>Deep-Link mediaType (Roku Cert 4.1)</label>
              <select
                value={attachMediaType}
                onChange={(e) => setAttachMediaType(e.target.value as RokuMediaType)}
              >
                <option value="episode">episode</option>
                <option value="movie">movie</option>
                <option value="shortFormVideo">shortFormVideo</option>
                <option value="live">live</option>
                <option value="season">season</option>
                <option value="special">special</option>
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              style={{ flex: 1 }}
              value={attachContentId}
              onChange={(e) => setAttachContentId(e.target.value)}
              placeholder="contentId (e.g. ep-101-pilot)"
            />
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={attachHotInput}
                onChange={(e) => setAttachHotInput(e.target.checked)}
              />
              Warm /input
            </label>
            <button
              className="btn btn-primary"
              disabled={!rokuIp || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const res = await api.attachExternalChannel({
                    ip: rokuIp,
                    channelId: attachChannelId || 'dev',
                    contentId: attachContentId || 'ep-101',
                    mediaType: attachMediaType,
                    useInputIfRunning: attachHotInput,
                    sessionId,
                  });
                  setConsoleConnected(true);
                  setStatusBanner(
                    `Attached :8085 & launched ${res.activeDevAppTitle || attachChannelId} (HTTP ${res.status})`
                  );
                } catch (e) {
                  setStatusBanner(`Attach error: ${e instanceof Error ? e.message : String(e)}`);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Play size={13} /> Attach & Launch Channel
            </button>
          </div>
        </div>

        {/* 5-Mode Deep-Link Launcher & Runtime RAF Settings */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              <Play size={16} /> 5-Mode RAF Deep-Link Launcher & Runtime Settings
            </h3>
          </div>

          <div className="grid-2">
            <div className="field">
              <label>RAF Playback API Mode</label>
              <select
                value={launchMode}
                onChange={(e) => onChangeLaunchMode(e.target.value as RafPlaybackMode)}
              >
                <option value="csai">1. Standard CSAI — raf.getAds() + raf.showAds()</option>
                <option value="csai-stitched">2. Client-Stitched Pod — raf.constructStitchedStream()</option>
                <option value="csai-skippable">2b. Custom SceneGraph Skippable UI (skipoffset + OK Skip)</option>
                <option value="ssai">3. SSAI VOD HLS — raf.stitchedAdsInit()</option>
                <option value="ssai-live">3b. SSAI Live Linear HLS (polls cued SCTE-35 breaks)</option>
                <option value="google-dai">4. Google DAI Stream Session Bootstrap (POST)</option>
              </select>
            </div>
            <div className="field">
              <label>Max Video Decode Resolution (raf.setMaxVideoDecodeResolution)</label>
              <select
                value={rafPrefs.maxResolution}
                onChange={(e) =>
                  onChangeRafPrefs({
                    ...rafPrefs,
                    maxResolution: e.target.value as RafRuntimePrefs['maxResolution'],
                  })
                }
              >
                <option value="720p">720p HD (1280x720)</option>
                <option value="1080p">1080p FHD (1920x1080)</option>
                <option value="4k">4K UHD (3840x2160)</option>
              </select>
            </div>
          </div>

          <div className="grid-2">
            <div className="field">
              <label>Content ID (raf.setContentId)</label>
              <input
                type="text"
                value={rafPrefs.contentId}
                onChange={(e) => onChangeRafPrefs({ ...rafPrefs, contentId: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Content Genre (raf.setContentGenre)</label>
              <input
                type="text"
                value={rafPrefs.contentGenre}
                onChange={(e) => onChangeRafPrefs({ ...rafPrefs, contentGenre: e.target.value })}
              />
            </div>
          </div>

          <div className="btn-row" style={{ marginBottom: 12 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={rafPrefs.enableAdMeasurements}
                onChange={(e) => onChangeRafPrefs({ ...rafPrefs, enableAdMeasurements: e.target.checked })}
              />
              enableAdMeasurements(true)
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={rafPrefs.showDebugHud}
                onChange={(e) => onChangeRafPrefs({ ...rafPrefs, showDebugHud: e.target.checked })}
              />
              Show Transparent On-TV RAF HUD
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={rafPrefs.useRokuAdsFallback}
                onChange={(e) => onChangeRafPrefs({ ...rafPrefs, useRokuAdsFallback: e.target.checked })}
              />
              setAdPrefs Fallback Ads
            </label>
          </div>

          <div className="field">
            <label>Ad Tag / SSAI / DAI URL</label>
            <input
              type="text"
              className="mono"
              value={launchTagUrl}
              onChange={(e) => onChangeLaunchTagUrl(e.target.value)}
            />
          </div>

          {(launchMode === 'csai' || launchMode === 'csai-stitched' || launchMode === 'csai-skippable') && (
            <div className="field">
              <label>Content Video URL</label>
              <input type="text" value={contentUrl} onChange={(e) => setContentUrl(e.target.value)} />
            </div>
          )}

          <div className="btn-row" style={{ justifyContent: 'space-between' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={useInputIfRunning}
                onChange={(e) => setUseInputIfRunning(e.target.checked)}
              />
              Hot-swap via ECP <span className="mono">/input</span> (when harness channel is already open)
            </label>
            <button className="btn btn-primary" disabled={busy || !launchTagUrl.trim()} onClick={handleLaunchTest}>
              <Play size={14} /> Push & Play on Roku ({rokuIp})
            </button>
          </div>
        </div>

        {/* Automated Certification Suite Runner */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              <CheckSquare size={16} /> Automated Scenario Suite Runner & Certification Scorecard
            </h3>
            <div className="btn-row">
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={simulateSuite}
                  onChange={(e) => setSimulateSuite(e.target.checked)}
                />
                Simulate Player (run without physical Roku)
              </label>
              {activeSuite?.status === 'running' ? (
                <button className="btn btn-sm" onClick={() => api.abortSuite()}>
                  <Square size={12} /> Abort Suite
                </button>
              ) : (
                <button
                  className="btn btn-sm btn-primary"
                  disabled={selectedCaseIds.length === 0}
                  onClick={handleStartSuite}
                >
                  <Play size={12} /> Run {selectedCaseIds.length}-Case Suite
                </button>
              )}
            </div>
          </div>

          <div className="btn-row" style={{ marginBottom: 12 }}>
            {suitePresets.map((c) => {
              const checked = selectedCaseIds.includes(c.id);
              return (
                <label
                  key={c.id}
                  className="pill"
                  style={{ cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) =>
                      setSelectedCaseIds((prev) =>
                        e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id)
                      )
                    }
                  />
                  {c.title}
                </label>
              );
            })}
          </div>

          {activeSuite && (
            <div>
              <div className="btn-row" style={{ marginBottom: 8 }}>
                <span className={`pill ${activeSuite.overallScore >= 85 ? 'ok' : 'warn'}`}>
                  Overall Cert Score: {activeSuite.overallScore}/100
                </span>
                <span className="pill mono">
                  Status: {activeSuite.status.toUpperCase()} ({activeSuite.passedCount}/{activeSuite.totalCount} passed)
                </span>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Result</th>
                      <th>Scenario</th>
                      <th>Cert Score</th>
                      <th>Beacons</th>
                      <th>Summary</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeSuite.cases.map((c) => (
                      <tr key={c.caseId}>
                        <td>
                          <span className={`pill ${c.passed ? 'ok' : 'err'}`}>
                            {c.passed ? 'PASS' : 'FAIL'}
                          </span>
                        </td>
                        <td>{c.title}</td>
                        <td className="mono">{c.certScore}/100</td>
                        <td className="mono">{c.beaconsFired}</td>
                        <td className="muted">{c.summary}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Port 8085 Console */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              <Terminal size={16} /> Port 8085 BrightScript Console & On-Device RAF Telemetry
            </h3>
            <button className={`btn btn-sm ${consoleConnected ? 'btn-primary' : ''}`} onClick={toggleConsole}>
              <Radio size={13} /> {consoleConnected ? 'Disconnect :8085' : 'Connect :8085'}
            </button>
          </div>
          <div className="code-box" style={{ minHeight: 200, maxHeight: 340, overflowY: 'auto' }}>
            {consoleEvents.length === 0 ? (
              <span className="muted">No console or RAF telemetry lines yet.</span>
            ) : (
              consoleEvents.map((ev) => (
                <div key={ev.id} style={{ marginBottom: 4 }}>
                  <span className="muted">[{new Date(ev.epochMs).toLocaleTimeString()}]</span>{' '}
                  <strong style={{ color: ev.kind === 'raf_telemetry' ? '#a78bfa' : '#38bdf8' }}>
                    {ev.eventName}
                  </strong>{' '}
                  {ev.details?.line ? String(ev.details.line) : JSON.stringify(ev.details)}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
