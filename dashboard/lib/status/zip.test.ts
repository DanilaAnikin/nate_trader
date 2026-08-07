import { describe, expect, it } from "vitest";
import { listZipEntries, readJsonEntries, readZipEntry, ZipError } from "./zip";
import { buildZip } from "@/test/zip-builder";

describe("zip reader", () => {
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

  it("reads exactly the expected entry names", () => {
    const zip = buildZip([
      { name: "performance.json", content: '{"a":1}' },
      { name: "positions.json", content: '{"positions":[]}' },
      { name: "production/last_run.json", content: '{"b":2}' },
    ]);
    const entries = readJsonEntries(zip, [
      "performance.json",
      "production/last_run.json",
    ]);
    expect(Object.keys(entries)).toEqual([
      "performance.json",
      "production/last_run.json",
    ]);
  });

  it("fails closed when an expected entry is missing", () => {
    const zip = buildZip([{ name: "performance.json", content: "{}" }]);
    expect(() => readJsonEntries(zip, ["production/last_run.json"])).toThrow(
      ZipError,
    );
  });

  it("fails closed on a non-JSON entry", () => {
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

  it("rejects an unsupported compression method", () => {
    const zip = buildZip([{ name: "a.json", content: "{}" }]);
    // Force method 99 (AES) in both headers.
    const patched = Buffer.from(zip);
    patched.writeUInt16LE(99, 8);
    const entries = listZipEntries(patched);
    patched.writeUInt16LE(99, entries[0].localHeaderOffset + 8);
    expect(() => readZipEntry(patched, { ...entries[0], compressionMethod: 99 })).toThrow(
      /unsupported compression/,
    );
  });
});
