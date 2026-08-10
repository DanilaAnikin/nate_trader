import "server-only";
import { inflateRawSync } from "node:zlib";

/**
 * Hardened, dependency-free ZIP reader for GitHub Actions artifact downloads.
 *
 * Actions artifacts are the only input, and they are produced by
 * `actions/upload-artifact`, so we implement exactly the subset we need
 * (stored + deflate, streaming data descriptors, no encryption, no zip64) and
 * reject everything else.
 *
 * `actions/upload-artifact` streams, so every real entry sets general-purpose
 * bit 3 and leaves the local header's CRC and sizes zero; the true values live
 * in the trailing data descriptor and in the central directory. We trust the
 * central directory and verify the descriptor against it, rather than refusing
 * the format — refusing it made the production runtime artifact unreadable.
 *
 * The archive is attacker-influenced in the sense that anything with write
 * access to the workflow could change it, so every dimension is bounded and
 * verified: archive size, entry count, per-entry declared and *actual*
 * inflated size, duplicate names, path traversal, encryption flags,
 * local/central/descriptor agreement and CRC-32.
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_EOCD_LOCATOR = 0x07064b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;

export const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
export const MAX_ENTRIES = 64;

/** General-purpose bit flags we refuse outright. */
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_DATA_DESCRIPTOR = 0x0008;

export class ZipError extends Error {}

export interface ZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly compressionMethod: number;
  readonly flags: number;
  readonly crc32: number;
}

/* --------------------------------------------------------------- CRC-32 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* --------------------------------------------------------------- parsing */

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The EOCD record is at most 22 + 65535 bytes from the end.
  const min = Math.max(0, buffer.length - (22 + 0xffff));
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) return i;
  }
  throw new ZipError("zip end-of-central-directory record not found");
}

function assertSafeName(name: string): void {
  if (!name) throw new ZipError("zip entry has an empty name");
  if (name.length > 255) throw new ZipError("zip entry name is too long");
  if (name.endsWith("/")) throw new ZipError(`zip entry ${name} is a directory`);
  if (name.includes("\\")) throw new ZipError(`zip entry ${name} uses a backslash`);
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new ZipError(`zip entry ${name} is an absolute path`);
  }
  if (name.split("/").some((part) => part === "..")) {
    throw new ZipError(`zip entry ${name} escapes the archive root`);
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new ZipError("zip entry name contains a control character");
    }
  }
}

/** List central-directory entries without decompressing any of them. */
export function listZipEntries(buffer: Buffer): ZipEntry[] {
  if (buffer.length === 0) throw new ZipError("zip archive is empty");
  if (buffer.length > MAX_ARCHIVE_BYTES) {
    throw new ZipError("zip archive exceeds the allowed size");
  }
  const eocd = findEndOfCentralDirectory(buffer);

  // zip64 changes the size/offset semantics; we do not support it.
  if (eocd >= 20 && buffer.readUInt32LE(eocd - 20) === ZIP64_EOCD_LOCATOR) {
    throw new ZipError("zip64 archives are not supported");
  }

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount > MAX_ENTRIES) {
    throw new ZipError("zip archive has too many entries");
  }
  if (directoryOffset + directorySize > buffer.length) {
    throw new ZipError("zip central directory is out of bounds");
  }

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let totalUncompressed = 0;
  let cursor = directoryOffset;

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > buffer.length) {
      throw new ZipError("zip central directory is truncated");
    }
    if (buffer.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER) {
      throw new ZipError("zip central directory header is invalid");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const entryCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");

    assertSafeName(name);
    if (seen.has(name)) {
      throw new ZipError(`zip archive contains a duplicate entry: ${name}`);
    }
    seen.add(name);

    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
      throw new ZipError(`zip entry ${name} is encrypted`);
    }
    // A streaming data descriptor (bit 3) is normal: GitHub Actions writes
    // every artifact entry that way, with a zeroed local header. The
    // authoritative sizes and CRC are the central-directory values used here;
    // `readZipEntry` additionally verifies the trailing descriptor against
    // them, so the streamed values cannot disagree unnoticed.
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new ZipError(
        `zip entry ${name} uses unsupported compression ${compressionMethod}`,
      );
    }
    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw new ZipError(`zip entry ${name} exceeds the allowed size`);
    }
    if (compressionMethod === 0 && compressedSize !== uncompressedSize) {
      throw new ZipError(`zip entry ${name} has inconsistent stored sizes`);
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new ZipError("zip archive expands beyond the allowed total size");
    }

    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      compressionMethod,
      flags,
      crc32: entryCrc,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Verify the trailing data descriptor of a streamed entry.
 *
 * The descriptor is the only place a streaming writer records the real CRC and
 * sizes, so it must agree exactly with the central directory we are trusting.
 * Both encodings are accepted: with the optional `PK\\x07\\x08` signature (what
 * GitHub Actions emits) and the older signature-less form.
 */
function assertDataDescriptorMatches(
  buffer: Buffer,
  dataEnd: number,
  entry: ZipEntry,
): void {
  const signed =
    dataEnd + 4 <= buffer.length &&
    buffer.readUInt32LE(dataEnd) === DATA_DESCRIPTOR_SIGNATURE;
  const base = signed ? dataEnd + 4 : dataEnd;
  if (base + 12 > buffer.length) {
    throw new ZipError(
      `zip entry ${entry.name} is missing its trailing data descriptor`,
    );
  }
  const crc = buffer.readUInt32LE(base);
  const compressedSize = buffer.readUInt32LE(base + 4);
  const uncompressedSize = buffer.readUInt32LE(base + 8);
  if (
    crc !== entry.crc32 ||
    compressedSize !== entry.compressedSize ||
    uncompressedSize !== entry.uncompressedSize
  ) {
    throw new ZipError(
      `zip entry ${entry.name} data descriptor disagrees with the central directory`,
    );
  }
}

/**
 * Decompress one entry and verify it against its central-directory record.
 *
 * The local header must agree with the central directory (allowing the zeroed
 * header a streaming writer emits), a streamed entry's trailing descriptor must
 * match it too, the inflated output must be exactly the declared length, and
 * the CRC-32 must match — so a tampered or truncated member is rejected rather
 * than silently parsed.
 */
export function readZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new ZipError(`zip entry ${entry.name} exceeds the allowed size`);
  }
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length) {
    throw new ZipError(`zip entry ${entry.name} has an invalid offset`);
  }
  if (buffer.readUInt32LE(offset) !== LOCAL_FILE_HEADER) {
    throw new ZipError(`zip entry ${entry.name} has an invalid local header`);
  }

  const localFlags = buffer.readUInt16LE(offset + 6);
  const localMethod = buffer.readUInt16LE(offset + 8);
  const localCrc = buffer.readUInt32LE(offset + 14);
  const localCompressed = buffer.readUInt32LE(offset + 18);
  const localUncompressed = buffer.readUInt32LE(offset + 22);
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const localName = buffer
    .subarray(offset + 30, offset + 30 + nameLength)
    .toString("utf8");

  if (localName !== entry.name) {
    throw new ZipError(
      `zip entry ${entry.name} disagrees with its local header name`,
    );
  }
  if (localMethod !== entry.compressionMethod || localFlags !== entry.flags) {
    throw new ZipError(
      `zip entry ${entry.name} local header disagrees with the central directory`,
    );
  }

  const streaming = (entry.flags & FLAG_DATA_DESCRIPTOR) !== 0;
  if (streaming) {
    // A streaming writer leaves the local CRC and sizes zero. Some writers
    // fill them in anyway; either is fine, but a third, different value is
    // not.
    const zeroed =
      localCrc === 0 && localCompressed === 0 && localUncompressed === 0;
    const filled =
      localCrc === entry.crc32 &&
      localCompressed === entry.compressedSize &&
      localUncompressed === entry.uncompressedSize;
    if (!zeroed && !filled) {
      throw new ZipError(
        `zip entry ${entry.name} local header disagrees with the central directory`,
      );
    }
  } else if (
    localCrc !== entry.crc32 ||
    localCompressed !== entry.compressedSize ||
    localUncompressed !== entry.uncompressedSize
  ) {
    throw new ZipError(
      `zip entry ${entry.name} local header disagrees with the central directory`,
    );
  }

  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) {
    throw new ZipError(`zip entry ${entry.name} is truncated`);
  }
  const raw = buffer.subarray(start, end);

  if (streaming) {
    assertDataDescriptorMatches(buffer, end, entry);
  }

  let output: Buffer;
  if (entry.compressionMethod === 0) {
    output = Buffer.from(raw);
  } else {
    try {
      output = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch (cause) {
      throw new ZipError(`zip entry ${entry.name} could not be inflated`, {
        cause,
      });
    }
  }

  if (output.length !== entry.uncompressedSize) {
    throw new ZipError(
      `zip entry ${entry.name} inflated to an unexpected length`,
    );
  }
  if (crc32(output) !== entry.crc32) {
    throw new ZipError(`zip entry ${entry.name} failed its CRC-32 check`);
  }
  return output;
}

export interface EntryContract {
  /** Names that must all be present and parse as JSON. */
  readonly required: readonly string[];
  /** Names that may be present; parsed as JSON when they are. */
  readonly optional?: readonly string[];
  /** Names that may be present but are never read (for example a log file). */
  readonly ignored?: readonly string[];
  /**
   * When true the archive must contain exactly `required` and nothing else —
   * not even an allowlisted optional entry.
   */
  readonly exact?: boolean;
}

/**
 * Read the contracted entries as parsed JSON.
 *
 * The archive's entry set is checked against an explicit allowlist so an extra
 * injected member is a hard failure rather than something quietly ignored.
 */
export function readJsonEntries(
  buffer: Buffer,
  contract: EntryContract | readonly string[],
): Record<string, unknown> {
  const spec: EntryContract = Array.isArray(contract)
    ? { required: contract, exact: true }
    : (contract as EntryContract);

  const entries = listZipEntries(buffer);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));

  const allowed = new Set<string>([
    ...spec.required,
    ...(spec.exact ? [] : [...(spec.optional ?? []), ...(spec.ignored ?? [])]),
  ]);
  for (const entry of entries) {
    if (!allowed.has(entry.name)) {
      throw new ZipError(`zip archive contains an unexpected entry: ${entry.name}`);
    }
  }

  const result: Record<string, unknown> = {};
  for (const name of spec.required) {
    const entry = byName.get(name);
    if (!entry) throw new ZipError(`zip archive is missing ${name}`);
    result[name] = parseJsonEntry(buffer, entry);
  }
  for (const name of spec.exact ? [] : (spec.optional ?? [])) {
    const entry = byName.get(name);
    if (entry) result[name] = parseJsonEntry(buffer, entry);
  }
  return result;
}

function parseJsonEntry(buffer: Buffer, entry: ZipEntry): unknown {
  const text = readZipEntry(buffer, entry).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ZipError(`zip entry ${entry.name} is not valid JSON`);
  }
}
