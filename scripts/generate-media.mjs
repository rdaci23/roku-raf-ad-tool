#!/usr/bin/env node
import { mkdirSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHANNEL_IMAGES_DIR = join(ROOT, 'roku-channel', 'images');
const MEDIA_DIR = process.env.RAF_MEDIA_DIR || join(ROOT, 'public', 'media');
const HLS_DIR = join(MEDIA_DIR, 'hls');
const DASH_DIR = join(MEDIA_DIR, 'dash');
const FORCE = process.argv.includes('--force');
const SKIP_CHANNEL_IMAGES = process.env.RAF_SKIP_CHANNEL_IMAGES === '1';

if (!SKIP_CHANNEL_IMAGES) {
  mkdirSync(CHANNEL_IMAGES_DIR, { recursive: true });
}
mkdirSync(HLS_DIR, { recursive: true });
mkdirSync(DASH_DIR, { recursive: true });

// Cross-platform font lookup: Linux, macOS, and Windows
const BOLD_FONT_CANDIDATES = [
  '/usr/share/fonts/noto/NotoSans-Bold.ttf',
  '/usr/share/fonts/Adwaita/AdwaitaSans-Regular.ttf',
  '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  'C:/Windows/Fonts/arialbd.ttf',
  'C:/Windows/Fonts/seguisb.ttf',
];
const MONO_FONT_CANDIDATES = [
  '/usr/share/fonts/Adwaita/AdwaitaMono-Regular.ttf',
  '/usr/share/fonts/noto/NotoSans-Regular.ttf',
  '/usr/share/fonts/TTF/DejaVuSansMono.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  '/System/Library/Fonts/Menlo.ttc',
  '/System/Library/Fonts/Supplemental/Courier New Bold.ttf',
  'C:/Windows/Fonts/consola.ttf',
  'C:/Windows/Fonts/cour.ttf',
];

function escapeFontPathForFfmpeg(p) {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

const BOLD_FONT = escapeFontPathForFfmpeg(BOLD_FONT_CANDIDATES.find((p) => existsSync(p)) || '');
const MONO_FONT = escapeFontPathForFfmpeg(MONO_FONT_CANDIDATES.find((p) => existsSync(p)) || '') || BOLD_FONT;

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function createSolidGradientPng(width, height, topRgb, bottomRgb, accentRgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  const border = Math.max(4, Math.floor(Math.min(width, height) * 0.04));

  for (let y = 0; y < height; y++) {
    const rowOffset = y * stride;
    raw[rowOffset] = 0;
    const t = y / Math.max(1, height - 1);
    const baseR = Math.round(topRgb[0] * (1 - t) + bottomRgb[0] * t);
    const baseG = Math.round(topRgb[1] * (1 - t) + bottomRgb[1] * t);
    const baseB = Math.round(topRgb[2] * (1 - t) + bottomRgb[2] * t);

    const isAccentBar = y >= Math.floor(height * 0.46) && y <= Math.floor(height * 0.54);
    for (let x = 0; x < width; x++) {
      const px = rowOffset + 1 + x * 3;
      const isFrame = x < border || x >= width - border || y < border || y >= height - border;
      const inCenterBar = isAccentBar && x >= Math.floor(width * 0.22) && x <= Math.floor(width * 0.78);
      if (isFrame || inCenterBar) {
        raw[px] = accentRgb[0];
        raw[px + 1] = accentRgb[1];
        raw[px + 2] = accentRgb[2];
      } else {
        raw[px] = baseR;
        raw[px + 1] = baseG;
        raw[px + 2] = baseB;
      }
    }
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const pngTargets = [
  { file: 'mm_icon_focus_fhd.png', w: 540, h: 405 },
  { file: 'mm_icon_focus_hd.png', w: 290, h: 218 },
  { file: 'mm_icon_focus_sd.png', w: 214, h: 144 },
  { file: 'splash_screen_fhd.png', w: 1920, h: 1080 },
  { file: 'splash_screen_hd.png', w: 1280, h: 720 },
];

if (!SKIP_CHANNEL_IMAGES) {
  for (const item of pngTargets) {
    const out = join(CHANNEL_IMAGES_DIR, item.file);
    if (!existsSync(out) || FORCE) {
      const buf = createSolidGradientPng(item.w, item.h, [18, 16, 46], [42, 20, 88], [139, 92, 246]);
      writeFileSync(out, buf);
    }
  }
}

const companionPng = join(MEDIA_DIR, 'companion-banner.png');
if (!existsSync(companionPng) || FORCE) {
  writeFileSync(companionPng, createSolidGradientPng(300, 250, [30, 27, 75], [15, 118, 110], [56, 189, 248]));
}

const interactiveJson = join(MEDIA_DIR, 'interactive-overlay.json');
if (!existsSync(interactiveJson) || FORCE) {
  writeFileSync(
    interactiveJson,
    JSON.stringify({ version: '1.0', provider: 'RokuRAFTestInteractive', widgets: [{ type: 'cta', text: 'Press OK for Offer' }] }, null, 2)
  );
}

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

function escText(s) {
  return s.replace(/:/g, '\\:').replace(/'/g, '');
}

function buildAdCommercialMp4({ filename, durationSec, c0, c1, c2, accentHex, badge, headline, subtitle, baseFreq }) {
  const outPath = join(MEDIA_DIR, filename);
  if (existsSync(outPath) && !FORCE) return;
  const tmpPath = `${outPath}.tmp.mp4`;

  const q1 = (durationSec * 0.25).toFixed(2);
  const q2 = (durationSec * 0.5).toFixed(2);
  const q3 = (durationSec * 0.75).toFixed(2);
  const end = durationSec.toFixed(2);

  const fontArgBold = BOLD_FONT ? `fontfile='${BOLD_FONT}':` : '';
  const fontArgMono = MONO_FONT ? `fontfile='${MONO_FONT}':` : '';

  const filterComplex = [
    `[0:v]drawbox=x=100:y=130:w=1080:h=440:color=0x090d16@0.82:t=fill`,
    `drawbox=x=100:y=130:w=1080:h=8:color=${accentHex}:t=fill`,
    `drawbox=x=140:y=170:w=280:h=44:color=${accentHex}@0.28:t=fill`,
    `drawtext=${fontArgBold}expansion=none:text='${escText(badge)}':fontcolor=white:fontsize=24:x=158:y=181`,
    `drawtext=${fontArgBold}expansion=none:text='${escText(headline)}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=255`,
    `drawtext=${fontArgMono}expansion=none:text='${escText(subtitle)}':fontcolor=0xcbd5e1:fontsize=24:x=(w-text_w)/2:y=330`,
    `drawtext=${fontArgMono}text='TIME %{pts\\:hms}   |   AD ENDS IN %{eif\\:ceil(${durationSec}-t)\\:d}s':fontcolor=0x38bdf8:fontsize=28:x=(w-text_w)/2:y=405`,
    `drawtext=${fontArgBold}expansion=none:text='QUARTILE\\: START (0%)':fontcolor=0xa78bfa:fontsize=28:x=(w-text_w)/2:y=485:enable='between(t,0,${q1})'`,
    `drawtext=${fontArgBold}expansion=none:text='QUARTILE\\: FIRST QUARTILE (25%)':fontcolor=0x38bdf8:fontsize=28:x=(w-text_w)/2:y=485:enable='between(t,${q1},${q2})'`,
    `drawtext=${fontArgBold}expansion=none:text='QUARTILE\\: MIDPOINT (50%)':fontcolor=0xfbbf24:fontsize=28:x=(w-text_w)/2:y=485:enable='between(t,${q2},${q3})'`,
    `drawtext=${fontArgBold}expansion=none:text='QUARTILE\\: THIRD QUARTILE (75%)':fontcolor=0x34d399:fontsize=28:x=(w-text_w)/2:y=485:enable='between(t,${q3},${end})'[card]`,
    `[card][1:v]overlay=x='-1280+1280*(t/${durationSec})':y=704[v]`,
  ].join(',');

  const res = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `gradients=s=1280x720:r=30:d=${durationSec}:c0=${c0}:c1=${c1}:c2=${c2}:speed=0.04`,
      '-f',
      'lavfi',
      '-i',
      `color=c=${accentHex}:s=1280x16:r=30:d=${durationSec}`,
      '-f',
      'lavfi',
      '-i',
      `aevalsrc='0.05*sin(2*PI*${baseFreq}*t)+0.03*sin(2*PI*${(baseFreq * 1.25).toFixed(2)}*t)':s=48000:d=${durationSec}`,
      '-filter_complex',
      filterComplex,
      '-map',
      '[v]',
      '-map',
      '2:a',
      '-c:v',
      'libx264',
      '-profile:v',
      'main',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'ultrafast',
      '-g',
      '30',
      '-b:v',
      '1800k',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      tmpPath,
    ],
    { stdio: 'pipe' }
  );

  if (res.status === 0) {
    renameSync(tmpPath, outPath);
  }
}

function buildMainContentMp4({ filename, durationSec }) {
  const outPath = join(MEDIA_DIR, filename);
  if (existsSync(outPath) && !FORCE) return;
  const tmpPath = `${outPath}.tmp.mp4`;

  const fontArgBold = BOLD_FONT ? `fontfile='${BOLD_FONT}':` : '';
  const fontArgMono = MONO_FONT ? `fontfile='${MONO_FONT}':` : '';

  const vf = [
    `drawbox=x=0:y=560:w=1280:h=160:color=0x090d16@0.86:t=fill`,
    `drawbox=x=0:y=560:w=1280:h=5:color=0x8b5cf6:t=fill`,
    `drawtext=${fontArgBold}expansion=none:text='MAIN FEATURE CONTENT — EPISODE 101 (PILOT)':fontcolor=white:fontsize=36:x=48:y=585`,
    `drawtext=${fontArgMono}text='STREAM TIME %{pts\\:hms}  |  VMAP MIDROLL @ 00\\:10  |  POSTROLL @ 00\\:30':fontcolor=0x94a3b8:fontsize=24:x=48:y=645`,
  ].join(',');

  const res = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=s=1280x720:r=30:d=${durationSec}`,
      '-f',
      'lavfi',
      '-i',
      `aevalsrc='0.03*sin(2*PI*220*t)+0.02*sin(2*PI*330*t)':s=48000:d=${durationSec}`,
      '-vf',
      vf,
      '-c:v',
      'libx264',
      '-profile:v',
      'main',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'ultrafast',
      '-g',
      '30',
      '-b:v',
      '1800k',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      tmpPath,
    ],
    { stdio: 'pipe' }
  );

  if (res.status === 0) {
    renameSync(tmpPath, outPath);
  }
}

function buildRichTsSegment({ filename, durationSec, isAd, label, sublabel, c0, c1, freqHz }) {
  const outPath = join(HLS_DIR, filename);
  if (existsSync(outPath) && !FORCE) return;
  const tmpPath = `${outPath}.tmp.ts`;

  const fontArgBold = BOLD_FONT ? `fontfile='${BOLD_FONT}':` : '';
  const fontArgMono = MONO_FONT ? `fontfile='${MONO_FONT}':` : '';

  const videoInput = isAd
    ? `gradients=s=1280x720:r=30:d=${durationSec}:c0=${c0}:c1=${c1}:speed=0.05`
    : `testsrc2=s=1280x720:r=30:d=${durationSec}`;

  const vf = [
    `drawbox=x=80:y=490:w=1120:h=180:color=0x090d16@0.85:t=fill`,
    `drawbox=x=80:y=490:w=1120:h=6:color=${isAd ? '0xf59e0b' : '0x38bdf8'}:t=fill`,
    `drawtext=${fontArgBold}expansion=none:text='${escText(label)}':fontcolor=white:fontsize=38:x=120:y=522`,
    `drawtext=${fontArgMono}expansion=none:text='${escText(sublabel)}':fontcolor=0x6ee7b7:fontsize=24:x=120:y=590`,
    `drawtext=${fontArgMono}text='SEG %{pts\\:hms}':fontcolor=0x38bdf8:fontsize=24:x=980:y=590`,
  ].join(',');

  const res = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      videoInput,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${freqHz}:sample_rate=48000:duration=${durationSec}`,
      '-af',
      'volume=0.06',
      '-vf',
      vf,
      '-c:v',
      'libx264',
      '-profile:v',
      'main',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'ultrafast',
      '-g',
      '30',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-f',
      'mpegts',
      tmpPath,
    ],
    { stdio: 'pipe' }
  );

  if (res.status === 0) {
    renameSync(tmpPath, outPath);
  }
}

function buildDashStream() {
  const mpdPath = join(DASH_DIR, 'stream.mpd');
  if (existsSync(mpdPath) && !FORCE) return;

  const fontArgBold = BOLD_FONT ? `fontfile='${BOLD_FONT}':` : '';
  const vf = [
    `drawbox=x=0:y=560:w=1280:h=160:color=0x090d16@0.86:t=fill`,
    `drawtext=${fontArgBold}expansion=none:text='MPEG-DASH (.mpd) STREAM — ROKU PLAYER VERIFIED':fontcolor=white:fontsize=36:x=48:y=615`,
  ].join(',');

  spawnSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=1280x720:r=30:d=8',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=392:sample_rate=48000:duration=8',
      '-af',
      'volume=0.05',
      '-vf',
      vf,
      '-c:v',
      'libx264',
      '-profile:v',
      'main',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'ultrafast',
      '-g',
      '60',
      '-keyint_min',
      '60',
      '-sc_threshold',
      '0',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-seg_duration',
      '4',
      '-use_template',
      '1',
      '-use_timeline',
      '1',
      '-f',
      'dash',
      mpdPath,
    ],
    { cwd: DASH_DIR, stdio: 'pipe' }
  );
}

if (hasFfmpeg) {
  buildAdCommercialMp4({
    filename: 'ad-spot-1.mp4',
    durationSec: 8,
    c0: '0x4c1d95',
    c1: '0x1d4ed8',
    c2: '0x0ea5e9',
    accentHex: '0x38bdf8',
    badge: 'SPONSORED • AD 1',
    headline: 'ACME CLOUD STREAMING+',
    subtitle: 'Roku RAF Linear Creative • 720p H.264/AAC',
    baseFreq: 440,
  });

  buildAdCommercialMp4({
    filename: 'ad-spot-2.mp4',
    durationSec: 8,
    c0: '0x064e3b',
    c1: '0x0f766e',
    c2: '0x10b981',
    accentHex: '0x34d399',
    badge: 'SPONSORED • AD 2',
    headline: 'NOVA ELECTRIC GT COUPE',
    subtitle: 'Pod Spot #2 • Skippable @ 00:05 • Quartile Verified',
    baseFreq: 523.25,
  });

  buildAdCommercialMp4({
    filename: 'ad-spot-3.mp4',
    durationSec: 6,
    c0: '0x7c2d12',
    c1: '0xb45309',
    c2: '0xd97706',
    accentHex: '0xfbbf24',
    badge: 'SPONSORED • AD 3',
    headline: 'HYPERION CLOUD GAMING',
    subtitle: 'Pod Spot #3 / Buffet Creative • 6s Spot',
    baseFreq: 587.33,
  });

  buildAdCommercialMp4({
    filename: 'ad-spot-skip.mp4',
    durationSec: 12,
    c0: '0x1e1b4b',
    c1: '0xbe185d',
    c2: '0x7c3aed',
    accentHex: '0xf472b6',
    badge: 'SKIPPABLE @ 5s',
    headline: 'SOLARIS ULTRA SOUND SYSTEM',
    subtitle: '12s Skippable Creative • skipoffset=00:00:05',
    baseFreq: 493.88,
  });

  buildMainContentMp4({
    filename: 'content-main.mp4',
    durationSec: 30,
  });

  buildRichTsSegment({
    filename: 'content-seg1.ts',
    durationSec: 5,
    isAd: false,
    label: 'HLS CONTENT STREAM — SEGMENT 1',
    sublabel: 'Pre-Break Program Feed (0s - 5s)',
    c0: '0x1e293b',
    c1: '0x334155',
    freqHz: 330,
  });
  buildRichTsSegment({
    filename: 'content-seg2.ts',
    durationSec: 5,
    isAd: false,
    label: 'HLS CONTENT STREAM — SEGMENT 2',
    sublabel: 'Approaching SCTE-35 / DATERANGE Ad Cue (5s - 10s)',
    c0: '0x1e293b',
    c1: '0x334155',
    freqHz: 349,
  });
  buildRichTsSegment({
    filename: 'ad-seg1.ts',
    durationSec: 5,
    isAd: true,
    label: 'SSAI STITCHED AD BREAK — PART 1 OF 2',
    sublabel: 'SCTE-35 / DATERANGE Active (Impression -> 25% -> 50%)',
    c0: '0x581c87',
    c1: '0x2563eb',
    freqHz: 523,
  });
  buildRichTsSegment({
    filename: 'ad-seg2.ts',
    durationSec: 5,
    isAd: true,
    label: 'SSAI STITCHED AD BREAK — PART 2 OF 2',
    sublabel: 'SCTE-35 / DATERANGE Active (50% -> 75% -> Complete)',
    c0: '0x4c1d95',
    c1: '0x0d9488',
    freqHz: 659,
  });
  buildRichTsSegment({
    filename: 'content-seg3.ts',
    durationSec: 5,
    isAd: false,
    label: 'HLS CONTENT STREAM — SEGMENT 3',
    sublabel: 'Returned from Stitched Ad Break (#EXT-X-CUE-IN)',
    c0: '0x1e293b',
    c1: '0x334155',
    freqHz: 330,
  });
  buildRichTsSegment({
    filename: 'content-seg4.ts',
    durationSec: 5,
    isAd: false,
    label: 'HLS CONTENT STREAM — SEGMENT 4',
    sublabel: 'Program Continuation',
    c0: '0x1e293b',
    c1: '0x334155',
    freqHz: 330,
  });

function buildAbrTsLadder() {
  const rungs = [
    { key: '234p', w: 416, h: 234, vb: '380k', fsTitle: 14, fsSub: 10, boxX: 20, boxY: 150, boxW: 376, boxH: 68 },
    { key: '432p', w: 768, h: 432, vb: '950k', fsTitle: 24, fsSub: 15, boxX: 44, boxY: 285, boxW: 680, boxH: 115 },
    { key: '720p', w: 1280, h: 720, vb: '2200k', fsTitle: 38, fsSub: 24, boxX: 80, boxY: 490, boxW: 1120, boxH: 180 },
  ];

  const specs = [
    { slug: 'content-1', dur: 5, isAd: false, label: 'ABR LIVE/VOD PROGRAM — PART 1', sub: 'Pre-Break Content Feed', c0: '0x1e293b', c1: '0x334155', freq: 330 },
    { slug: 'ad-brand', dur: 5, isAd: true, label: 'POD 1 • SPOT 1/2 — BRAND AD', sub: 'Stitched ABR Commercial (5s)', c0: '0x1e3a8a', c1: '0x6d28d9', freq: 440 },
    { slug: 'ad-promo', dur: 5, isAd: true, label: 'POD 1 • SPOT 2/2 — PROMO SPOT', sub: 'Stitched ABR Promo Ad (5s)', c0: '0x065f46', c1: '0x0d9488', freq: 523 },
    { slug: 'content-2', dur: 5, isAd: false, label: 'ABR LIVE/VOD PROGRAM — PART 2', sub: 'Mid-Program Content Feed', c0: '0x1e293b', c1: '0x334155', freq: 349 },
    { slug: 'ad-bumper', dur: 5, isAd: true, label: 'POD 2 • SPONSOR BUMPER AD', sub: 'Stitched ABR Bumper Spot (5s)', c0: '0x7c2d12', c1: '0xd97706', freq: 587 },
    { slug: 'content-3', dur: 5, isAd: false, label: 'ABR LIVE/VOD PROGRAM — PART 3', sub: 'Post-Break Content Feed', c0: '0x1e293b', c1: '0x334155', freq: 330 },
  ];

  const fontArgBold = BOLD_FONT ? `fontfile='${BOLD_FONT}':` : '';
  const fontArgMono = MONO_FONT ? `fontfile='${MONO_FONT}':` : '';

  for (const r of rungs) {
    for (const sp of specs) {
      const outPath = join(HLS_DIR, `abr-${r.key}-${sp.slug}.ts`);
      if (existsSync(outPath) && !FORCE) continue;
      const tmpPath = `${outPath}.tmp.ts`;
      const videoInput = sp.isAd
        ? `gradients=s=${r.w}x${r.h}:r=30:d=${sp.dur}:c0=${sp.c0}:c1=${sp.c1}:speed=0.05`
        : `testsrc2=s=${r.w}x${r.h}:r=30:d=${sp.dur}`;
      const vf = [
        `drawbox=x=${r.boxX}:y=${r.boxY}:w=${r.boxW}:h=${r.boxH}:color=0x090d16@0.85:t=fill`,
        `drawbox=x=${r.boxX}:y=${r.boxY}:w=${r.boxW}:h=4:color=${sp.isAd ? '0xf59e0b' : '0x38bdf8'}:t=fill`,
        `drawtext=${fontArgBold}expansion=none:text='${escText(`${sp.label} [${r.key}]`)}':fontcolor=white:fontsize=${r.fsTitle}:x=${r.boxX + 16}:y=${r.boxY + 14}`,
        `drawtext=${fontArgMono}expansion=none:text='${escText(sp.sub)}':fontcolor=0x6ee7b7:fontsize=${r.fsSub}:x=${r.boxX + 16}:y=${r.boxY + Math.round(r.boxH * 0.58)}`,
      ].join(',');

      const res = spawnSync(
        'ffmpeg',
        [
          '-y',
          '-f',
          'lavfi',
          '-i',
          videoInput,
          '-f',
          'lavfi',
          '-i',
          `sine=frequency=${sp.freq}:sample_rate=48000:duration=${sp.dur}`,
          '-af',
          'volume=0.06',
          '-vf',
          vf,
          '-c:v',
          'libx264',
          '-profile:v',
          'main',
          '-pix_fmt',
          'yuv420p',
          '-preset',
          'ultrafast',
          '-b:v',
          r.vb,
          '-maxrate',
          r.vb,
          '-bufsize',
          '1500k',
          '-g',
          '30',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-f',
          'mpegts',
          tmpPath,
        ],
        { stdio: 'pipe' }
      );
      if (res.status === 0) {
        renameSync(tmpPath, outPath);
      }
    }
  }
}

  buildDashStream();
  buildAbrTsLadder();
}

console.log('[setup:assets] Cross-platform commercials, skippable spot, HLS & MPEG-DASH streams ready.');
