import React, { useEffect, useState } from 'react';
import {
  Activity,
  Archive,
  CheckCircle2,
  FileCode2,
  Radio,
  Server,
  Tv,
} from 'lucide-react';
import { api, type ServerInfoResponse } from './api.js';
import {
  DEFAULT_RAF_RUNTIME_PREFS,
  type AdQuartileProgress,
  type BeaconEvent,
  type RafPlaybackMode,
  type RafRuntimePrefs,
  type ScreenshotRecord,
  type SuiteRunReport,
} from '../shared/types.js';
import { ValidatorTab } from './components/ValidatorTab.js';
import { MockServerTab } from './components/MockServerTab.js';
import { BeaconDebuggerTab } from './components/BeaconDebuggerTab.js';
import { RokuDeviceTab } from './components/RokuDeviceTab.js';
import { SessionsTab } from './components/SessionsTab.js';

export type TabKey = 'validator' | 'mock' | 'beacons' | 'roku' | 'sessions';

export function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('validator');
  const [serverInfo, setServerInfo] = useState<ServerInfoResponse | null>(null);
  const [sessionId, setSessionId] = useState<string>('roku-tv');
  const [events, setEvents] = useState<BeaconEvent[]>([]);
  const [progress, setProgress] = useState<AdQuartileProgress[]>([]);
  const [screenshots, setScreenshots] = useState<ScreenshotRecord[]>([]);
  const [latestSuiteRun, setLatestSuiteRun] = useState<SuiteRunReport | null>(null);
  const [sseConnected, setSseConnected] = useState<boolean>(false);

  // Shared cross-tab states
  const [validatorTargetUrl, setValidatorTargetUrl] = useState<string>('');
  const [rokuLaunchTagUrl, setRokuLaunchTagUrl] = useState<string>('');
  const [rokuLaunchMode, setRokuLaunchMode] = useState<RafPlaybackMode>('csai');
  const [rafPrefs, setRafPrefs] = useState<RafRuntimePrefs>(DEFAULT_RAF_RUNTIME_PREFS);

  useEffect(() => {
    api
      .getInfo()
      .then((info) => {
        setServerInfo(info);
        setRafPrefs(info.defaultRafPrefs);
        if (info.activeSuiteRun) setLatestSuiteRun(info.activeSuiteRun);
        const defaultTag = `${info.lanBaseUrl}/mock/vast/pod-3-ads.xml?session=roku-tv`;
        setValidatorTargetUrl(defaultTag);
        setRokuLaunchTagUrl(defaultTag);
      })
      .catch(() => {});

    api
      .getBeacons()
      .then((data) => {
        setEvents(data.events);
        setProgress(data.progress);
        setScreenshots(data.screenshots ?? []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const es = new EventSource('/api/events/stream');
    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);
    es.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data);
        if (parsed.type === 'beacon' && parsed.event) {
          setEvents((prev) => [...prev.slice(-999), parsed.event as BeaconEvent]);
          if (Array.isArray(parsed.progress)) {
            setProgress((prev) => {
              const map = new Map(prev.map((p) => [p.key, p]));
              for (const item of parsed.progress as AdQuartileProgress[]) {
                map.set(item.key, item);
              }
              return Array.from(map.values());
            });
          }
        } else if (parsed.type === 'screenshot' && parsed.screenshot) {
          setScreenshots((prev) => [...prev.slice(-19), parsed.screenshot as ScreenshotRecord]);
        } else if (parsed.type === 'suite_update' && parsed.run) {
          setLatestSuiteRun(parsed.run as SuiteRunReport);
        } else if (parsed.type === 'cleared') {
          if (!parsed.sessionId || parsed.sessionId === 'all') {
            setEvents([]);
            setProgress([]);
            setScreenshots([]);
          } else {
            setEvents((prev) => prev.filter((e) => e.sessionId !== parsed.sessionId));
            setProgress((prev) => prev.filter((p) => p.sessionId !== parsed.sessionId));
            setScreenshots((prev) => prev.filter((s) => s.sessionId !== parsed.sessionId));
          }
        }
      } catch {
        // ignore malformed SSE message
      }
    };
    return () => es.close();
  }, []);

  const lanBaseUrl = serverInfo?.lanBaseUrl ?? 'http://127.0.0.1:4321';

  const handleInspectTagInValidator = (url: string) => {
    setValidatorTargetUrl(url);
    setActiveTab('validator');
  };

  const handleSendTagToRoku = (url: string, mode: RafPlaybackMode = 'csai') => {
    setRokuLaunchTagUrl(url);
    setRokuLaunchMode(mode);
    setActiveTab('roku');
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-badge">RAF</div>
          <div>
            <h1>Roku RAF Ad Tool</h1>
            <p>
              VAST/VMAP/HLS/DASH • GAM, DAI, SpringServe, Publica & FreeWheel • Beacon Diff & Cert Audit • 4-Mode Roku Harness
            </p>
          </div>
        </div>

        <div className="status-strip">
          <span className="pill mono" title="LAN URL reachable by Roku devices on your network">
            <Server size={13} /> LAN Host: {lanBaseUrl}
          </span>
          <span className={`pill ${sseConnected ? 'ok' : 'warn'}`}>
            <Radio size={13} /> {sseConnected ? 'Live SSE Connected' : 'Reconnecting...'}
          </span>
          <span className="pill mono">
            Active Session:
            <input
              type="text"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              style={{ width: 115, padding: '2px 6px', marginLeft: 4 }}
            />
          </span>
        </div>
      </header>

      <nav className="nav-tabs">
        <button
          className={`nav-tab ${activeTab === 'validator' ? 'active' : ''}`}
          onClick={() => setActiveTab('validator')}
        >
          <CheckCircle2 size={16} /> 1. Validator & Vendor Builder
        </button>
        <button
          className={`nav-tab ${activeTab === 'mock' ? 'active' : ''}`}
          onClick={() => setActiveTab('mock')}
        >
          <FileCode2 size={16} /> 2. Live Mock, SSAI & DAI Studio
        </button>
        <button
          className={`nav-tab ${activeTab === 'beacons' ? 'active' : ''}`}
          onClick={() => setActiveTab('beacons')}
        >
          <Activity size={16} /> 3. Beacon Diff & Cert Auditor
          {events.length > 0 && <span className="badge-count">{events.length}</span>}
        </button>
        <button
          className={`nav-tab ${activeTab === 'roku' ? 'active' : ''}`}
          onClick={() => setActiveTab('roku')}
        >
          <Tv size={16} /> 4. Roku Roster & Suite Runner
          {latestSuiteRun?.status === 'running' && <span className="badge-count">RUN</span>}
        </button>
        <button
          className={`nav-tab ${activeTab === 'sessions' ? 'active' : ''}`}
          onClick={() => setActiveTab('sessions')}
        >
          <Archive size={16} /> 5. Sessions & HAR Reports
        </button>
      </nav>

      <main className="workspace">
        {activeTab === 'validator' && (
          <ValidatorTab
            lanBaseUrl={lanBaseUrl}
            sessionId={sessionId}
            initialUrl={validatorTargetUrl}
            defaultMacros={serverInfo?.defaultMacros}
            rafPrefs={rafPrefs}
            onSendToRoku={handleSendTagToRoku}
          />
        )}

        {activeTab === 'mock' && (
          <MockServerTab
            lanBaseUrl={lanBaseUrl}
            sessionId={sessionId}
            onInspectTag={handleInspectTagInValidator}
            onSendToRoku={handleSendTagToRoku}
          />
        )}

        {activeTab === 'beacons' && (
          <BeaconDebuggerTab
            lanBaseUrl={lanBaseUrl}
            sessionId={sessionId}
            events={events}
            progress={progress}
            onRefresh={() => {
              api.getBeacons().then((d) => {
                setEvents(d.events);
                setProgress(d.progress);
                setScreenshots(d.screenshots ?? []);
              });
            }}
            onSendToRoku={handleSendTagToRoku}
            onGoToSnapshots={() => setActiveTab('sessions')}
          />
        )}

        {activeTab === 'roku' && (
          <RokuDeviceTab
            lanBaseUrl={lanBaseUrl}
            sessionId={sessionId}
            launchTagUrl={rokuLaunchTagUrl}
            launchMode={rokuLaunchMode}
            rafPrefs={rafPrefs}
            onChangeRafPrefs={setRafPrefs}
            onChangeLaunchTagUrl={setRokuLaunchTagUrl}
            onChangeLaunchMode={setRokuLaunchMode}
            events={events}
            screenshots={screenshots}
            latestSuiteRun={latestSuiteRun}
          />
        )}

        {activeTab === 'sessions' && (
          <SessionsTab
            sessionId={sessionId}
            activeTagUrl={rokuLaunchTagUrl}
          />
        )}
      </main>
    </div>
  );
}
