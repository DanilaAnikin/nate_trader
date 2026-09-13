/** Run only against an explicitly labelled disposable Docker clone. */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

try {
  const container = process.argv[2];
  if (!container || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(container) || /^natetrader-/i.test(container)) {
    throw new Error("Disposable clone name required");
  }
  const inspect = (kind, name) => JSON.parse(execFileSync("docker", [kind, "inspect", name], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0];
  const info = inspect("container", container);
  const labels = info.Config?.Labels ?? {};
  if (labels["nate.acceptance.clone"] !== "true" && labels["nate.audit"] !== "pg17-upgrade") {
    throw new Error("Explicit disposable clone label required");
  }
  if (!info.State?.Running || Object.values(info.NetworkSettings?.Ports ?? {}).some((ports) => ports?.length)) {
    throw new Error("Clone must run without published ports");
  }
  const networks = Object.keys(info.NetworkSettings?.Networks ?? {});
  if (!networks.length || networks.some((name) => name !== "none" && !inspect("network", name).Internal)) {
    throw new Error("Clone must have network none or internal-only networks");
  }
  const sql = readFileSync(new URL("./clone-lifecycle.sql", import.meta.url), "utf8");
  const result = spawnSync("docker", ["exec", "-i", "-e", "PGOPTIONS=-c nate.acceptance.clone_only=true", container,
    "psql", "-U", "supabase_admin", "-d", "postgres", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
  { input: sql, encoding: "utf8", timeout: 90000, maxBuffer: 1024 * 1024 });
  // Never forward database output or errors from a restored customer clone.
  const passed = result.status === 0 && result.stdout.trim() === "NATE_CLONE_LIFECYCLE_PASS";
  process.stdout.write(JSON.stringify({ check: "clone_synthetic_lifecycle", result: passed ? "PASS" : "FAIL" }) + "\n");
  if (!passed) process.exitCode = 1;
} catch {
  process.stdout.write(JSON.stringify({ check: "clone_isolation_or_execution", result: "FAIL" }) + "\n");
  process.exitCode = 1;
}
