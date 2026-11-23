import { randomUUID } from 'node:crypto';
import { generateSsaiRafMetadata } from '../shared/mockGenerator.js';
import type { LiveHlsEngine } from './liveHlsEngine.js';

export interface DaiSessionRecord {
  streamId: string;
  sessionId: string;
  type: 'vod' | 'live';
  cmsId?: string;
  videoId?: string;
  assetKey?: string;
  createdAt: string;
  requestParams: Record<string, string>;
}

export class GoogleDaiEmulator {
  private sessions = new Map<string, DaiSessionRecord>();

  constructor(private readonly liveEngine: LiveHlsEngine) {}

  public createVodStream(opts: {
    baseUrl: string;
    sessionId: string;
    cmsId: string;
    videoId: string;
    params: Record<string, string>;
  }) {
    const streamId = `dai-vod-${randomUUID().slice(0, 10)}`;
    const root = opts.baseUrl.replace(/\/$/, '');
    const record: DaiSessionRecord = {
      streamId,
      sessionId: opts.sessionId,
      type: 'vod',
      cmsId: opts.cmsId,
      videoId: opts.videoId,
      createdAt: new Date().toISOString(),
      requestParams: opts.params,
    };
    this.sessions.set(streamId, record);

    const adPods = generateSsaiRafMetadata(root, opts.sessionId);
    return {
      stream_id: streamId,
      stream_manifest: `${root}/mock/ssai/stream.m3u8?session=${encodeURIComponent(opts.sessionId)}&daiStream=${streamId}`,
      media_verification_url: `${root}/api/beacon/hit?session=${encodeURIComponent(opts.sessionId)}&podId=dai-vod&adId=ssai-stitched-ad-1&daiVerify=`,
      metadata_url: `${root}/mock/dai/stream/${streamId}/metadata`,
      polling_frequency: 10,
      ad_pods: adPods,
    };
  }

  public createLiveStream(opts: {
    baseUrl: string;
    sessionId: string;
    assetKey: string;
    params: Record<string, string>;
  }) {
    const streamId = `dai-live-${randomUUID().slice(0, 10)}`;
    const root = opts.baseUrl.replace(/\/$/, '');
    const record: DaiSessionRecord = {
      streamId,
      sessionId: opts.sessionId,
      type: 'live',
      assetKey: opts.assetKey,
      createdAt: new Date().toISOString(),
      requestParams: opts.params,
    };
    this.sessions.set(streamId, record);

    // Automatically cue an upcoming live ad break if none exists yet so testing works immediately!
    if (this.liveEngine.getActiveCues(opts.sessionId).length === 0) {
      this.liveEngine.cueAdBreak({ sessionId: opts.sessionId, durationSec: 10 });
    }
    const adPods = this.liveEngine.buildLiveRafMetadata(root, opts.sessionId);

    return {
      stream_id: streamId,
      stream_manifest: `${root}/mock/live/master.m3u8?session=${encodeURIComponent(opts.sessionId)}&daiStream=${streamId}`,
      media_verification_url: `${root}/api/beacon/hit?session=${encodeURIComponent(opts.sessionId)}&podId=dai-live&daiVerify=`,
      metadata_url: `${root}/mock/dai/stream/${streamId}/metadata`,
      polling_frequency: 5,
      ad_pods: adPods,
    };
  }

  public getStreamMetadata(streamId: string, baseUrl: string) {
    const rec = this.sessions.get(streamId);
    if (!rec) return null;
    const adPods =
      rec.type === 'live'
        ? this.liveEngine.buildLiveRafMetadata(baseUrl, rec.sessionId)
        : generateSsaiRafMetadata(baseUrl, rec.sessionId);
    return {
      stream_id: rec.streamId,
      type: rec.type,
      session_id: rec.sessionId,
      ad_pods: adPods,
    };
  }
}
