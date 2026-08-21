/* ============================================================================
 * k14-jsonl.cjs — the ONE JSONL reader k14's planting helpers use
 *
 * WHY THIS FILE EXISTS (round-7 audit, R7-1)
 * ------------------------------------------
 * Every planting helper in k14 read an observer log with
 *
 *     fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
 *
 * which THROWS on a line that does not parse. So if `--full-out` itself
 * carried an unparseable line — which is a NORMAL-OPERATION outcome, because
 * instrument.cjs appends each event with its own fs.appendFileSync and run.sh
 * SIGKILLs the app container at the end of every cell — the MEASURED case
 * correctly went red (it compares `claimEvidence.logEvents` against
 * `grep -c .`), and then the very next case died inside its planter, the
 * `harness` helper exited 2, and the suite stopped. Twenty-one cases never
 * reported. An unfinished suite is not a passing one, but it is not a
 * DIAGNOSING one either: the operator saw "k14 harness: D1 could not plant the
 * events" and not "your artefact directory has a corrupt line".
 *
 * A test harness's reader has the opposite job from the verifier's reader.
 * `driver/observers.mjs` must REFUSE an unparseable line, because it is
 * deciding whether an artefact directory certifies. A planter only needs the
 * highest `seq` and a timestamp; it must therefore carry on, SAY SO LOUDLY on
 * stderr, and leave the reporting of the corruption to the cases whose job
 * that is (GREEN and MEASURED, both of which now fail on it).
 *
 * It must also not QUIETLY REPAIR the directory. Several helpers rebuild a
 * whole JSONL file from the rows they parsed out of it; if a bad line were
 * simply dropped from `rows`, the rebuild would delete the corruption and the
 * copy under test would silently become clean. So `read()` returns `all` — the
 * file in order, parsed rows and unparseable raw text alike — and `dump()`
 * writes each entry back byte-identically unless it was explicitly marked
 * dirty.
 *
 * Used from a `node -e` helper as:
 *
 *     const J = require(process.env.K14_JSONL);
 *     const { rows, all } = J.read(file);
 *     …mutate rows / splice all…
 *     J.dump(file, all);
 * ========================================================================== */

"use strict";

const fs = require("node:fs");

/**
 * Read a JSONL file without ever throwing on its contents.
 *
 * @returns {{
 *   rows: object[],        // the parsed lines, in order; unparseable ones absent
 *   lineNos: number[],     // parallel to rows: the physical 1-based line number
 *   bad: Array<{lineNo:number, raw:string, error:string}>,
 *   all: Array<{obj:object|null, raw:string, lineNo:number, dirty:boolean}>,
 *   rawLines: number,      // non-empty lines, i.e. what `grep -c .` prints
 * }}
 */
function read(p) {
  const rows = [];
  const lineNos = [];
  const bad = [];
  const all = [];
  const physical = fs.readFileSync(p, "utf8").split("\n");
  for (let i = 0; i < physical.length; i++) {
    const raw = physical[i];
    if (raw === "") continue;              // the trailing element, and blank lines
    let obj = null;
    try { obj = JSON.parse(raw); }
    catch (e) {
      const error = String((e && e.message) || e);
      bad.push({ lineNo: i + 1, raw, error });
      all.push({ obj: null, raw, lineNo: i + 1, dirty: false });
      // NOT silent. The verifier refuses such a line; this reader is allowed
      // to skip it only because it is a planter, and only if it says so.
      process.stderr.write(
        `k14-jsonl: ${p}:${i + 1} does not parse (${error}); the planter is carrying on ` +
        `WITHOUT it. This is a corrupt artefact directory, not a planting failure — ` +
        `k14's GREEN and MEASURED cases are the ones that report it.\n`);
      continue;
    }
    rows.push(obj);
    lineNos.push(i + 1);
    all.push({ obj, raw, lineNo: i + 1, dirty: false });
  }
  return { rows, lineNos, bad, all, rawLines: rows.length + bad.length };
}

/** Mark one `all` entry as rewritten, so `dump` re-serialises it. */
function mark(item) { item.dirty = true; return item; }

/** A new entry for `all.splice(…)`: always written from its object. */
function inserted(obj) { return { obj, raw: null, lineNo: null, dirty: true }; }

/**
 * Write the file back. An entry that was not marked dirty is written
 * BYTE-IDENTICALLY from its original text — both because several cases depend
 * on that (`instrumentEvidence` matches boot events with a raw substring, so a
 * re-serialised log would fail for a reason that is not the case's) and
 * because an unparseable line must survive the round trip rather than being
 * quietly repaired by the test harness.
 */
function dump(p, all) {
  const out = all.map((it) => {
    if (!it.dirty) {
      if (it.raw === null) throw new Error("k14-jsonl: an inserted entry must be marked dirty");
      return it.raw;
    }
    return JSON.stringify(it.obj);
  });
  fs.writeFileSync(p, out.join("\n") + "\n");
}

module.exports = { read, mark, inserted, dump };
