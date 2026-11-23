---
name: roku-raf-testing
description: Statically scan Roku BrightScript channels, validate VAST/VMAP/SmartXML/HLS/DASH ad streams, audit RIDA/LAT privacy macros, attach or sideload the Roku RAF harness, profile :8080 RAM/VRAM, and execute 20-case certification & chaos runs on physical Roku hardware.
---

# Roku RAF Testing Skill

Use this skill whenever scanning Roku BrightScript channel code, validating Roku ad tags, debugging RAF quartile beacons, testing SSAI/DAI streams, or running ad checks on a physical Roku device.

## Workflow

1. **Ensure Workbench Server is Running**:
   Check `raf status --json`. If `server.running === false`, start `npm start` in the background so LAN endpoints (`http://<lan-ip>:4321`) are reachable by the Roku device.
2. **Static Channel / Tag / Stream / URL Audits** (fast, no device required):
   - Roku BrightScript Channel Repo: `raf scan-repo "<channel-dir>" --json`
   - VAST/VMAP/SmartXML: `raf validate "<url-or-file>" --json`
   - HLS/DASH Manifests: `raf inspect-manifest "<url-or-file>" --json`
   - Outbound Ad Request Params: `raf audit-url "<url>" --json`
3. **Physical Roku Hardware Execution**:
   - Sideload if `roku-channel/` changed: `raf sideload --json`
   - Attach to an existing Roku channel without overwriting `dev`: `raf attach --content-id ep-101 --media-type episode --json`
   - Sample `:8080` RAM, GPU Texture VRAM & CPU headroom: `raf perf --json`
   - Run single scenario (add `--proxy` for external ad servers) with Expected-vs-Actual diff & screenshot:
     `raf run --scenario <slug> --mode <csai|csai-stitched|csai-skippable|ssai|ssai-live|google-dai> --screenshot --json`
   - Run full 20-case certification & chaos suite (`--simulate` when offline):
     `raf suite --json`
   - Inspect `certScore`, `matchedBeacons`, `missingBeacons`, `certChecks`, and `rafLogs` in the returned JSON.
