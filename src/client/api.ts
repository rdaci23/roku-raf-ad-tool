import type { RepoScanReport } from '../shared/repoScanner.js';
import type {
  AdQuartileProgress,
  BeaconAuditReport,
  BeaconEvent,
  ChaosConfig,
  CustomMockConfig,
  ExternalChannelAttachRequest,
  LiveAdCueState,
  ManifestInspectionReport,
  RafMacroValues,
  RafPlaybackMode,
  RafRuntimePrefs,
  RokuAdPolicyContext,
  RokuDeviceInfo,
  RokuLaunchRequest,
  RokuMediaPlayerState,
  RokuPerfSnapshot,
  SavedRokuDevice,
  ScreenshotRecord,
  SessionSnapshot,
  SuiteCaseSpec,
  SuiteRunReport,
  ValidationReport,
  VendorBuildParams,
  VendorRequestAudit,
} from '../shared/types.js';

export interface ServerInfoResponse {
  lanIp: string;
  port: number;
  lanBaseUrl: string;
  defaultMacros: RafMacroValues;
  defaultRafPrefs: RafRuntimePrefs;
  consoleStatus: { connected: boolean; ip: string | null };
  activeSuiteRun: SuiteRunReport | null;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.error || data?.message || `HTTP ${resp.status}`);
  }
  return data as T;
}

export const api = {
  getInfo: () => requestJson<ServerInfoResponse>('/api/info'),

  validate: (payload: {
    xml?: string;
    url?: string;
    macros?: Partial<RafMacroValues>;
    policy?: RokuAdPolicyContext;
  }) =>
    requestJson<ValidationReport>('/api/validate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getChaos: () => requestJson<ChaosConfig>('/api/chaos'),

  setChaos: (cfg: Partial<ChaosConfig>) =>
    requestJson<ChaosConfig>('/api/chaos', {
      method: 'POST',
      body: JSON.stringify(cfg),
    }),

  inspectManifest: (payload: { text?: string; url?: string }) =>
    requestJson<ManifestInspectionReport>('/api/inspect-manifest', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  buildVendorUrl: (params: VendorBuildParams, useLocalMock: boolean) =>
    requestJson<{
      requestUrl: string;
      method: 'GET' | 'POST';
      postBody?: Record<string, string>;
      audit: VendorRequestAudit;
    }>('/api/vendor/build', {
      method: 'POST',
      body: JSON.stringify({ params, useLocalMock }),
    }),

  auditVendorUrl: (url: string) =>
    requestJson<VendorRequestAudit>('/api/vendor/audit', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  generateBrsSnippet: (payload: {
    mode: RafPlaybackMode;
    adTagOrStreamUrl: string;
    contentUrl?: string;
    ssaiMetaUrl?: string;
    prefs?: Partial<RafRuntimePrefs>;
  }) =>
    requestJson<{ code: string }>('/api/vendor/brs-snippet', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  scanRepo: (repoPath?: string) =>
    requestJson<RepoScanReport>('/api/scan-repo', {
      method: 'POST',
      body: JSON.stringify({ repoPath }),
    }),

  getBeacons: (session?: string) =>
    requestJson<{
      events: BeaconEvent[];
      progress: AdQuartileProgress[];
      screenshots: ScreenshotRecord[];
    }>(`/api/beacons${session ? `?session=${encodeURIComponent(session)}` : ''}`),

  getAudit: (session: string, toleranceSec = 1.5, simulateLat = false) =>
    requestJson<BeaconAuditReport>(
      `/api/audit?session=${encodeURIComponent(session)}&toleranceSec=${toleranceSec}&simulateLat=${
        simulateLat ? '1' : '0'
      }`
    ),

  clearBeacons: (sessionId?: string) =>
    requestJson<{ cleared: boolean }>('/api/beacons/clear', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }),

  simulateBeacons: (payload: {
    sessionId?: string;
    adId?: string;
    podId?: string;
    includeError?: boolean;
  }) =>
    requestJson<{ simulated: number; events: BeaconEvent[]; progress: AdQuartileProgress[] }>(
      '/api/beacons/simulate',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),

  getCustomMocks: () => requestJson<{ customMocks: CustomMockConfig[] }>('/api/mocks'),

  saveCustomMock: (cfg: Partial<CustomMockConfig>) =>
    requestJson<CustomMockConfig>('/api/mocks', {
      method: 'POST',
      body: JSON.stringify(cfg),
    }),

  deleteCustomMock: (id: string) =>
    requestJson<{ deleted: string }>(`/api/mocks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  getLiveState: (session: string) =>
    requestJson<{
      mediaSequence: number;
      cues: LiveAdCueState[];
      masterUrl: string;
      playlistUrl: string;
      metaUrl: string;
    }>(`/api/live/state?session=${encodeURIComponent(session)}`),

  cueLiveBreak: (sessionId: string, durationSec: number) =>
    requestJson<{ cue: LiveAdCueState }>('/api/live/cue-break', {
      method: 'POST',
      body: JSON.stringify({ sessionId, durationSec }),
    }),

  listDevices: () => requestJson<{ devices: SavedRokuDevice[] }>('/api/devices'),

  saveDevice: (dev: Partial<SavedRokuDevice>) =>
    requestJson<SavedRokuDevice>('/api/devices', {
      method: 'POST',
      body: JSON.stringify(dev),
    }),

  deleteDevice: (id: string) =>
    requestJson<{ deleted: string }>(`/api/devices/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  discoverRokus: () =>
    requestJson<{ devices: Array<{ ip: string; location: string }> }>('/api/roku/discover'),

  getRokuDeviceInfo: (ip: string) =>
    requestJson<{
      info: RokuDeviceInfo;
      player: RokuMediaPlayerState | null;
      devSlot?: {
        hasDevApp: boolean;
        devAppTitle?: string;
        devAppVersion?: string;
        activeAppTitle?: string;
        isOurHarness: boolean;
      } | null;
      console: { connected: boolean; ip: string | null };
    }>(`/api/roku/device-info?ip=${encodeURIComponent(ip)}`),

  getRokuPerf: (ip: string, sessionId?: string) =>
    requestJson<RokuPerfSnapshot>(
      `/api/roku/perf?ip=${encodeURIComponent(ip)}${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ''}`
    ),

  attachExternalChannel: (payload: ExternalChannelAttachRequest) =>
    requestJson<{ endpoint: string; status: number; activeDevAppTitle?: string }>('/api/roku/attach', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  sendKeypress: (ip: string, key: string) =>
    requestJson<{ ok: boolean }>('/api/roku/keypress', {
      method: 'POST',
      body: JSON.stringify({ ip, key }),
    }),

  launchOnRoku: (payload: RokuLaunchRequest) =>
    requestJson<{ endpoint: string; status: number }>('/api/roku/launch', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  sideloadChannel: (payload: {
    ip: string;
    username?: string;
    password: string;
    serverUrl?: string;
  }) =>
    requestJson<{ ok: boolean; status: number; message: string }>('/api/roku/sideload', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  captureScreenshot: (payload: {
    ip: string;
    username?: string;
    password: string;
    sessionId?: string;
  }) =>
    requestJson<ScreenshotRecord>('/api/roku/screenshot', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  connectConsole: (ip: string, sessionId?: string) =>
    requestJson<{ connected: boolean; ip: string }>('/api/roku/console/connect', {
      method: 'POST',
      body: JSON.stringify({ ip, sessionId }),
    }),

  disconnectConsole: () =>
    requestJson<{ connected: boolean; ip: string | null }>('/api/roku/console/disconnect', {
      method: 'POST',
    }),

  getSuitePresets: () => requestJson<{ cases: SuiteCaseSpec[] }>('/api/suite/presets'),

  getSuiteRuns: () =>
    requestJson<{ activeRun: SuiteRunReport | null; runs: SuiteRunReport[] }>('/api/suite/runs'),

  startSuite: (payload: {
    name?: string;
    deviceIp: string;
    password?: string;
    captureScreenshots?: boolean;
    simulateWithoutDevice?: boolean;
    caseIds?: string[];
    rafPrefs?: Partial<RafRuntimePrefs>;
  }) =>
    requestJson<SuiteRunReport>('/api/suite/start', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  abortSuite: () =>
    requestJson<{ aborted: boolean }>('/api/suite/abort', {
      method: 'POST',
    }),

  listSnapshots: () =>
    requestJson<{
      snapshots: Array<{
        id: string;
        name: string;
        source: string;
        sessionId: string;
        createdAt: string;
        certScore: number;
        eventCount: number;
        screenshotCount: number;
      }>;
    }>('/api/snapshots'),

  getSnapshot: (id: string) =>
    requestJson<SessionSnapshot>(`/api/snapshots/${encodeURIComponent(id)}`),

  saveSnapshot: (payload: {
    name?: string;
    sessionId?: string;
    notes?: string;
    adTagUrl?: string;
  }) =>
    requestJson<SessionSnapshot>('/api/snapshots', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  importHar: (harJson: string, name?: string) =>
    requestJson<SessionSnapshot>('/api/snapshots/import-har', {
      method: 'POST',
      body: JSON.stringify({ harJson, name }),
    }),

  importSnapshotJson: (snapshot: SessionSnapshot) =>
    requestJson<SessionSnapshot>('/api/snapshots/import-json', {
      method: 'POST',
      body: JSON.stringify({ snapshot }),
    }),

  deleteSnapshot: (id: string) =>
    requestJson<{ deleted: string }>(`/api/snapshots/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
};
