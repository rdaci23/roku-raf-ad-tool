import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { deflateRawSync } from 'node:zlib';

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntryInput {
  path: string; // forward-slash relative path inside archive
  data: Buffer;
}

function collectFilesRecursive(rootDir: string, currentDir: string, entries: ZipEntryInput[]): void {
  for (const item of readdirSync(currentDir)) {
    const full = join(currentDir, item);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectFilesRecursive(rootDir, full, entries);
    } else if (st.isFile()) {
      const rel = relative(rootDir, full).split('\\').join('/');
      entries.push({ path: rel, data: readFileSync(full) });
    }
  }
}

/**
 * Pure Node.js PKZIP archive builder (works identically on Linux, macOS, and Windows with zero CLI dependencies).
 */
export function createZipFromDirectory(rootDir: string, includeTopItems?: string[]): Buffer {
  const entries: ZipEntryInput[] = [];
  if (includeTopItems && includeTopItems.length > 0) {
    for (const top of includeTopItems) {
      const full = join(rootDir, top);
      const st = statSync(full);
      if (st.isDirectory()) {
        collectFilesRecursive(rootDir, full, entries);
      } else if (st.isFile()) {
        entries.push({ path: top.split('\\').join('/'), data: readFileSync(full) });
      }
    }
  } else {
    collectFilesRecursive(rootDir, rootDir, entries);
  }

  return createZipFromEntries(entries);
}

export function createZipFromEntries(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.path, 'utf8');
    const uncompressedSize = entry.data.length;
    const crc = crc32(entry.data);

    // PNGs are already compressed; store tiny files or compress larger text files
    const compressed = deflateRawSync(entry.data, { level: 6 });
    const useDeflate = compressed.length < uncompressedSize;
    const payload = useDeflate ? compressed : entry.data;
    const method = useDeflate ? 8 : 0;

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x5976, 12); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra len

    localParts.push(localHeader, nameBuf, payload);

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x5976, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra len
    centralHeader.writeUInt16LE(0, 32); // comment len
    centralHeader.writeUInt16LE(0, 34); // disk start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralDirBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirBuf, eocd]);
}
