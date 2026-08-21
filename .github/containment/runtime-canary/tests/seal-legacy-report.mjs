/* ==========================================================================
 * seal-legacy-report.mjs — bring an artefact directory produced BEFORE the
 *                          ADV-3 seal up to the shape the runner writes now
 *
 * WHY THIS EXISTS
 * ---------------
 * `sensor/verify-sensor.sh report` now writes its report body to
 * `sensor-state-<schema>/report-body.txt` and MACs it into `report.hmac` with
 * the per-run key it drew at `arm`, and `driver/verdict.mjs` derives the
 * sensor verdict from THAT rather than from the plain text file — because an
 * auditor defeated the previous closure by deleting every runner artefact and
 * retyping eight lines of text.
 *
 * Artefact directories produced by earlier runs have the key and the report
 * but not the seal, so the certifying verdict refuses them. Re-running the
 * whole matrix to regenerate a corpus is hours of docker; this writes what the
 * runner would have written, from the report that run actually produced, using
 * THAT RUN'S OWN key.
 *
 * WHAT IT CANNOT DO, deliberately: it refuses when `runkey` is absent. It
 * cannot manufacture a seal for a directory whose runner state was deleted,
 * which is precisely the attack ADV-3 is about. It also refuses to overwrite a
 * seal that already exists, so it can never be used to launder a modified
 * report in a directory that was sealed properly.
 *
 * THIS IS NOT A SECURITY BOUNDARY AND DOES NOT PRETEND TO BE. An operator
 * holding the artefact directory holds the run key too, and can re-seal
 * anything with fifteen lines of node — measured. That residual is stated in
 * the `sensor-report-authenticity` scope statement and in the README; this
 * tool does not make it worse, it only spares a corpus rebuild.
 *
 * Usage: node seal-legacy-report.mjs DIR [schema…]     (default 0008,0023)
 * Exit:  0 sealed or already sealed, 2 cannot seal (and says why)
 * ========================================================================== */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const [dir, ...rest] = process.argv.slice(2);
if (!dir) { console.error("seal-legacy-report: a directory is required"); process.exit(2); }
const schemas = rest.length ? rest : ["0008", "0023"];

let sealed = 0, already = 0;
for (const s of schemas) {
  const state = path.join(dir, `sensor-state-${s}`);
  const report = path.join(dir, `sensor-report-${s}.txt`);
  if (!fs.existsSync(state) || !fs.existsSync(report)) continue;   // nothing of this generation here
  const bodyFile = path.join(state, "report-body.txt");
  const macFile = path.join(state, "report.hmac");
  if (fs.existsSync(bodyFile) && fs.existsSync(macFile)) { already++; continue; }
  const keyFile = path.join(state, "runkey");
  if (!fs.existsSync(keyFile)) {
    console.error(`seal-legacy-report: ${keyFile} does not exist. This directory's runner state was ` +
                  `deleted, and a seal cannot be produced without the key the runner drew — which is ` +
                  `the whole point of the seal. Re-run the matrix.`);
    process.exit(2);
  }
  const key = fs.readFileSync(keyFile, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(key)) {
    console.error(`seal-legacy-report: ${keyFile} is not 256 bits of hex`);
    process.exit(2);
  }
  const text = fs.readFileSync(report);
  if (!/^SENSOR_RESULT=[A-Z_]+\|/m.test(text.toString("utf8"))) {
    console.error(`seal-legacy-report: ${report} carries no SENSOR_RESULT line; there is no report to seal`);
    process.exit(2);
  }
  fs.writeFileSync(bodyFile, text);
  fs.writeFileSync(macFile,
    crypto.createHmac("sha256", Buffer.from(key, "hex")).update(text).digest("hex") + "\n");
  fs.chmodSync(bodyFile, 0o600);
  fs.chmodSync(macFile, 0o600);
  sealed++;
}
console.log(`seal-legacy-report: ${sealed} generation(s) sealed, ${already} already sealed, in ${dir}`);
