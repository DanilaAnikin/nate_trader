import type { AccountMode } from "./types";

/** One mode binds approval, workflow steps and private artifacts together. */
export function productionSource(mode: AccountMode) {
  return {
    mode,
    workflow: `${mode}-production.yml`,
    environment: `${mode}-production`,
    runtimePrefix: `${mode}-runtime-state-`,
    diagnosticsName: `${mode}-diagnostics`,
    preflightStep: `Verify ${mode} broker and deployment health`,
    executeStep: mode === "live"
      ? "Execute one guarded real-money cycle"
      : "Execute one guarded paper cycle",
    runtimeUploadStep: mode === "live"
      ? "Preserve private live runtime state"
      : "Preserve private runtime state",
    runtimeSource: `github-actions artifact ${mode}-runtime-state (server-only)`,
    diagnosticsSource: `github-actions artifact ${mode}-diagnostics (server-only)`,
  } as const;
}
