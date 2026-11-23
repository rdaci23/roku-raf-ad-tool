import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import type { IssueSeverity } from './types.js';

export interface RepoScanFinding {
  severity: IssueSeverity;
  code: string;
  title: string;
  file: string;
  line?: number;
  message: string;
  fixHint: string;
}

export interface RepoScanReport {
  repoPath: string;
  scannedAt: string;
  rafReady: boolean;
  score: number;
  filesScanned: {
    manifestFound: boolean;
    brsFiles: number;
    xmlFiles: number;
  };
  summary: {
    errors: number;
    warnings: number;
    infos: number;
  };
  findings: RepoScanFinding[];
}

interface ScannedFile {
  absPath: string;
  relPath: string;
  content: string;
  lines: string[];
}

function walkChannelFiles(rootDir: string): { brs: ScannedFile[]; xml: ScannedFile[] } {
  const brs: ScannedFile[] = [];
  const xml: ScannedFile[] = [];
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'out', '.roku-deploy-staging']);

  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (ext === '.brs' || ext === '.xml') {
          const content = readFileSync(full, 'utf8');
          const item: ScannedFile = {
            absPath: full,
            relPath: relative(rootDir, full).replace(/\\/g, '/'),
            content,
            lines: content.split(/\r?\n/),
          };
          if (ext === '.brs') brs.push(item);
          else xml.push(item);
        }
      }
    }
  }

  walk(rootDir);
  return { brs, xml };
}

function stripBrsComment(line: string): string {
  // Strip trailing BrightScript ' or REM comments (outside simple string literals)
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    if (!inQuotes && ch === "'") {
      return line.slice(0, i);
    }
  }
  if (/^\s*rem\b/i.test(line)) return '';
  return line;
}

function findLineNumber(lines: string[], pattern: RegExp): number | undefined {
  for (let i = 0; i < lines.length; i++) {
    const code = stripBrsComment(lines[i]);
    if (pattern.test(code)) return i + 1;
  }
  return undefined;
}

/**
 * Statically scans a Roku BrightScript / SceneGraph channel directory for Roku Advertising Framework (RAF)
 * certification issues, SceneGraph thread-safety bugs, RIDA/LAT privacy violations, and Roku OS 16 runtime traps.
 */
export function scanRokuChannelRepo(targetDir: string): RepoScanReport {
  const root = resolve(targetDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Channel directory does not exist: ${root}`);
  }

  const findings: RepoScanFinding[] = [];
  const manifestPath = join(root, 'manifest');
  const manifestFound = existsSync(manifestPath) && statSync(manifestPath).isFile();
  const manifestContent = manifestFound ? readFileSync(manifestPath, 'utf8') : '';
  const manifestLines = manifestContent.split(/\r?\n/);

  const { brs, xml } = walkChannelFiles(root);

  if (!manifestFound) {
    findings.push({
      severity: 'error',
      code: 'MANIFEST_MISSING',
      title: 'Missing Roku channel manifest file',
      file: 'manifest',
      message: 'No root "manifest" file found in channel directory.',
      fixHint: 'Create a root "manifest" file containing title, major_version, and bs_libs_required=roku_ads_lib.',
    });
  } else {
    const hasRafLib = manifestLines.some((l) => /^\s*bs_libs_required\s*=.*\broku_ads_lib\b/i.test(l));
    if (!hasRafLib) {
      findings.push({
        severity: 'error',
        code: 'MANIFEST_MISSING_RAF_LIB',
        title: 'manifest missing bs_libs_required=roku_ads_lib',
        file: 'manifest',
        line: 1,
        message: 'Channel manifest does not declare bs_libs_required=roku_ads_lib.',
        fixHint: 'Add "bs_libs_required=roku_ads_lib" to manifest so Roku OS links Roku_Ads.brs at launch.',
      });
    }

    const usesRoInput = brs.some((f) => /\broInput\b|\bexternalInput\b/i.test(f.content));
    const hasInputLaunch = manifestLines.some((l) => /^\s*supports_input_launch\s*=\s*1\b/i.test(l));
    if (usesRoInput && !hasInputLaunch) {
      findings.push({
        severity: 'warning',
        code: 'MANIFEST_MISSING_INPUT_LAUNCH',
        title: 'roInput used without supports_input_launch=1',
        file: 'manifest',
        line: 1,
        message: 'Channel references roInput/externalInput but manifest lacks supports_input_launch=1.',
        fixHint: 'Add "supports_input_launch=1" to manifest so ECP /input deep-links are delivered without relaunch.',
      });
    }
  }

  // Map SceneGraph XML components: which .brs URIs belong to Task vs Render-thread components
  const brsToComponent = new Map<
    string,
    { componentName: string; extendsType: string; xmlRelPath: string; siblingBrsPaths: string[] }
  >();

  for (const xFile of xml) {
    const compMatch = xFile.content.match(/<component\b([^>]*)>/i);
    if (!compMatch) continue;
    const attrs = compMatch[1];
    const nameMatch = attrs.match(/\bname\s*=\s*["']([^"']+)["']/i);
    const extMatch = attrs.match(/\bextends\s*=\s*["']([^"']+)["']/i);
    const componentName = nameMatch ? nameMatch[1] : xFile.relPath;
    const extendsType = extMatch ? extMatch[1] : 'Group';

    const scriptUris: string[] = [];
    const scriptRegex = /<script\b[^>]*\buri\s*=\s*["']pkg:\/([^"']+)["'][^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = scriptRegex.exec(xFile.content)) !== null) {
      scriptUris.push(m[1].replace(/^\/+/, ''));
    }

    for (const uri of scriptUris) {
      brsToComponent.set(uri, {
        componentName,
        extendsType,
        xmlRelPath: xFile.relPath,
        siblingBrsPaths: scriptUris,
      });
    }
  }

  const byRelPath = new Map(brs.map((b) => [b.relPath, b]));
  let anyRafCall = false;
  let hasMeasurementsCall = false;
  let hasContentMetaCall = false;
  let anyLatCheckInRepo = false;

  for (const bFile of brs) {
    const codeOnly = bFile.lines.map(stripBrsComment).join('\n');
    if (/\bRoku_Ads\s*\(/i.test(codeOnly)) anyRafCall = true;
    if (/\.enableAdMeasurements\s*\(\s*(?!false\b)[^)\s]+/i.test(codeOnly)) hasMeasurementsCall = true;
    if (/\.setContentGenre\s*\(/i.test(codeOnly) && /\.setContentId\s*\(/i.test(codeOnly)) {
      hasContentMetaCall = true;
    }
    if (/\.IsRIDADisabled\s*\(/i.test(codeOnly)) anyLatCheckInRepo = true;
  }

  for (const bFile of brs) {
    const codeLines = bFile.lines.map(stripBrsComment);
    const codeOnly = codeLines.join('\n');
    const compInfo = brsToComponent.get(bFile.relPath);

    // 1. Check Library "Roku_Ads.brs" scope when Roku_Ads() is called
    const rokuAdsLine = findLineNumber(bFile.lines, /\bRoku_Ads\s*\(/i);
    if (rokuAdsLine !== undefined) {
      const siblingFiles = compInfo
        ? compInfo.siblingBrsPaths.map((p) => byRelPath.get(p)).filter(Boolean)
        : bFile.relPath.startsWith('source/')
          ? brs.filter((f) => f.relPath.startsWith('source/'))
          : [bFile];

      const hasLibImport = siblingFiles.some((sf) =>
        sf!.lines.some((l) => /^\s*Library\s+"Roku_Ads\.brs"/i.test(stripBrsComment(l)))
      );
      if (!hasLibImport) {
        findings.push({
          severity: 'error',
          code: 'BRS_MISSING_RAF_LIBRARY_IMPORT',
          title: 'Missing Library "Roku_Ads.brs" in component scope',
          file: bFile.relPath,
          line: rokuAdsLine,
          message: `Roku_Ads() called in ${bFile.relPath} without Library "Roku_Ads.brs" in its script scope.`,
          fixHint: 'Add `Library "Roku_Ads.brs"` at line 1 of the Task component .brs file.',
        });
      }
    }

    // 2. SceneGraph Render-Thread violation check (RAF or roUrlTransfer on non-Task component)
    if (compInfo && compInfo.extendsType.toLowerCase() !== 'task') {
      const renderRafLine = findLineNumber(
        bFile.lines,
        /\bRoku_Ads\s*\(|\.getAds\s*\(|\.showAds\s*\(|\.renderStitchedStream\s*\(/i
      );
      if (renderRafLine !== undefined) {
        findings.push({
          severity: 'error',
          code: 'SG_RAF_ON_RENDER_THREAD',
          title: `RAF executed on SceneGraph Render Thread (${compInfo.componentName} extends ${compInfo.extendsType})`,
          file: bFile.relPath,
          line: renderRafLine,
          message: `Roku_Ads / ad playback is invoked inside "${compInfo.componentName}" (extends="${compInfo.extendsType}") instead of a Task node.`,
          fixHint: 'Move all Roku_Ads(), getAds(), showAds(), and network calls into a <component extends="Task"> thread.',
        });
      }

      const renderUrlLine = findLineNumber(bFile.lines, /CreateObject\s*\(\s*"roUrlTransfer"\s*\)/i);
      if (renderUrlLine !== undefined) {
        findings.push({
          severity: 'error',
          code: 'SG_NETWORK_ON_RENDER_THREAD',
          title: `roUrlTransfer created on SceneGraph Render Thread (${compInfo.componentName})`,
          file: bFile.relPath,
          line: renderUrlLine,
          message: `Creating roUrlTransfer on the SceneGraph render thread fails on Roku OS and violates certification.`,
          fixHint: 'Run roUrlTransfer exclusively inside a SceneGraph Task component.',
        });
      }
    }

    // 3. Invalid raf.setMaxVideoDecodeResolution() call (Roku OS 16 crash)
    const badMaxResLine = findLineNumber(bFile.lines, /\.setMaxVideoDecodeResolution\s*\(/i);
    if (badMaxResLine !== undefined) {
      findings.push({
        severity: 'error',
        code: 'RAF_INVALID_MAX_RES_METHOD',
        title: 'Invalid raf.setMaxVideoDecodeResolution() call (crashes Roku OS 16)',
        file: bFile.relPath,
        line: badMaxResLine,
        message: 'roku_ads_lib 3.31+ does not expose setMaxVideoDecodeResolution() on the RAF object.',
        fixHint: 'Set maxVideoDecodeResolution on the SceneGraph Video node: `if video.hasField("maxVideoDecodeResolution") then video.maxVideoDecodeResolution = [1920, 1080]`.',
      });
    }

    // 4. PostFromString() treated as JSON string instead of HTTP status integer
    const syncPostLine = findLineNumber(
      bFile.lines,
      /(?:ParseJson\s*\([^)]*\.PostFromString\s*\(|=\s*[a-zA-Z0-9_.]+\.PostFromString\s*\()/i
    );
    if (syncPostLine !== undefined) {
      const rawLine = stripBrsComment(bFile.lines[syncPostLine - 1] || '');
      if (!/\bcode\b|\bstatus\b/i.test(rawLine)) {
        findings.push({
          severity: 'warning',
          code: 'RAF_SYNC_POST_FROM_STRING_TRAP',
          title: 'roUrlTransfer.PostFromString() returns Integer HTTP status, not body string',
          file: bFile.relPath,
          line: syncPostLine,
          message: 'PostFromString() returns an Integer status code on Roku BrightScript, causing ParseJson() type mismatch crashes.',
          fixHint: 'Use AsyncPostFromString() + wait(timeout, port) and read roUrlEvent.GetString() for DAI/JSON POST bodies.',
        });
      }
    }

    // 5. constructStitchedStream called with plain associative array literal
    const plainAaStitchLine = findLineNumber(bFile.lines, /\.constructStitchedStream\s*\(\s*\{/i);
    if (plainAaStitchLine !== undefined) {
      findings.push({
        severity: 'error',
        code: 'RAF_STITCHED_REQUIRES_CONTENTNODE',
        title: 'constructStitchedStream() requires a SceneGraph ContentNode',
        file: bFile.relPath,
        line: plainAaStitchLine,
        message: 'Passing a plain associative array `{...}` to raf.constructStitchedStream() fails in SceneGraph channels.',
        fixHint: 'Pass `CreateObject("roSGNode", "ContentNode")` populated with url, streamFormat, title, and length.',
      });
    }

    // 6. setTrackingCallback(cb, m) with setDebugOutput(true) stall
    const mCtxLine = findLineNumber(bFile.lines, /\.setTrackingCallback\s*\([^,]+,\s*m\s*\)/i);
    if (mCtxLine !== undefined && /\.setDebugOutput\s*\(\s*true\s*\)/i.test(codeOnly)) {
      findings.push({
        severity: 'warning',
        code: 'RAF_TRACKING_CALLBACK_M_DUMP',
        title: 'setTrackingCallback(cb, m) with setDebugOutput(true) dumps ~120KB per tick',
        file: bFile.relPath,
        line: mCtxLine,
        message: 'Passing `m` as tracking callback context causes RAF debug logging to serialize the entire Task scope on :8085 every second.',
        fixHint: 'Pass an empty context AA `{}` (`raf.setTrackingCallback(cb, {})`) or disable setDebugOutput in production.',
      });
    }

    // 7. GetRIDA() without IsRIDADisabled() Limit Ad Tracking check
    const ridaLine = findLineNumber(bFile.lines, /\.GetRIDA\s*\(/i);
    if (ridaLine !== undefined && !/\.IsRIDADisabled\s*\(/i.test(codeOnly) && !anyLatCheckInRepo) {
      findings.push({
        severity: 'error',
        code: 'RIDA_WITHOUT_LAT_CHECK',
        title: 'GetRIDA() called without checking IsRIDADisabled() (Privacy / Cert Failure)',
        file: bFile.relPath,
        line: ridaLine,
        message: 'Channel reads personal RIDA identifier without checking roDeviceInfo.IsRIDADisabled() for Limit Ad Tracking.',
        fixHint: 'Check `if devInfo.IsRIDADisabled() then rida = "00000000-0000-0000-0000-000000000000"` and pass `is_lat=1`.',
      });
    }

    // 8. SceneGraph showAds(pods) missing 3rd viewNode parameter
    if (bFile.relPath.startsWith('components/')) {
      const singleArgShowAds = findLineNumber(bFile.lines, /\.showAds\s*\(\s*[a-zA-Z0-9_.]+\s*\)/i);
      if (singleArgShowAds !== undefined) {
        findings.push({
          severity: 'warning',
          code: 'SHOW_ADS_MISSING_VIEW_NODE',
          title: 'raf.showAds() in SceneGraph called without parent viewNode argument',
          file: bFile.relPath,
          line: singleArgShowAds,
          message: 'Calling raf.showAds(adPods) with 1 argument in SceneGraph prevents interactive overlays and clean Back-key handling.',
          fixHint: 'Pass a SceneGraph Group/Video parent as the 3rd argument: `raf.showAds(adPods, invalid, viewNode)`.',
        });
      }
    }

    // 9. Reserved BrightScript builtin function used as variable name (compile error &h9d)
    const reservedVarLine = findLineNumber(
      bFile.lines,
      /^\s*(pos|tab|rnd|sgn|len|val|str|chr|asc)\s*=/i
    );
    if (reservedVarLine !== undefined) {
      findings.push({
        severity: 'error',
        code: 'BRS_RESERVED_BUILTIN_VARIABLE',
        title: 'Reserved BrightScript builtin function name used as variable (compile error &h9d)',
        file: bFile.relPath,
        line: reservedVarLine,
        message: 'Assigning to a reserved BrightScript builtin identifier (such as `pos`, `tab`, `len`, or `str`) fails Roku compilation with &h9d.',
        fixHint: 'Rename the local variable (e.g., use `playPos` instead of `pos`).',
      });
    }
  }

  // Repo-wide Nielsen / OMID measurement metadata check
  if (anyRafCall && (!hasMeasurementsCall || !hasContentMetaCall)) {
    findings.push({
      severity: 'warning',
      code: 'MISSING_RAF_MEASUREMENTS_METADATA',
      title: 'Incomplete RAF Ad Measurements / Content Metadata configuration',
      file: brs[0]?.relPath || 'components',
      message:
        'Channel initializes Roku_Ads() without calling enableAdMeasurements(true), setContentId(), and setContentGenre().',
      fixHint:
        'Call raf.enableAdMeasurements(true), raf.setContentId(...), raf.setContentGenre(...), and raf.setContentLength(...) for Roku Certification.',
    });
  }

  // Deep-linking Certification 4.1 check: contentId handled without mediaType
  const allCodeJoined = brs.map((b) => b.lines.map(stripBrsComment).join('\n')).join('\n');
  const handlesDeepLinkContentId = /\.(?:launchArgs|externalInput)\b[\s\S]{0,400}\bcontentId\b|\bargs\.contentId\b|\bparams\.contentId\b/i.test(
    allCodeJoined
  );
  const handlesMediaType = /\bmediaType\b/i.test(allCodeJoined);
  if (handlesDeepLinkContentId && !handlesMediaType) {
    findings.push({
      severity: 'warning',
      code: 'DEEP_LINK_MISSING_MEDIATYPE',
      title: 'Deep-link handler inspects contentId without mediaType (Roku Cert 4.1)',
      file: brs.find((b) => /\bcontentId\b/i.test(b.content))?.relPath || 'source/Main.brs',
      message: 'Channel reads deep-link contentId on launch/input without handling mediaType (movie, episode, live, shortFormVideo).',
      fixHint: 'Inspect `params.mediaType` alongside `params.contentId` so live vs. shortFormVideo vs. long-form VOD ad policies are applied.',
    });
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  const infos = findings.filter((f) => f.severity === 'info').length;
  const score = Math.max(0, Math.min(100, 100 - errors * 25 - warnings * 8));

  return {
    repoPath: root,
    scannedAt: new Date().toISOString(),
    rafReady: errors === 0 && manifestFound,
    score,
    filesScanned: {
      manifestFound,
      brsFiles: brs.length,
      xmlFiles: xml.length,
    },
    summary: { errors, warnings, infos },
    findings,
  };
}
