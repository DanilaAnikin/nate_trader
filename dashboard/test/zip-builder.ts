import { deflateRawSync } from "node:zlib";

/**
 * Build a minimal, valid zip archive so the private-artifact reader can be
 * exercised without a network or a GitHub token.
 *
 * The per-file overrides exist purely so the hardening tests can produce
 * archives that are *deliberately* wrong (bad CRC, duplicate names, mismatched
 * headers, encrypted flag, lying sizes) without hand-crafting bytes.
 */
export interface ZipFileSpec {
  name: string;
  content: string;
  store?: boolean;
  /** Write this CRC instead of the real one, in both headers. */
  crcOverride?: number;
  /** Write this uncompressed size instead of the real one, in both headers. */
  uncompressedSizeOverride?: number;
  /** General-purpose bit flags to write in both headers. */
  flags?: number;
  /** Compression method to advertise in both headers. */
  methodOverride?: number;
  /** Write a different name in the local header than in the central directory. */
  localNameOverride?: string;
  /**
   * Emit the entry the way `actions/upload-artifact` does: general-purpose
   * bit 3 set, a zeroed local header, and the real CRC/sizes in a trailing
   * data descriptor. `"unsigned"` omits the optional PK\x07\x08 signature.
   */
  dataDescriptor?: boolean | "unsigned";
  /** Corrupt the descriptor's CRC to prove it is actually verified. */
  descriptorCrcOverride?: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildZip(files: ZipFileSpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, "utf8");
    const localNameBytes = Buffer.from(file.localNameOverride ?? file.name, "utf8");
    const raw = Buffer.from(file.content, "utf8");
    const data = file.store ? raw : deflateRawSync(raw);
    const method = file.methodOverride ?? (file.store ? 0 : 8);
    const flags = file.flags ?? 0;
    const crc = file.crcOverride ?? crc32(raw);
    const uncompressed = file.uncompressedSizeOverride ?? raw.length;

    const streaming = file.dataDescriptor !== undefined && file.dataDescriptor !== false;
    const effectiveFlags = streaming ? flags | 0x0008 : flags;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(effectiveFlags, 6);
    local.writeUInt16LE(method, 8);
    // A streaming writer leaves these three fields zero.
    local.writeUInt32LE(streaming ? 0 : crc, 14);
    local.writeUInt32LE(streaming ? 0 : data.length, 18);
    local.writeUInt32LE(streaming ? 0 : uncompressed, 22);
    local.writeUInt16LE(localNameBytes.length, 26);
    locals.push(local, localNameBytes, data);

    let descriptor = Buffer.alloc(0);
    if (streaming) {
      const signed = file.dataDescriptor !== "unsigned";
      descriptor = Buffer.alloc(signed ? 16 : 12);
      let at = 0;
      if (signed) {
        descriptor.writeUInt32LE(0x08074b50, 0);
        at = 4;
      }
      descriptor.writeUInt32LE(file.descriptorCrcOverride ?? crc, at);
      descriptor.writeUInt32LE(data.length, at + 4);
      descriptor.writeUInt32LE(uncompressed, at + 8);
      locals.push(descriptor);
    }

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(effectiveFlags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + localNameBytes.length + data.length + descriptor.length;
  }

  const localBuffer = Buffer.concat(locals);
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(localBuffer.length, 16);

  return Buffer.concat([localBuffer, centralBuffer, eocd]);
}
