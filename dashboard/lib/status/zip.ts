import "server-only";
import { inflateRawSync } from "node:zlib";

/**
 * Minimal, defensive ZIP reader for GitHub Actions artifact downloads.
 *
 * Actions artifacts are the only zip input, and they are produced by
 * `actions/upload-artifact`. We deliberately implement the narrow subset we
 * need (stored + deflate, no encryption, no zip64) instead of adding a
 * dependency, and we hard-cap every size so a corrupt or hostile archive
 * cannot exhaust server memory.
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

export const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
export const MAX_ENTRIES = 64;

export class ZipError extends Error {}

export interface ZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly compressionMethod: number;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The EOCD record is at most 22 + 65535 bytes from the end.
  const min = Math.max(0, buffer.length - (22 + 0xffff));
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) return i;
  }
  throw new ZipError("zip end-of-central-directory record not found");
}

/** List central-directory entries without decompressing any of them. */
export function listZipEntries(buffer: Buffer): ZipEntry[] {
  if (buffer.length === 0) throw new ZipError("zip archive is empty");
  if (buffer.length > MAX_ARCHIVE_BYTES) {
    throw new ZipError("zip archive exceeds the allowed size");
  }
  const eocd = findEndOfCentralDirectory(buffer);
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
  let cursor = directoryOffset;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > buffer.length) {
      throw new ZipError("zip central directory is truncated");
    }
    if (buffer.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER) {
      throw new ZipError("zip central directory header is invalid");
    }
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      compressionMethod,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Decompress one entry, enforcing the per-entry size cap. */
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
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) {
    throw new ZipError(`zip entry ${entry.name} is truncated`);
  }
  const raw = buffer.subarray(start, end);

  if (entry.compressionMethod === 0) return Buffer.from(raw);
  if (entry.compressionMethod === 8) {
    try {
      return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch (cause) {
      throw new ZipError(`zip entry ${entry.name} could not be inflated`, {
        cause,
      });
    }
  }
  throw new ZipError(
    `zip entry ${entry.name} uses unsupported compression ${entry.compressionMethod}`,
  );
}

/**
 * Read the named entries as parsed JSON. Entry names are matched exactly
 * against the expected artifact layout so a renamed or injected file cannot be
 * silently accepted.
 */
export function readJsonEntries(
  buffer: Buffer,
  expectedNames: readonly string[],
): Record<string, unknown> {
  const entries = listZipEntries(buffer);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const result: Record<string, unknown> = {};
  for (const name of expectedNames) {
    const entry = byName.get(name);
    if (!entry) throw new ZipError(`zip archive is missing ${name}`);
    const text = readZipEntry(buffer, entry).toString("utf8");
    try {
      result[name] = JSON.parse(text) as unknown;
    } catch {
      throw new ZipError(`zip entry ${name} is not valid JSON`);
    }
  }
  return result;
}
