export function buildLlmsTxt(baseUrl: string): string {
  return `# Roku RAF Ad Tool — AI & Automation Reference (llms.txt)

> Local workbench, CLI, HTTP API, and MCP server for Roku Advertising Framework (RAF) validation, live beacon debugging, CSAI/SSAI/DAI mock streaming, and physical Roku hardware testing.

Base URL: ${baseUrl}
OpenAPI Spec: ${baseUrl}/api/openapi.json

## Quick CLI Commands (Human + AI \`--json\` mode)

- \`raf status --json\` — Server, LAN IP, console & active suite status
- \`raf perf --ip <roku-ip> --json\` — Live :8080 Channel RAM (MB), CPU %, Texture VRAM %, and SceneGraph node count
- \`raf scan-repo "<channel-dir>" --json\` — Static BrightScript / SceneGraph RAF certification & OS 16 crash scanner
- \`raf validate "<url-or-xml-file>" [--media-type shortFormVideo] [--content-length 600] --json\` — VAST / VMAP / SmartXML + Roku Ad-Load Policy validation
- \`raf inspect-manifest "<m3u8-or-mpd-url-or-file>" --json\` — HLS / MPEG-DASH + SCTE-35 / DATERANGE inspection
- \`raf audit-url "<ad-request-url>" --json\` — GAM / DAI / SpringServe / Publica / FreeWheel RIDA & privacy parameter audit
- \`raf brs --mode csai-skippable --url "<tag-url>"\` — Generate SceneGraph + Roku_Ads.brs code
- \`raf chaos --mode http-503 --json\` — Inject ad server faults (none | http-503 | http-429 | corrupt-xml | empty-vast-303 | drop-wrapper-hop | media-500 | latency | timeout-hang)
- \`raf attach --ip <roku-ip> --content-id ep-101 --media-type episode --json\` — Deep-link & audit your own channel in dev without sideloading
- \`raf sideload --ip <roku-ip>\` — Package & sideload the Roku RAF channel harness
- \`raf run --ip <roku-ip> --scenario single-preroll --mode csai --screenshot --json\` — Autonomous end-to-end Roku hardware run + Expected-vs-Actual beacon diff + Certification audit
- \`raf cue-live --session roku-tv --duration 10 --json\` — Inject live SCTE-35 / #EXT-X-DATERANGE ad break into sliding-window HLS stream
- \`raf suite --ip <roku-ip> --json\` — Run 20-scenario certification & chaos resilience suite (add \`--simulate\` when no Roku is attached)
- \`raf har ./capture.har --json\` — Import & audit Charles / mitmproxy .har file

## MCP Server (Stdio)

Start MCP server for Claude Code, Antigravity, Codex, or Cursor:
\`npm run mcp\`

## Key HTTP Endpoints

- \`GET  /api/info\` — LAN host, default RAF macros & prefs, :8085 console state
- \`POST /api/scan-repo\` — \`{ repoPath? }\` -> RepoScanReport (BrightScript/SceneGraph static audit)
- \`POST /api/validate\` — \`{ url?, xml?, macros? }\` -> ValidationReport (VAST / VMAP / SmartXML)
- \`POST /api/inspect-manifest\` — \`{ url?, text? }\` -> ManifestInspectionReport (HLS / MPEG-DASH)
- \`POST /api/vendor/build\` — \`{ params, useLocalMock }\` -> Vendor URL + VendorRequestAudit
- \`POST /api/vendor/audit\` — \`{ url }\` -> VendorRequestAudit
- \`POST /api/vendor/brs-snippet\` — \`{ mode, adTagOrStreamUrl, contentUrl?, prefs? }\` -> \`{ code }\`
- \`GET  /proxy/tag?url=<encoded>&session=<id>&forward=1\` — Instrument & proxy external VAST/VMAP tags
- \`GET  /api/beacons?session=<id>\` — Captured HTTP beacons, telemetry, :8085 logs, quartile progress & screenshots
- \`GET  /api/audit?session=<id>&toleranceSec=1.5\` — Expected-vs-Actual beacon diff & Roku Certification report
- \`POST /api/live/cue-break\` — \`{ sessionId, durationSec }\` -> Inject live SCTE-35 break
- \`POST /api/roku/launch\` — \`{ ip, adTagUrl, contentUrl?, adMode, sessionId, useInputIfRunning?, rafPrefs? }\`
- \`POST /api/roku/screenshot\` — \`{ ip, password, sessionId }\` -> ScreenshotRecord (base64 dataUrl)
- \`POST /api/suite/start\` — \`{ deviceIp, password?, simulateWithoutDevice?, caseIds? }\` -> SuiteRunReport
- \`POST /api/snapshots\` — \`{ name, sessionId }\` -> Save SessionSnapshot to SQLite
- \`GET  /api/snapshots/:id/export.md\` — Markdown QA & Certification report
`;
}

export function buildOpenApiSpec(baseUrl: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Roku RAF Ad Tool API',
      version: '1.0.0',
      description:
        'Programmatic HTTP API for Roku Advertising Framework (RAF) static channel scanning, tag/manifest validation, live beacon auditing, CSAI/SSAI/DAI mock serving, and physical Roku device automation.',
    },
    servers: [{ url: baseUrl }],
    paths: {
      '/api/info': {
        get: { summary: 'Get server LAN URL, default RAF macros/prefs, and active status' },
      },
      '/api/scan-repo': {
        post: { summary: 'Statically scan a Roku BrightScript/SceneGraph channel directory for RAF certification issues' },
      },
      '/api/validate': {
        post: { summary: 'Validate VAST 2.0-4.2, VMAP 1.0, or FreeWheel SmartXML or remote tag URL (unrolls wrappers)' },
      },
      '/api/inspect-manifest': {
        post: { summary: 'Inspect HLS (.m3u8) or MPEG-DASH (.mpd) stream manifest and SCTE-35/DATERANGE cues' },
      },
      '/api/vendor/build': {
        post: { summary: 'Build GAM, Google DAI, SpringServe, Publica, or FreeWheel request URL' },
      },
      '/api/vendor/audit': {
        post: { summary: 'Audit outbound Roku ad URL for RIDA, LAT, US-Privacy, GPP, and correlator compliance' },
      },
      '/api/vendor/brs-snippet': {
        post: { summary: 'Generate Roku BrightScript SceneGraph Task snippet for selected RAF mode' },
      },
      '/proxy/tag': {
        get: { summary: 'Rewrite VAST/VMAP beacons & nested AdTagURIs through local beacon auditor' },
      },
      '/api/beacons': {
        get: { summary: 'List captured beacons, RAF telemetry, :8085 logs, quartile progress, and screenshots' },
      },
      '/api/audit': {
        get: { summary: 'Compute Expected-vs-Actual beacon diff, timing drift, and Roku Certification checks' },
      },
      '/api/live/cue-break': {
        post: { summary: 'Inject an on-demand SCTE-35 / #EXT-X-DATERANGE ad break into the Live HLS stream' },
      },
      '/api/roku/device-info': {
        get: { summary: 'Query Roku ECP device-info, media-player state, and :8085 console status' },
      },
      '/api/roku/sideload': {
        post: { summary: 'Package and sideload roku-channel/ to a Roku device via HTTP Digest Auth' },
      },
      '/api/roku/launch': {
        post: { summary: 'Deep-link or hot-swap an ad test on the sideloaded Roku RAF harness' },
      },
      '/api/roku/screenshot': {
        post: { summary: 'Capture a screen image from the Roku developer channel via /plugin_inspect' },
      },
      '/api/suite/start': {
        post: { summary: 'Start an automated multi-scenario Roku RAF certification suite' },
      },
      '/api/snapshots': {
        get: { summary: 'List saved SQLite session snapshots' },
        post: { summary: 'Snapshot an active session with full audit report' },
      },
      '/api/snapshots/import-har': {
        post: { summary: 'Import and audit a Charles / mitmproxy .har capture' },
      },
    },
  };
}
