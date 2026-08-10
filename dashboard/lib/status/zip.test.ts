import { describe, expect, it } from "vitest";
import {
  crc32,
  listZipEntries,
  MAX_ENTRY_BYTES,
  readJsonEntries,
  readZipEntry,
  ZipError,
} from "./zip";
import { buildZip } from "@/test/zip-builder";

const RUNTIME_CONTRACT = {
  required: ["performance.json", "positions.json", "production/last_run.json"],
  exact: true,
} as const;

const DIAGNOSTICS_CONTRACT = {
  required: ["production-preflight.json"],
  optional: ["production-execution.json"],
  ignored: ["production-dry-run.log"],
} as const;

describe("zip reader — happy path", () => {
  it("lists and inflates deflate entries", () => {
    const zip = buildZip([
      { name: "performance.json", content: '{"a":1}' },
      { name: "production/last_run.json", content: '{"b":2}' },
    ]);
    const entries = listZipEntries(zip);
    expect(entries.map((entry) => entry.name)).toEqual([
      "performance.json",
      "production/last_run.json",
    ]);
    expect(readZipEntry(zip, entries[0]).toString()).toBe('{"a":1}');
  });

  it("reads stored (uncompressed) entries", () => {
    const zip = buildZip([{ name: "a.json", content: '{"x":true}', store: true }]);
    expect(readJsonEntries(zip, ["a.json"])).toEqual({ "a.json": { x: true } });
  });

  it("computes a CRC-32 that matches the reference implementation", () => {
    // Known vector: CRC-32("123456789") === 0xCBF43926.
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});

describe("runtime artifact contract", () => {
  it("accepts exactly the three expected entries", () => {
    const zip = buildZip([
      { name: "performance.json", content: '{"a":1}' },
      { name: "positions.json", content: '{"positions":[]}' },
      { name: "production/last_run.json", content: '{"b":2}' },
    ]);
    expect(Object.keys(readJsonEntries(zip, RUNTIME_CONTRACT))).toEqual([
      "performance.json",
      "positions.json",
      "production/last_run.json",
    ]);
  });

  it("rejects an extra injected entry", () => {
    const zip = buildZip([
      { name: "performance.json", content: "{}" },
      { name: "positions.json", content: '{"positions":[]}' },
      { name: "production/last_run.json", content: "{}" },
      { name: "evil.json", content: '{"pwn":true}' },
    ]);
    expect(() => readJsonEntries(zip, RUNTIME_CONTRACT)).toThrow(
      /unexpected entry: evil\.json/,
    );
  });

  it("fails closed when an expected entry is missing", () => {
    const zip = buildZip([{ name: "performance.json", content: "{}" }]);
    expect(() => readJsonEntries(zip, RUNTIME_CONTRACT)).toThrow(
      /missing positions\.json/,
    );
  });
});

describe("diagnostics artifact contract", () => {
  it("accepts the required entry plus allowlisted optional and ignored ones", () => {
    const zip = buildZip([
      { name: "production-preflight.json", content: '{"status":"PASS"}' },
      { name: "production-execution.json", content: '{"status":"PASS"}' },
      { name: "production-dry-run.log", content: "not json at all" },
    ]);
    const entries = readJsonEntries(zip, DIAGNOSTICS_CONTRACT);
    expect(entries["production-preflight.json"]).toEqual({ status: "PASS" });
    // The log is allowlisted but never parsed, so its non-JSON body is fine.
    expect(entries["production-dry-run.log"]).toBeUndefined();
  });

  it("rejects an entry outside the allowlist", () => {
    const zip = buildZip([
      { name: "production-preflight.json", content: "{}" },
      { name: "credentials.env", content: "APCA=1" },
    ]);
    expect(() => readJsonEntries(zip, DIAGNOSTICS_CONTRACT)).toThrow(
      /unexpected entry: credentials\.env/,
    );
  });
});

/**
 * `actions/upload-artifact` streams every entry: general-purpose bit 3 is set,
 * the local header's CRC and sizes are zero, and the real values live in a
 * trailing data descriptor plus the central directory. This is the exact shape
 * of the production runtime artifact, verified against a real download.
 */
describe("GitHub Actions streaming layout", () => {
  const RUNTIME_FILES = [
    { name: "performance.json", content: '{"equity":881532.2}' },
    { name: "positions.json", content: '{"positions":[]}' },
    { name: "production/last_run.json", content: '{"status":"PASS"}' },
  ];

  it("produces the documented byte layout in the fixture", () => {
    const zip = buildZip(
      RUNTIME_FILES.map((file) => ({ ...file, dataDescriptor: true })),
    );
    // Local header: flag bit 3 set, CRC and both sizes zeroed.
    expect(zip.readUInt16LE(6) & 0x0008).toBe(0x0008);
    expect(zip.readUInt32LE(14)).toBe(0);
    expect(zip.readUInt32LE(18)).toBe(0);
    expect(zip.readUInt32LE(22)).toBe(0);

    // Central directory: flag bit 3 set, real CRC and sizes present.
    const entries = listZipEntries(zip);
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry.flags & 0x0008).toBe(0x0008);
      expect(entry.crc32).not.toBe(0);
      expect(entry.uncompressedSize).toBeGreaterThan(0);
    }
  });

  it("reads the runtime artifact shape", () => {
    const zip = buildZip(
      RUNTIME_FILES.map((file) => ({ ...file, dataDescriptor: true })),
    );
    const entries = readJsonEntries(zip, RUNTIME_CONTRACT);
    expect(entries["performance.json"]).toEqual({ equity: 881532.2 });
    expect(entries["positions.json"]).toEqual({ positions: [] });
    expect(entries["production/last_run.json"]).toEqual({ status: "PASS" });
  });

  it("reads the diagnostics artifact shape", () => {
    const zip = buildZip([
      {
        name: "production-preflight.json",
        content: '{"status":"PASS"}',
        dataDescriptor: true,
      },
      {
        name: "production-dry-run.log",
        content: "dry run output",
        dataDescriptor: true,
      },
    ]);
    const entries = readJsonEntries(zip, DIAGNOSTICS_CONTRACT);
    expect(entries["production-preflight.json"]).toEqual({ status: "PASS" });
  });

  it("reads a descriptor written without the optional signature", () => {
    const zip = buildZip([
      { name: "a.json", content: '{"a":1}', dataDescriptor: "unsigned" },
    ]);
    expect(readJsonEntries(zip, ["a.json"])).toEqual({ "a.json": { a: 1 } });
  });

  it("still verifies the descriptor against the central directory", () => {
    const zip = buildZip([
      {
        name: "a.json",
        content: '{"a":1}',
        dataDescriptor: true,
        descriptorCrcOverride: 0xdeadbeef,
      },
    ]);
    const entries = listZipEntries(zip);
    expect(() => readZipEntry(zip, entries[0])).toThrow(
      /data descriptor disagrees/,
    );
  });

  it("rejects a streamed entry whose descriptor is missing entirely", () => {
    const zip = buildZip([
      { name: "a.json", content: '{"a":1}', dataDescriptor: true },
    ]);
    const entries = listZipEntries(zip);
    // Drop the descriptor bytes by pointing the entry past the archive end.
    expect(() =>
      readZipEntry(zip, { ...entries[0], compressedSize: zip.length }),
    ).toThrow(/truncated/);
  });

  it("keeps every other guarantee for a streamed entry", () => {
    // CRC is still enforced on the inflated bytes.
    const zip = buildZip([
      {
        name: "a.json",
        content: '{"a":1}',
        dataDescriptor: true,
        crcOverride: 0x12345678,
        descriptorCrcOverride: 0x12345678,
      },
    ]);
    const entries = listZipEntries(zip);
    expect(() => readZipEntry(zip, entries[0])).toThrow(/CRC-32/);
  });

  it("still rejects an encrypted streamed entry", () => {
    const zip = buildZip([
      { name: "a.json", content: "{}", dataDescriptor: true, flags: 0x0001 },
    ]);
    expect(() => listZipEntries(zip)).toThrow(/encrypted/);
  });

  it("still rejects a duplicate name in the streamed layout", () => {
    const zip = buildZip([
      { name: "a.json", content: "{}", dataDescriptor: true },
      { name: "a.json", content: "{}", dataDescriptor: true },
    ]);
    expect(() => listZipEntries(zip)).toThrow(/duplicate entry/);
  });

  it("still rejects a zip bomb in the streamed layout", () => {
    const zip = buildZip([
      {
        name: "a.json",
        content: "{}",
        dataDescriptor: true,
        uncompressedSizeOverride: MAX_ENTRY_BYTES + 1,
      },
    ]);
    expect(() => listZipEntries(zip)).toThrow(/exceeds the allowed size/);
  });
});

describe("zip reader — hardening", () => {
  it("rejects duplicate entry names", () => {
    const zip = buildZip([
      { name: "performance.json", content: '{"a":1}' },
      { name: "performance.json", content: '{"a":2}' },
    ]);
    expect(() => listZipEntries(zip)).toThrow(/duplicate entry/);
  });

  it("rejects a CRC that does not match the data", () => {
    const zip = buildZip([
      { name: "a.json", content: '{"a":1}', crcOverride: 0xdeadbeef },
    ]);
    const entries = listZipEntries(zip);
    expect(() => readZipEntry(zip, entries[0])).toThrow(/CRC-32/);
  });

  it("rejects an inflated length that disagrees with the header", () => {
    const zip = buildZip([
      { name: "a.json", content: '{"a":1}', uncompressedSizeOverride: 999 },
    ]);
    const entries = listZipEntries(zip);
    expect(() => readZipEntry(zip, entries[0])).toThrow(/unexpected length/);
  });

  it("rejects a local header that disagrees with the central directory", () => {
    const zip = buildZip([
      { name: "a.json", content: "{}", localNameOverride: "b.json" },
    ]);
    const entries = listZipEntries(zip);
    expect(() => readZipEntry(zip, entries[0])).toThrow(
      /disagrees with its local header name/,
    );
  });

  it("rejects encrypted entries", () => {
    const zip = buildZip([{ name: "a.json", content: "{}", flags: 0x0001 }]);
    expect(() => listZipEntries(zip)).toThrow(/encrypted/);
  });

  it("rejects an unsupported compression method", () => {
    const zip = buildZip([
      { name: "a.json", content: "{}", methodOverride: 99 },
    ]);
    expect(() => listZipEntries(zip)).toThrow(/unsupported compression 99/);
  });

  it("rejects a zip bomb by its declared expansion, before inflating", () => {
    const zip = buildZip([
      {
        name: "a.json",
        content: "{}",
        uncompressedSizeOverride: MAX_ENTRY_BYTES + 1,
      },
    ]);
    expect(() => listZipEntries(zip)).toThrow(/exceeds the allowed size/);
  });

  it("rejects an archive whose entries together expand past the total cap", () => {
    const bomb = Array.from({ length: 4 }, (_, index) => ({
      name: `chunk-${index}.json`,
      content: "{}",
      uncompressedSizeOverride: 3 * 1024 * 1024,
    }));
    expect(() => listZipEntries(buildZip(bomb))).toThrow(
      /expands beyond the allowed total size/,
    );
  });

  it("rejects path traversal and absolute names", () => {
    expect(() =>
      listZipEntries(buildZip([{ name: "../escape.json", content: "{}" }])),
    ).toThrow(/escapes the archive root/);
    expect(() =>
      listZipEntries(buildZip([{ name: "/etc/passwd", content: "{}" }])),
    ).toThrow(/absolute path/);
  });

  it("rejects stored entries whose sizes disagree", () => {
    const zip = buildZip([
      {
        name: "a.json",
        content: "{}",
        store: true,
        uncompressedSizeOverride: 5,
      },
    ]);
    expect(() => listZipEntries(zip)).toThrow(/inconsistent stored sizes/);
  });

  it("fails closed on a non-JSON required entry", () => {
    const zip = buildZip([{ name: "a.json", content: "{not json" }]);
    expect(() => readJsonEntries(zip, ["a.json"])).toThrow(/not valid JSON/);
  });

  it("fails closed on a truncated or empty archive", () => {
    expect(() => listZipEntries(Buffer.alloc(0))).toThrow(ZipError);
    const zip = buildZip([{ name: "a.json", content: "{}" }]);
    expect(() => listZipEntries(zip.subarray(0, zip.length - 10))).toThrow(
      ZipError,
    );
  });
});
