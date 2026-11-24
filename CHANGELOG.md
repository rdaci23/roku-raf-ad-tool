# Changelog

All notable changes to `roku-raf-ad-tool` are documented in this file.

## [1.1.0](https://github.com/rdaci23/roku-raf-ad-tool/compare/v1.0.0...v1.1.0) (2026-11-24)

### Features

* **ssai:** add 3-rung ABR stitched pods, #EXT-X-DATERANGE bridge, hybrid CSAI+SSAI, and stream relay ([3cdd807](https://github.com/rdaci23/roku-raf-ad-tool/commit/3cdd8078a4f72fb8f4a1e5c88568c7e129ff09b5))

### Bug Fixes

* **roku:** exit active dev app to Home and use Replace on Roku OS 16 sideload ([e51bb9f](https://github.com/rdaci23/roku-raf-ad-tool/commit/e51bb9f50530324f91cccfcd7c8b56cede647ac1))

## [1.0.0](https://github.com/rdaci23/roku-raf-ad-tool/releases/tag/v1.0.0) (2026-11-23)

### Features

* **Validator, Manifest Inspector, Vendor Builder & BrightScript Repo Scanner**:
  * Static Roku BrightScript / SceneGraph channel repository scanner (`raf scan-repo`, `POST /api/scan-repo`, `scan_roku_channel_repo` MCP tool) auditing `manifest`, Render-thread violations, RIDA/LAT privacy leaks, Nielsen/OMID metadata, and Roku OS 16 compiler/runtime traps.
  * VAST 2.0–4.2, VMAP 1.0, and FreeWheel SmartXML (`<adResponse>`) validator with multi-hop `<Wrapper>` unrolling, `ROKU_ADS_*` macro expansion, and Roku Ad-Load Certification policy checks (`shortFormVideo` midroll prohibition, `>= 7 min` midroll spacing, pod duration/spot caps).
  * HLS (`.m3u8`) and MPEG-DASH (`.mpd`) inspector for `#EXT-X-DATERANGE`, `#EXT-X-DISCONTINUITY`, `#EXT-X-CUE-OUT`, `#EXT-X-OATCLS-SCTE35`, and `<EventStream>` cues.
  * Outbound ad request builder & compliance auditor for GAM, Google DAI (VOD & Live), SpringServe, Publica, and FreeWheel, plus copy-ready `Roku_Ads.brs` SceneGraph Task generator (`csai`, `csai-stitched`, `csai-skippable`, `ssai`, `ssai-live`, `google-dai`).
* **Live Mock Ad, SSAI, Google DAI & Chaos Fault Studio**:
  * Live Linear HLS sliding-window server (`/mock/live/master.m3u8`) with real-time SCTE-35 / `#EXT-X-DATERANGE` break injection.
  * Ad Chaos & Network Fault Injector (`/api/chaos`, `?chaos=`) simulating `http-503`, `http-429`, `corrupt-xml`, `empty-vast-303`, `drop-wrapper-hop`, `media-500`, `latency`, and `timeout-hang`.
  * Google DAI VOD & Live session emulator and cross-platform media generator (`scripts/generate-media.mjs`).
* **Expected-vs-Actual Beacon Diff & Roku Certification Auditor**:
  * Tag Instrumentation Proxy (`/proxy/tag`) with per-VMAP-break scoping, `±s` quartile drift calculation, Ad `TTFF` (`ms`) startup metrics, post-skip/early-exit quartile suppression, and 9 Roku Ad Certification checks.
* **Physical Roku Hardware Harness, `:8080` Profiler & 20-Case Suite Runner**:
  * Zero-sideload External Channel Attach (`raf attach`) for cold `/launch` and warm `/input` Roku Cert 4.x deep-link testing without overwriting `dev`.
  * Roku OS `:8080` Memory, GPU Texture VRAM, CPU %, and SceneGraph Node profiler (`raf perf`).
  * Sideloadable 5-mode Roku SceneGraph channel (`roku-channel/`) including Custom SceneGraph Skippable Ad UI (`csai-skippable`), transparent `*` RAF Debug HUD, SSDP discovery, `/plugin_inspect` screenshots, `:8085` console bridge, and a 20-scenario Automated Certification & Chaos Suite Runner.
* **Sessions, HAR Importer, CLI, 13-Tool MCP Server & TypeScript SDK**:
  * SQLite snapshot persistence (`node:sqlite`), Charles/mitmproxy `.har` traffic importer, `raf --json` CLI, `roku-raf-mcp` stdio server, `/llms.txt`, `/api/openapi.json`, and programmatic TypeScript exports.
