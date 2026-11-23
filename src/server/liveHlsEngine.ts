import { randomUUID } from 'node:crypto';
import { buildBeaconUrl } from '../shared/mockGenerator.js';
import type { LiveAdCueState } from '../shared/types.js';

const SEGMENT_DURATION_SEC = 5;
const WINDOW_SIZE_SEGMENTS = 6;
const CONTENT_SEGMENTS = ['content-seg1.ts', 'content-seg2.ts', 'content-seg3.ts', 'content-seg4.ts'];
const AD_SEGMENTS = ['ad-seg1.ts', 'ad-seg2.ts'];

/**
 * Generates a realistic SCTE-35 splice_insert base64 payload encoding the given break duration in 90kHz ticks.
 */
export function buildScte35SpliceInsertBase64(eventId: number, durationSec: number): string {
  const ticks = Math.round(durationSec * 90000);
  const buf = Buffer.alloc(20);
  buf[0] = 0xfc; // table_id = 0xFC (splice_info_section)
  buf.writeUInt16BE(0x3011, 1);
  buf[3] = 0x00; // protocol_version
  buf[11] = 0x05; // splice_command_type = 0x05 (splice_insert)
  buf.writeUInt32BE(eventId >>> 0, 12);
  buf.writeUInt32BE(ticks >>> 0, 16);
  return buf.toString('base64');
}

export class LiveHlsEngine {
  private readonly streamEpochMs = Date.now() - 60_000;
  private cuesBySession = new Map<string, LiveAdCueState[]>();

  public getCurrentMediaSequence(nowMs = Date.now()): number {
    return Math.max(0, Math.floor((nowMs - this.streamEpochMs) / (SEGMENT_DURATION_SEC * 1000)));
  }

  /**
   * Immediately cues a live SCTE-35 / #EXT-X-DATERANGE ad break starting on the next segment boundary
   * so Roku players watching the live sliding-window stream transition into the stitched ad break!
   */
  public cueAdBreak(opts: {
    sessionId: string;
    durationSec?: number;
    leadSegments?: number;
    nowMs?: number;
  }): LiveAdCueState {
    const now = opts.nowMs ?? Date.now();
    const currentSeq = this.getCurrentMediaSequence(now);
    const segmentSpan = Math.max(1, Math.round((opts.durationSec ?? 10) / SEGMENT_DURATION_SEC));
    const durationSec = segmentSpan * SEGMENT_DURATION_SEC;
    const lead = opts.leadSegments ?? 4;
    const startMediaSeq = currentSeq + lead;
    const id = `live-cue-${randomUUID().slice(0, 8)}`;
    const numericEvent = Math.floor(Math.random() * 100000) + 1;

    const cue: LiveAdCueState = {
      id,
      sessionId: opts.sessionId || 'default',
      triggeredAtMs: now,
      startMediaSeq,
      durationSec,
      segmentSpan,
      scte35Base64: buildScte35SpliceInsertBase64(numericEvent, durationSec),
      adId: `live-ad-${numericEvent}`,
      podId: id,
    };

    const list = this.cuesBySession.get(cue.sessionId) ?? [];
    list.push(cue);
    // Keep recent 20 cues
    if (list.length > 20) list.shift();
    this.cuesBySession.set(cue.sessionId, list);
    return cue;
  }

  public getActiveCues(sessionId: string): LiveAdCueState[] {
    return [...(this.cuesBySession.get(sessionId || 'default') ?? [])];
  }

  public buildMasterPlaylist(baseUrl: string, sessionId: string): string {
    const root = baseUrl.replace(/\/$/, '');
    return `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=1450000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",FRAME-RATE=30.000
${root}/mock/live/playlist.m3u8?session=${encodeURIComponent(sessionId)}
`;
  }

  public buildLiveSlidingPlaylist(baseUrl: string, sessionId: string, nowMs = Date.now()): string {
    const root = baseUrl.replace(/\/$/, '');
    const headSeq = this.getCurrentMediaSequence(nowMs);
    const cues = this.cuesBySession.get(sessionId || 'default') ?? [];

    const lines: string[] = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${SEGMENT_DURATION_SEC + 1}`,
      `#EXT-X-MEDIA-SEQUENCE:${headSeq}`,
    ];

    let prevWasAd = false;

    for (let i = 0; i < WINDOW_SIZE_SEGMENTS; i++) {
      const seq = headSeq + i;
      const segStartEpochMs = this.streamEpochMs + seq * SEGMENT_DURATION_SEC * 1000;
      const isoPdt = new Date(segStartEpochMs).toISOString();

      const matchingCue = cues.find(
        (c) => seq >= c.startMediaSeq && seq < c.startMediaSeq + c.segmentSpan
      );
      const isAd = Boolean(matchingCue);

      if (i > 0 && isAd !== prevWasAd) {
        lines.push('#EXT-X-DISCONTINUITY');
        if (!isAd) {
          lines.push('#EXT-X-CUE-IN');
        }
      }

      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${isoPdt}`);

      if (matchingCue && seq === matchingCue.startMediaSeq) {
        const startIso = new Date(
          this.streamEpochMs + matchingCue.startMediaSeq * SEGMENT_DURATION_SEC * 1000
        ).toISOString();
        lines.push(`#EXT-X-CUE-OUT:DURATION=${matchingCue.durationSec.toFixed(1)}`);
        lines.push(`#EXT-X-OATCLS-SCTE35:${matchingCue.scte35Base64}`);
        lines.push(
          `#EXT-X-DATERANGE:ID="${matchingCue.id}",START-DATE="${startIso}",DURATION=${matchingCue.durationSec.toFixed(
            1
          )},SCTE35-OUT=0x${Buffer.from(matchingCue.scte35Base64, 'base64').toString('hex').toUpperCase()}`
        );
      }

      const file = isAd
        ? AD_SEGMENTS[(seq - (matchingCue?.startMediaSeq ?? 0)) % AD_SEGMENTS.length]
        : CONTENT_SEGMENTS[seq % CONTENT_SEGMENTS.length];

      lines.push(`#EXTINF:${SEGMENT_DURATION_SEC.toFixed(3)},`);
      lines.push(`${root}/media/hls/${file}?seq=${seq}`);
      prevWasAd = isAd;
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Builds RAF `stitchedAdsInit` compatible metadata for all cued live breaks on this session.
   */
  public buildLiveRafMetadata(baseUrl: string, sessionId: string, nowMs = Date.now()) {
    const root = baseUrl.replace(/\/$/, '');
    const headSeq = this.getCurrentMediaSequence(nowMs);
    const cues = this.cuesBySession.get(sessionId || 'default') ?? [];
    return cues.map((cue) => {
      const renderTime = Math.max(0, (cue.startMediaSeq - headSeq) * SEGMENT_DURATION_SEC);
      const dur = cue.durationSec;
      const mkTrack = (event: string, offsetFrac: number) => ({
        event,
        url: buildBeaconUrl(root, {
          sessionId: cue.sessionId,
          event,
          adId: cue.adId,
          podId: cue.podId,
        }),
        time: Number((renderTime + dur * offsetFrac).toFixed(2)),
        triggered: false,
      });

      return {
        id: cue.id,
        viewed: false,
        renderSequence: 'midroll',
        duration: dur,
        renderTime,
        scte35: cue.scte35Base64,
        ads: [
          {
            adServer: root,
            adId: cue.adId,
            adTitle: `Live Cued SCTE-35 Ad (${dur}s)`,
            duration: dur,
            streamFormat: 'hls',
            streams: [],
            companionAds: [],
            tracking: [
              mkTrack('Impression', 0),
              mkTrack('Start', 0.02),
              mkTrack('FirstQuartile', 0.25),
              mkTrack('Midpoint', 0.5),
              mkTrack('ThirdQuartile', 0.75),
              mkTrack('Complete', 0.98),
            ],
          },
        ],
      };
    });
  }
}
