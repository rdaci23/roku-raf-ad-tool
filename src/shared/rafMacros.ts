import type { RafMacroValues } from './types.js';

export const DEFAULT_RAF_MACROS: RafMacroValues = {
  ROKU_ADS_TRACKING_ID: '8a9e4c12-51f0-4f88-9b30-77d1c0ffee42',
  ROKU_ADS_LIMIT_TRACKING: '0',
  ROKU_ADS_CACHE_BUSTER: '984512309',
  ROKU_ADS_APP_ID: 'dev',
  ROKU_ADS_APP_VERSION: '1.0.0',
  ROKU_ADS_CONTENT_ID: 'ep-101-pilot',
  ROKU_ADS_CONTENT_GENRE: 'Action,SciFi',
  ROKU_ADS_CONTENT_LENGTH: '1800',
  ROKU_ADS_DEVICE_MODEL: '4802X',
  ROKU_ADS_DISPLAY_WIDTH: '1920',
  ROKU_ADS_DISPLAY_HEIGHT: '1080',
  ROKU_ADS_EXTERNAL_IP: '198.51.100.24',
};

export const VAST_ERROR_CODES: Record<string, string> = {
  '100': 'XML parsing error',
  '101': 'VAST schema validation error',
  '102': 'VAST version of response not supported',
  '200': 'Trafficking error — player received unexpected ad type',
  '201': 'Video player expecting different linearity',
  '202': 'Video player expecting different duration',
  '203': 'Video player expecting different size',
  '300': 'General Wrapper error',
  '301': 'Timeout of VAST URI provided in Wrapper element',
  '302': 'Wrapper limit reached (Roku RAF max wrapper depth exceeded)',
  '303': 'No VAST response after one or more Wrappers (Empty / No-Fill)',
  '400': 'General Linear error — Video player is unable to display the Linear Ad',
  '401': 'File not found — Unable to find Linear/MediaFile from URI',
  '402': 'Timeout of MediaFile URI',
  '403': 'Could not find MediaFile supported by this video player (common on Roku for VPAID/WebM)',
  '405': 'Problem displaying MediaFile (codec/transport error on Roku)',
  '600': 'General CompanionAds error',
  '900': 'Undefined VAST error',
};

const KNOWN_MACRO_PATTERNS = [
  /ROKU_ADS_[A-Z0-9_]+/g,
  /\[CACHEBUSTING\]/gi,
  /\[TIMESTAMP\]/gi,
  /\[ERRORCODE\]/gi,
  /\[CONTENTPLAYHEAD\]/gi,
];

export function expandRafMacros(urlOrXml: string, overrides?: Partial<RafMacroValues>): string {
  const values: RafMacroValues = {
    ...DEFAULT_RAF_MACROS,
    ROKU_ADS_CACHE_BUSTER: String(Math.floor(100000000 + Math.random() * 900000000)),
    ...overrides,
  };

  let out = urlOrXml;
  for (const [key, val] of Object.entries(values)) {
    out = out.split(key).join(encodeURIComponent(val));
    out = out.split(`[${key}]`).join(encodeURIComponent(val));
    out = out.split(`{{${key}}}`).join(encodeURIComponent(val));
  }
  out = out.replace(/\[CACHEBUSTING\]/gi, values.ROKU_ADS_CACHE_BUSTER);
  out = out.replace(/\[TIMESTAMP\]/gi, encodeURIComponent(new Date().toISOString()));
  return out;
}

export function detectUnexpandedMacros(input: string): string[] {
  const found = new Set<string>();
  for (const pattern of KNOWN_MACRO_PATTERNS) {
    const matches = input.match(pattern);
    if (matches) {
      for (const m of matches) {
        // [ERRORCODE] and [CONTENTPLAYHEAD] are runtime player macros inside VAST XML, only flag ROKU_ADS_* if left unexpanded
        found.add(m);
      }
    }
  }
  return Array.from(found);
}
