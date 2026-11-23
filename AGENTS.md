# AGENTS.md — Roku RAF Ad Tool (Human & AI Guide)

This repository is engineered for **both humans (5-tab Web Workbench + Roku SceneGraph TV UI) and AI agents (CLI `--json`, REST API, OpenAPI, and MCP server)**.

## 1. Environment & Running Services

- **Workbench & Mock Ad Server**: `npm start` (production single-port on `0.0.0.0:4321`) or `npm run dev` (Vite `:5173` + API `:4321`).
- **Configured Physical Roku** (`.env`, gitignored — copy from `.env.example`): `ROKU_IP=<roku-lan-ip>`, `ROKU_DEV_USER=rokudev`, `ROKU_DEV_PASSWORD=<dev-password>`.
- **Machine Discovery**:
  - `GET http://127.0.0.1:4321/llms.txt`
  - `GET http://127.0.0.1:4321/api/openapi.json`
- **No GitHub Actions**: Do not add `.github/workflows` unless explicitly requested by the user.

## 2. AI-Ready CLI (`raf ...` or `npm run raf -- ...`)

Always pass `--json` (or set `RAF_OUTPUT=json`) when parsing output programmatically. Exit codes: `0` = pass, `1` = validation/certification failure, `2` = runtime/argument error.

```bash
# Check local server + physical Roku status
raf status --json

# Statically scan any Roku BrightScript / SceneGraph channel directory for RAF certification & OS 16 bugs
raf scan-repo ./roku-channel --json

# Validate VAST/VMAP/SmartXML file or URL (expands ROKU_ADS_* macros & unrolls wrappers)
raf validate "http://127.0.0.1:4321/mock/vast/pod-3-ads.xml" --json

# Inspect HLS (.m3u8) or MPEG-DASH (.mpd) manifests and SCTE-35/DATERANGE cues
raf inspect-manifest "http://127.0.0.1:4321/mock/ssai/stream.m3u8" --json

# Audit GAM / DAI / SpringServe / Publica / FreeWheel URL parameters & RIDA/LAT compliance
raf audit-url "https://pubads.g.doubleclick.net/gampad/ads?..." --json

# Generate SceneGraph + Roku_Ads.brs code (csai | csai-stitched | csai-skippable | ssai | ssai-live | google-dai)
raf brs --mode csai-skippable --url "https://ads.example.com/skippable.xml"

# Sideload the Roku RAF channel harness onto the target Roku
raf sideload --json

# Run an end-to-end test on physical Roku hardware (add --proxy for external tags), capture screenshot & audit
raf run --scenario single-preroll --mode csai --screenshot --json
raf run --tag "https://pubads.g.doubleclick.net/gampad/ads?..." --proxy --screenshot --json

# Cue a Live SCTE-35 / #EXT-X-DATERANGE ad break in the Live Linear HLS stream
raf cue-live --session roku-tv --duration 10 --json

# Run 18-case Automated Certification Suite (--simulate when offline)
raf suite --json
raf suite --simulate --json

# Import & audit a Charles / mitmproxy .har capture
raf har ./samples/public-gam-roku-capture.har --json
```

## 3. MCP Server Integration (`npm run mcp`)

Exposes 10 tools over stdio (`scan_roku_channel_repo`, `validate_ad_tag`, `inspect_stream_manifest`, `audit_vendor_ad_url`, `generate_raf_brightscript`, `roku_device_status`, `cue_live_scte35_break`, `get_session_beacon_audit`, `capture_roku_screenshot`, `import_har_file`). Attach `src/mcp/server.ts` in any MCP client:

```json
{
  "mcpServers": {
    "roku-raf-ad-tool": {
      "command": "npx",
      "args": ["tsx", "./src/mcp/server.ts"]
    }
  }
}
```

## 4. Verification

After any code or BrightScript changes, run:

```bash
npm run verify
npm run test:e2e
```
