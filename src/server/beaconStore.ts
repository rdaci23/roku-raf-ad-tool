import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { VAST_ERROR_CODES } from '../shared/rafMacros.js';
import type {
  AdQuartileProgress,
  BeaconEvent,
  BeaconEventKind,
  ExpectedBeaconSpec,
  ScreenshotRecord,
} from '../shared/types.js';

const MAX_EVENTS = 25000;

export class BeaconStore {
  private events: BeaconEvent[] = [];
  private sessionStartTimes = new Map<string, number>();
  private progressMap = new Map<string, AdQuartileProgress>();
  private expectedBySession = new Map<string, ExpectedBeaconSpec[]>();
  private screenshotsBySession = new Map<string, ScreenshotRecord[]>();
  private lastServedPayloadBySession = new Map<string, { url?: string; rawText?: string }>();
  private sseClients = new Set<ServerResponse>();

  public registerExpectedBeacons(
    sessionId: string,
    specs: ExpectedBeaconSpec[],
    opts?: { replace?: boolean; url?: string; rawText?: string }
  ): void {
    const sid = sessionId?.trim() || 'default';
    if (opts?.url || opts?.rawText) {
      this.lastServedPayloadBySession.set(sid, { url: opts.url, rawText: opts.rawText });
    }
    if (opts?.replace) {
      this.expectedBySession.set(sid, [...specs]);
      return;
    }
    const current = this.expectedBySession.get(sid) ?? [];
    const existingKeys = new Set(current.map((s) => `${s.adId}::${s.event}::${s.url}`));
    for (const sp of specs) {
      const k = `${sp.adId}::${sp.event}::${sp.url}`;
      if (!existingKeys.has(k)) {
        current.push(sp);
        existingKeys.add(k);
      }
    }
    this.expectedBySession.set(sid, current);
  }

  public getExpectedBeacons(sessionId: string): ExpectedBeaconSpec[] {
    return [...(this.expectedBySession.get(sessionId || 'default') ?? [])];
  }

  public getLastServedPayload(sessionId: string): { url?: string; rawText?: string } | undefined {
    return this.lastServedPayloadBySession.get(sessionId || 'default');
  }

  public addScreenshot(shot: ScreenshotRecord): void {
    const sid = shot.sessionId || 'default';
    const arr = this.screenshotsBySession.get(sid) ?? [];
    arr.push(shot);
    if (arr.length > 20) arr.shift();
    this.screenshotsBySession.set(sid, arr);
    this.broadcast({ type: 'screenshot', screenshot: shot });
  }

  public getScreenshots(sessionId?: string): ScreenshotRecord[] {
    if (!sessionId || sessionId === 'all') {
      return Array.from(this.screenshotsBySession.values()).flat();
    }
    return [...(this.screenshotsBySession.get(sessionId) ?? [])];
  }

  public record(input: {
    sessionId?: string;
    kind: BeaconEventKind;
    eventName: string;
    adId?: string;
    podId?: string;
    errorCode?: string;
    requestUrl: string;
    originalUrl?: string;
    method?: string;
    userAgent?: string;
    remoteIp?: string;
    forwardedStatus?: number;
    details?: Record<string, unknown>;
  }): BeaconEvent {
    const sessionId = input.sessionId?.trim() || 'default';
    const now = Date.now();
    if (!this.sessionStartTimes.has(sessionId)) {
      this.sessionStartTimes.set(sessionId, now);
    }
    const startEpoch = this.sessionStartTimes.get(sessionId)!;

    const cleanErr =
      input.errorCode && input.errorCode !== '[ERRORCODE]' ? input.errorCode.trim() : input.errorCode;
    const errorDescription = cleanErr ? VAST_ERROR_CODES[cleanErr] : undefined;

    const ev: BeaconEvent = {
      id: randomUUID(),
      sessionId,
      timestamp: new Date(now).toISOString(),
      epochMs: now,
      relativeMs: now - startEpoch,
      kind: input.kind,
      eventName: input.eventName,
      adId: input.adId,
      podId: input.podId,
      errorCode: cleanErr,
      errorDescription,
      requestUrl: input.requestUrl,
      originalUrl: input.originalUrl,
      method: input.method ?? 'GET',
      userAgent: input.userAgent,
      remoteIp: input.remoteIp,
      forwardedStatus: input.forwardedStatus,
      details: input.details,
    };

    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }

    this.updateProgress(ev);
    this.broadcast({ type: 'beacon', event: ev, progress: this.getProgress(sessionId) });
    return ev;
  }

  private updateProgress(ev: BeaconEvent): void {
    if (!ev.adId || ev.kind === 'tag_request' || ev.kind === 'console_log' || ev.kind === 'raf_telemetry') {
      return;
    }
    const podId = ev.podId || 'default-pod';
    const key = `${ev.sessionId}::${podId}::${ev.adId}`;
    const existing: AdQuartileProgress = this.progressMap.get(key) ?? {
      key,
      sessionId: ev.sessionId,
      podId,
      adId: ev.adId,
      impression: false,
      start: false,
      firstQuartile: false,
      midpoint: false,
      thirdQuartile: false,
      complete: false,
      skip: false,
      mute: false,
      pause: false,
      resume: false,
      error: false,
      updatedAt: ev.epochMs,
    };

    const norm = ev.eventName.toLowerCase();
    if (norm === 'impression') existing.impression = true;
    else if (norm === 'start') existing.start = true;
    else if (norm === 'firstquartile') existing.firstQuartile = true;
    else if (norm === 'midpoint') existing.midpoint = true;
    else if (norm === 'thirdquartile') existing.thirdQuartile = true;
    else if (norm === 'complete') existing.complete = true;
    else if (norm === 'skip') existing.skip = true;
    else if (norm === 'mute') existing.mute = true;
    else if (norm === 'pause') existing.pause = true;
    else if (norm === 'resume') existing.resume = true;
    else if (norm === 'error') {
      existing.error = true;
      existing.lastErrorCode = ev.errorCode;
    }

    existing.updatedAt = ev.epochMs;
    this.progressMap.set(key, existing);
  }

  public getEvents(sessionId?: string): BeaconEvent[] {
    if (!sessionId || sessionId === 'all') return [...this.events];
    return this.events.filter((e) => e.sessionId === sessionId);
  }

  public getProgress(sessionId?: string): AdQuartileProgress[] {
    const all = Array.from(this.progressMap.values());
    if (!sessionId || sessionId === 'all') return all;
    return all.filter((p) => p.sessionId === sessionId);
  }

  public clear(sessionId?: string): void {
    if (!sessionId || sessionId === 'all') {
      this.events = [];
      this.progressMap.clear();
      this.sessionStartTimes.clear();
      this.expectedBySession.clear();
      this.screenshotsBySession.clear();
    } else {
      this.events = this.events.filter((e) => e.sessionId !== sessionId);
      this.sessionStartTimes.delete(sessionId);
      this.expectedBySession.delete(sessionId);
      this.screenshotsBySession.delete(sessionId);
      for (const [k, v] of this.progressMap.entries()) {
        if (v.sessionId === sessionId) this.progressMap.delete(k);
      }
    }
    this.broadcast({ type: 'cleared', sessionId: sessionId ?? 'all' });
  }

  public attachSse(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', count: this.events.length })}\n\n`);
    this.sseClients.add(res);
    res.on('close', () => {
      this.sseClients.delete(res);
    });
  }

  public broadcast(payload: unknown): void {
    const msg = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(msg);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }
}
