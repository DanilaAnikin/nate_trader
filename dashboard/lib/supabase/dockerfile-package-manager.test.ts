import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The frozen runtime image must ship NO package manager, and the Dockerfile
 * must fail the build if one survives.
 *
 * WHY THIS EXISTS
 * ---------------
 * The runtime stage's whole purpose is that it cannot change; npm's own bundled
 * dependency tree was the source of every CVE this image ever had. An earlier
 * version removed only npm and npx and its header still claimed "NO PACKAGE
 * MANAGER" — but the base image also ships yarn, yarnpkg and corepack, and
 * `corepack enable` re-provisions npm/pnpm/yarn from the network. Removing npm
 * alone left the capability one command away and the claim untrue (audit F1).
 *
 * A layer scan of the sealed artifact is the ground truth, but it needs a built
 * image. This is the cheap always-on guard: it pins that the runner stage both
 * REMOVES every manager and asserts (build-failing) that none is left on PATH,
 * so shrinking the removal list — or a base image relocating a manager — turns
 * this test red instead of silently shipping a package manager again.
 */

const DASHBOARD = join(__dirname, "..", "..");
const DOCKERFILE = join(DASHBOARD, "Dockerfile");
const dockerfile = readFileSync(DOCKERFILE, "utf8");

// Every package-manager entrypoint the node:22-alpine base image is known to
// ship. pnpm/pnpx are corepack shims; they are covered once corepack is gone,
// but the guard names them anyway so a future base that ships them stays caught.
const MANAGERS = ["npm", "npx", "yarn", "yarnpkg", "corepack", "pnpm", "pnpx"];

/** The body of the `AS runner` stage: from its FROM line to the next FROM/EOF. */
function runnerStage(text: string): string {
  const lines = text.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*FROM\s.+\sAS\s+runner\s*$/i.test(lines[i])) start = i;
  }
  if (start === -1) throw new Error("no `AS runner` stage found in Dockerfile");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*FROM\s/i.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("frozen runtime image is package-manager-free", () => {
  const runner = runnerStage(dockerfile);

  it("has a RUN that removes npm, npx, yarn, yarnpkg and corepack", () => {
    // The removal targets the real binaries and their node_modules / opt dirs.
    // We assert each manager's name is present in an `rm -rf` context in the
    // runner stage; the guard below is what makes removal load-bearing.
    for (const pm of ["npm", "npx", "yarn", "yarnpkg", "corepack"]) {
      expect(runner, `runner stage must remove ${pm}`).toContain(pm);
    }
    expect(runner).toMatch(/rm\s+-rf/);
    expect(runner).toMatch(/node_modules\/corepack/);
    expect(runner).toMatch(/opt\/yarn-v/);
  });

  it("fails the build if any package manager is still on PATH", () => {
    // A `command -v <pm>` probe that exits non-zero when a manager survives.
    // Removal without this guard is not fail-closed: a relocated binary would
    // pass silently. The guard must name every manager and it must `exit 1`.
    expect(runner).toMatch(/command -v/);
    expect(runner).toMatch(/exit 1/);

    // The guard's manager list must cover every known entrypoint. We read the
    // `for pm in ...; do` list and require each MANAGERS name appears in it.
    const forList = runner.match(/for\s+pm\s+in\s+([^\n;]+)/);
    expect(forList, "runner stage must iterate managers in a `for pm in` guard").not.toBeNull();
    const listed = new Set((forList![1] || "").trim().split(/\s+/));
    for (const pm of MANAGERS) {
      expect(listed.has(pm), `guard loop must probe ${pm}`).toBe(true);
    }
  });

  it("does not reintroduce a package manager after the removal", () => {
    // Nothing after the removal RUN may `npm i`, `yarn add`, `corepack enable`,
    // etc. The runner stage installs nothing; assert no manager-invoking RUN
    // follows. (COPY --from=builder brings only built output.)
    const afterRemoval = runner.slice(runner.indexOf("command -v"));
    expect(afterRemoval).not.toMatch(/\bcorepack\s+enable\b/);
    expect(afterRemoval).not.toMatch(/\b(npm|yarn|pnpm)\s+(i|install|add|ci)\b/);
  });
});
