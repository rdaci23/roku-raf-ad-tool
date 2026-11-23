import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CustomMockConfig,
  SavedRokuDevice,
  SessionSnapshot,
  SuiteRunReport,
} from '../shared/types.js';

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IS_GIT_CHECKOUT = existsSync(join(ROOT, '.git'));
const DATA_DIR =
  process.env.RAF_DATA_DIR ||
  (IS_GIT_CHECKOUT ? join(ROOT, 'data') : join(homedir(), '.roku-raf-ad-tool', 'data'));
const DEFAULT_DB_PATH = join(DATA_DIR, 'raf-tool.sqlite');

export class AppDatabase {
  private db: SqliteDatabase;

  constructor(dbPath = DEFAULT_DB_PATH) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    const req = createRequire(import.meta.url);
    const sqliteMod = req('node:sqlite') as { DatabaseSync: new (p: string) => SqliteDatabase };
    this.db = new sqliteMod.DatabaseSync(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        ip TEXT NOT NULL,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        model_name TEXT,
        software_version TEXT,
        serial_number TEXT,
        last_seen_at TEXT
      );

      CREATE TABLE IF NOT EXISTS custom_mocks (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        cert_score INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS suite_runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        device_ip TEXT NOT NULL,
        started_at TEXT NOT NULL,
        status TEXT NOT NULL,
        overall_score INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);
  }

  // --- Roku Device Roster ---

  public listDevices(): SavedRokuDevice[] {
    const rows = this.db.prepare('SELECT * FROM devices ORDER BY name ASC').all();
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      ip: String(r.ip),
      username: String(r.username),
      password: String(r.password),
      modelName: r.model_name ? String(r.model_name) : undefined,
      softwareVersion: r.software_version ? String(r.software_version) : undefined,
      serialNumber: r.serial_number ? String(r.serial_number) : undefined,
      lastSeenAt: r.last_seen_at ? String(r.last_seen_at) : undefined,
    }));
  }

  public upsertDevice(dev: SavedRokuDevice): SavedRokuDevice {
    this.db
      .prepare(
        `INSERT INTO devices (id, name, ip, username, password, model_name, software_version, serial_number, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           ip = excluded.ip,
           username = excluded.username,
           password = excluded.password,
           model_name = excluded.model_name,
           software_version = excluded.software_version,
           serial_number = excluded.serial_number,
           last_seen_at = excluded.last_seen_at`
      )
      .run(
        dev.id,
        dev.name,
        dev.ip,
        dev.username,
        dev.password,
        dev.modelName ?? null,
        dev.softwareVersion ?? null,
        dev.serialNumber ?? null,
        dev.lastSeenAt ?? null
      );
    return dev;
  }

  public deleteDevice(id: string): void {
    this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  }

  // --- Custom Mock Profiles ---

  public listCustomMocks(): CustomMockConfig[] {
    const rows = this.db
      .prepare('SELECT payload_json FROM custom_mocks ORDER BY updated_at DESC')
      .all();
    return rows.map((r) => JSON.parse(String(r.payload_json)) as CustomMockConfig);
  }

  public upsertCustomMock(cfg: CustomMockConfig): CustomMockConfig {
    this.db
      .prepare(
        `INSERT INTO custom_mocks (id, payload_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`
      )
      .run(cfg.id, JSON.stringify(cfg), Date.now());
    return cfg;
  }

  public deleteCustomMock(id: string): void {
    this.db.prepare('DELETE FROM custom_mocks WHERE id = ?').run(id);
  }

  // --- Session Snapshots ---

  public listSnapshots(): Array<{
    id: string;
    name: string;
    source: string;
    sessionId: string;
    createdAt: string;
    certScore: number;
    eventCount: number;
    screenshotCount: number;
  }> {
    const rows = this.db
      .prepare('SELECT id, name, source, session_id, created_at, cert_score, payload_json FROM snapshots ORDER BY created_at DESC')
      .all();
    return rows.map((r) => {
      const snap = JSON.parse(String(r.payload_json)) as SessionSnapshot;
      return {
        id: String(r.id),
        name: String(r.name),
        source: String(r.source),
        sessionId: String(r.session_id),
        createdAt: String(r.created_at),
        certScore: Number(r.cert_score),
        eventCount: snap.events?.length ?? 0,
        screenshotCount: snap.screenshots?.length ?? 0,
      };
    });
  }

  public getSnapshot(id: string): SessionSnapshot | null {
    const row = this.db.prepare('SELECT payload_json FROM snapshots WHERE id = ?').get(id);
    if (!row) return null;
    return JSON.parse(String(row.payload_json)) as SessionSnapshot;
  }

  public saveSnapshot(snap: SessionSnapshot): SessionSnapshot {
    this.db
      .prepare(
        `INSERT INTO snapshots (id, name, source, session_id, created_at, cert_score, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           cert_score = excluded.cert_score,
           payload_json = excluded.payload_json`
      )
      .run(
        snap.id,
        snap.name,
        snap.source,
        snap.sessionId,
        snap.createdAt,
        snap.auditReport.certScore,
        JSON.stringify(snap)
      );
    return snap;
  }

  public deleteSnapshot(id: string): void {
    this.db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
  }

  // --- Suite Runs ---

  public listSuiteRuns(): SuiteRunReport[] {
    const rows = this.db
      .prepare('SELECT payload_json FROM suite_runs ORDER BY started_at DESC LIMIT 50')
      .all();
    return rows.map((r) => JSON.parse(String(r.payload_json)) as SuiteRunReport);
  }

  public saveSuiteRun(run: SuiteRunReport): SuiteRunReport {
    this.db
      .prepare(
        `INSERT INTO suite_runs (id, name, device_ip, started_at, status, overall_score, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           overall_score = excluded.overall_score,
           payload_json = excluded.payload_json`
      )
      .run(
        run.id,
        run.name,
        run.deviceIp,
        run.startedAt,
        run.status,
        run.overallScore,
        JSON.stringify(run)
      );
    return run;
  }

  public close(): void {
    this.db.close();
  }
}

export function formatSnapshotAsMarkdown(snap: SessionSnapshot): string {
  const lines: string[] = [
    `# Roku RAF Ad Tool — Session QA & Certification Report`,
    ``,
    `- **Snapshot Name**: ${snap.name}`,
    `- **Session ID**: \`${snap.sessionId}\``,
    `- **Source**: \`${snap.source}\``,
    `- **Created At**: ${snap.createdAt}`,
    `- **Ad Tag / Stream URL**: \`${snap.adTagUrl ?? 'N/A'}\``,
    `- **Certification Score**: **${snap.auditReport.certScore} / 100**`,
    ``,
    `## Roku Certification & Privacy Checks`,
    ``,
    `| Status | Category | Check | Detail |`,
    `| --- | --- | --- | --- |`,
    ...snap.auditReport.certChecks.map(
      (c) => `| **${c.status.toUpperCase()}** | ${c.category} | ${c.title} | ${c.detail} |`
    ),
    ``,
    `## Expected-vs-Actual Beacon Diff (${snap.auditReport.matchedCount}/${snap.auditReport.expectedCount} matched)`,
    ``,
    `| Status | Ad ID | Event | Source | Expected Offset | Actual Offset | Drift |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
    ...snap.auditReport.diffItems.map(
      (d) =>
        `| **${d.status}** | \`${d.spec.adId}\` | \`${d.spec.event}\` | ${d.spec.source} | ${
          d.spec.expectedOffsetSec !== undefined ? `+${d.spec.expectedOffsetSec}s` : '—'
        } | ${d.actualOffsetSec !== undefined ? `+${d.actualOffsetSec}s` : '—'} | ${
          d.driftSec !== undefined ? `${d.driftSec > 0 ? '+' : ''}${d.driftSec}s` : '—'
        } |`
    ),
    ``,
    `## Captured Event Timeline (${snap.events.length} events)`,
    ``,
    ...snap.events
      .slice(0, 100)
      .map(
        (e) =>
          `- \`+${(e.relativeMs / 1000).toFixed(2)}s\` **[${e.kind}]** \`${e.eventName}\` ${
            e.adId ? `(ad: \`${e.adId}\`)` : ''
          } — ${e.originalUrl || e.requestUrl}`
      ),
  ];

  return lines.join('\n');
}
