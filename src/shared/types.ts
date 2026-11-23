export interface RafMacroValues {
  ROKU_ADS_TRACKING_ID: string;
  ROKU_ADS_LIMIT_TRACKING: string;
  ROKU_ADS_CACHE_BUSTER: string;
  ROKU_ADS_APP_ID: string;
  ROKU_ADS_APP_VERSION: string;
  ROKU_ADS_CONTENT_ID: string;
  ROKU_ADS_CONTENT_GENRE: string;
  ROKU_ADS_CONTENT_LENGTH: string;
  ROKU_ADS_DEVICE_MODEL: string;
  ROKU_ADS_DISPLAY_WIDTH: string;
  ROKU_ADS_DISPLAY_HEIGHT: string;
  ROKU_ADS_EXTERNAL_IP: string;
}

export type RafPlaybackMode =
  | 'csai'
  | 'csai-stitched'
  | 'csai-skippable'
  | 'ssai'
  | 'ssai-live'
  | 'google-dai';

export interface RafRuntimePrefs {
  enableAdMeasurements: boolean;
  maxResolution: '720p' | '1080p' | '4k';
  useRokuAdsFallback: boolean;
  maxRequests: number;
  contentId: string;
  contentGenre: string;
  contentLengthSec: number;
  showDebugHud: boolean;
  simulateLat: boolean;
}

export const DEFAULT_RAF_RUNTIME_PREFS: RafRuntimePrefs = {
  enableAdMeasurements: true,
  maxResolution: '1080p',
  useRokuAdsFallback: false,
  maxRequests: 5,
  contentId: 'ep-101-pilot',
  contentGenre: 'Action,Science fiction',
  contentLengthSec: 1800,
  showDebugHud: true,
  simulateLat: false,
};

export interface ParsedMediaFile {
  id?: string;
  url: string;
  delivery?: string;
  type?: string;
  bitrate?: number;
  minBitrate?: number;
  maxBitrate?: number;
  width?: number;
  height?: number;
  codec?: string;
  apiFramework?: string;
  scalable?: boolean;
  rafCompatible: boolean;
  rafNotes: string[];
}

export interface ParsedTrackingEvent {
  event: string;
  url: string;
  offset?: string;
  sourceHop?: number;
}

export interface ParsedCompanionAd {
  id?: string;
  width?: number;
  height?: number;
  resourceType: 'StaticResource' | 'IFrameResource' | 'HTMLResource' | 'Unknown';
  creativeType?: string;
  url?: string;
  clickThrough?: string;
}

export interface ParsedLinearCreative {
  id?: string;
  adId?: string;
  duration?: string;
  durationSeconds?: number;
  skipOffset?: string;
  mediaFiles: ParsedMediaFile[];
  interactiveFiles: Array<{ url: string; apiFramework?: string; type?: string }>;
  trackingEvents: ParsedTrackingEvent[];
  clickThrough?: string;
  clickTracking: string[];
}

export interface ParsedAd {
  id: string;
  sequence?: number;
  adType: 'InLine' | 'Wrapper';
  adSystem?: string;
  adTitle?: string;
  vastAdTagUri?: string;
  impressions: string[];
  errors: string[];
  verifications: string[];
  extensions: string[];
  linears: ParsedLinearCreative[];
  companions: ParsedCompanionAd[];
}

export interface ParsedAdBreak {
  id?: string;
  timeOffset: string;
  breakType?: string;
  repeatAfter?: string;
  adTagUri?: string;
  templateType?: string;
  trackingEvents: ParsedTrackingEvent[];
  inlineVast?: ParsedAdTag;
}

export interface WrapperHop {
  hop: number;
  url: string;
  status: number;
  durationMs: number;
  tagType: 'VAST' | 'VMAP' | 'SMRX' | 'UNKNOWN';
  version?: string;
  isWrapper: boolean;
  nextTagUri?: string;
  impressionsCount: number;
  trackingCount: number;
  error?: string;
}

export interface ParsedAdTag {
  tagType: 'VAST' | 'VMAP' | 'SMRX' | 'UNKNOWN';
  version?: string;
  ads: ParsedAd[];
  adBreaks: ParsedAdBreak[];
  vastErrorUrls: string[];
  wrapperHops?: WrapperHop[];
}

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  location?: string;
  rafHint?: string;
}

export interface ValidationReport {
  score: number;
  validForRaf: boolean;
  expandedUrl?: string;
  unexpandedMacros: string[];
  parsed: ParsedAdTag;
  issues: ValidationIssue[];
  rawXml: string;
}

// --- HLS / MPEG-DASH Manifest Inspector ---

export interface ManifestVariant {
  url: string;
  bandwidth?: number;
  resolution?: string;
  codecs?: string;
  frameRate?: string;
}

export interface ManifestAdCue {
  type: 'DISCONTINUITY' | 'DATERANGE' | 'CUE-OUT' | 'CUE-IN' | 'SCTE35' | 'DASH_EVENT' | 'DASH_PERIOD';
  id?: string;
  startDate?: string;
  offsetSec?: number;
  durationSec?: number;
  scte35Payload?: string;
  rawLine: string;
}

export interface ManifestInspectionReport {
  format: 'HLS' | 'DASH' | 'UNKNOWN';
  isMaster: boolean;
  isLive: boolean;
  targetDuration?: number;
  mediaSequence?: number;
  segmentCount: number;
  totalDurationSec: number;
  variants: ManifestVariant[];
  adCues: ManifestAdCue[];
  issues: ValidationIssue[];
  rawText: string;
}

// --- Vendor Request Builder & Auditor ---

export type VendorId =
  | 'gam'
  | 'google-dai-vod'
  | 'google-dai-live'
  | 'springserve'
  | 'publica'
  | 'freewheel';

export interface VendorBuildParams {
  vendor: VendorId;
  networkOrSupplyId: string;
  adUnitOrProfile: string;
  cmsId?: string;
  videoId?: string;
  assetKey?: string;
  podMaxDurationSec: number;
  minAdDurationSec?: number;
  maxAdDurationSec?: number;
  outputFormat?: 'vast4' | 'vmap';
  usPrivacy: string;
  gpp?: string;
  gppSid?: string;
  coppa: boolean;
  customTargeting?: string;
  useRokuMacros: boolean;
}

export interface VendorAuditFinding {
  severity: IssueSeverity;
  param: string;
  status: 'ok' | 'missing' | 'warning';
  value?: string;
  message: string;
}

export interface VendorRequestAudit {
  detectedVendor: VendorId | 'generic-ctv';
  url: string;
  score: number;
  findings: VendorAuditFinding[];
}

// --- Beacons, Expected-vs-Actual Diff & Roku Ad Certification ---

export type BeaconEventKind =
  | 'tag_request'
  | 'impression'
  | 'quartile'
  | 'tracking'
  | 'error'
  | 'click'
  | 'vmap'
  | 'raf_telemetry'
  | 'console_log';

export interface BeaconEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  epochMs: number;
  relativeMs: number;
  kind: BeaconEventKind;
  eventName: string;
  adId?: string;
  podId?: string;
  errorCode?: string;
  errorDescription?: string;
  requestUrl: string;
  originalUrl?: string;
  method: string;
  userAgent?: string;
  remoteIp?: string;
  forwardedStatus?: number;
  details?: Record<string, unknown>;
}

export interface AdQuartileProgress {
  key: string;
  sessionId: string;
  podId: string;
  adId: string;
  impression: boolean;
  start: boolean;
  firstQuartile: boolean;
  midpoint: boolean;
  thirdQuartile: boolean;
  complete: boolean;
  skip: boolean;
  mute: boolean;
  pause: boolean;
  resume: boolean;
  error: boolean;
  lastErrorCode?: string;
  updatedAt: number;
}

export interface ExpectedBeaconSpec {
  id: string;
  sessionId: string;
  podId: string;
  adId: string;
  event: string;
  url: string;
  source: 'inline' | 'wrapper' | 'vmap' | 'ssai' | 'dai';
  wrapperHop?: number;
  expectedOffsetSec?: number;
  creativeDurationSec?: number;
}

export interface BeaconDiffItem {
  spec: ExpectedBeaconSpec;
  status: 'matched' | 'missing' | 'duplicate' | 'drifted' | 'out_of_order';
  actualCount: number;
  actualOffsetSec?: number;
  driftSec?: number;
  note?: string;
}

export interface CertCheckResult {
  id: string;
  category: 'privacy' | 'lifecycle' | 'error_handling' | 'headers' | 'timing';
  title: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface BeaconAuditReport {
  sessionId: string;
  certScore: number;
  toleranceSec: number;
  expectedCount: number;
  matchedCount: number;
  missingCount: number;
  duplicateCount: number;
  driftedCount: number;
  outOfOrderCount: number;
  unexpectedEvents: BeaconEvent[];
  diffItems: BeaconDiffItem[];
  certChecks: CertCheckResult[];
  timingMetrics?: AdTimingMetrics;
  rokuPerf8080?: RokuPerfSnapshot;
}

export interface AdTimingMetrics {
  tagFetchLatencyMs?: number;
  adTtffMs?: number;
  vodStartDurationMs?: number;
}

export interface RokuPerfSnapshot {
  ip: string;
  capturedAt: string;
  reachable: boolean;
  banner?: string;
  channelMemKib?: number;
  channelMemMb?: number;
  anonMemKib?: number;
  fileMemKib?: number;
  sharedMemKib?: number;
  cpuTotalPct?: number;
  cpuUserPct?: number;
  cpuSysPct?: number;
  textureUsedBytes?: number;
  textureMaxBytes?: number;
  textureAvailableBytes?: number;
  textureUsedMb?: number;
  textureUtilizationPct?: number;
  sgNodeCount?: number;
  error?: string;
}

export type ChaosFaultMode =
  | 'none'
  | 'latency'
  | 'http-503'
  | 'http-429'
  | 'timeout-hang'
  | 'corrupt-xml'
  | 'empty-vast-303'
  | 'drop-wrapper-hop'
  | 'media-500';

export interface ChaosConfig {
  mode: ChaosFaultMode;
  delayMs: number;
  dropAtHop: number;
}

export type RokuMediaType = 'movie' | 'episode' | 'shortFormVideo' | 'live' | 'season' | 'special';

export interface RokuAdPolicyContext {
  contentLengthSec?: number;
  mediaType?: RokuMediaType;
}

export interface ExternalChannelAttachRequest {
  ip: string;
  channelId?: string;
  contentId: string;
  mediaType: RokuMediaType;
  useInputIfRunning?: boolean;
  extraParams?: Record<string, string>;
  sessionId?: string;
}

// --- Mock Server, Live HLS & DAI ---

export type MockScenarioType =
  | 'single-preroll'
  | 'skippable-preroll'
  | 'interactive-overlay'
  | 'pod-3-ads'
  | 'vmap-schedule'
  | 'wrapper-chain'
  | 'gam-vmap-pod'
  | 'springserve-pod'
  | 'freewheel-vast'
  | 'error-no-fill'
  | 'error-media-404'
  | 'error-vpaid-only'
  | 'error-timeout'
  | 'ssai-hls'
  | 'ssai-live'
  | 'google-dai-vod'
  | 'google-dai-live'
  | 'dash-mpd';

export interface CustomMockConfig {
  id: string;
  name: string;
  scenario: MockScenarioType;
  vastVersion: '3.0' | '4.0';
  podSize: number;
  durationSec: number;
  skippableAfterSec?: number;
  wrapperDepth: number;
  delayMs: number;
  includeCompanion: boolean;
  sessionId: string;
}

export interface LiveAdCueState {
  id: string;
  sessionId: string;
  triggeredAtMs: number;
  startMediaSeq: number;
  durationSec: number;
  segmentSpan: number;
  scte35Base64: string;
  adId: string;
  podId: string;
}

// --- Roku Devices, Suite Runner & Saved Snapshots ---

export interface SavedRokuDevice {
  id: string;
  name: string;
  ip: string;
  username: string;
  password: string;
  modelName?: string;
  softwareVersion?: string;
  serialNumber?: string;
  lastSeenAt?: string;
}

export interface RokuDeviceInfo {
  ip: string;
  reachable: boolean;
  friendlyName?: string;
  modelName?: string;
  modelNumber?: string;
  serialNumber?: string;
  softwareVersion?: string;
  developerEnabled?: boolean;
  AdvertisingId?: string;
  rawXml?: string;
  error?: string;
}

export interface RokuMediaPlayerState {
  state?: string;
  position?: string;
  duration?: string;
  pluginId?: string;
  pluginName?: string;
  isLive?: boolean;
  rawXml?: string;
}

export interface RokuLaunchRequest {
  ip: string;
  channelId?: string;
  adTagUrl: string;
  contentUrl?: string;
  adMode?: RafPlaybackMode;
  ssaiMetaUrl?: string;
  daiStreamUrl?: string;
  sessionId?: string;
  useInputIfRunning?: boolean;
  rafPrefs?: Partial<RafRuntimePrefs>;
}

export interface ScreenshotRecord {
  id: string;
  sessionId: string;
  deviceIp: string;
  timestamp: string;
  mimeType: string;
  dataUrl: string;
}

export interface SessionSnapshot {
  id: string;
  name: string;
  source: 'live' | 'suite' | 'har_import';
  createdAt: string;
  sessionId: string;
  adTagUrl?: string;
  rawXmlOrManifest?: string;
  playbackMode?: RafPlaybackMode;
  rafPrefs?: RafRuntimePrefs;
  validationReport?: ValidationReport;
  manifestReport?: ManifestInspectionReport;
  expectedBeacons: ExpectedBeaconSpec[];
  events: BeaconEvent[];
  auditReport: BeaconAuditReport;
  screenshots: ScreenshotRecord[];
  notes?: string;
}

export interface SuiteCaseSpec {
  id: string;
  title: string;
  scenario: MockScenarioType;
  adMode: RafPlaybackMode;
  adTagPath: string;
  timeoutSec: number;
  expectError?: boolean;
}

export interface SuiteCaseResult {
  caseId: string;
  title: string;
  sessionId: string;
  passed: boolean;
  certScore: number;
  durationMs: number;
  beaconsFired: number;
  summary: string;
  screenshotDataUrl?: string;
}

export interface SuiteRunReport {
  id: string;
  name: string;
  deviceIp: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'aborted';
  overallScore: number;
  passedCount: number;
  totalCount: number;
  cases: SuiteCaseResult[];
}
