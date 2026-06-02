const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "DanilaAnikin/nate_trader";
// Branch the dashboard reads state from. Defaults to the repo's default branch.
const GITHUB_REF = process.env.GITHUB_STATE_REF || "main";

/**
 * Read a JSON file from `state/` in the repo via the GitHub Contents API.
 *
 * Uses the **raw** media type (`application/vnd.github.raw`) rather than the
 * default JSON+base64 envelope. This matters: the base64 envelope only carries
 * file content up to 1 MB — above that GitHub returns an empty `content` field
 * and the file silently fails to load. `state/research.json` is already >1 MB,
 * which broke the dashboard's regime, signal counts, SPY return and alpha. The
 * raw media type streams the bytes directly and supports files up to 100 MB.
 */
export async function fetchStateFile<T>(filename: string): Promise<T | null> {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/state/${filename}?ref=${GITHUB_REF}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw",
    "User-Agent": "nate-trader-dashboard",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (GITHUB_TOKEN) {
    headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;
  }

  try {
    const res = await fetch(url, {
      headers,
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      console.error(`GitHub API error for ${filename}: ${res.status}`);
      return null;
    }

    // Raw media type returns the file content directly as text.
    const text = await res.text();
    return JSON.parse(text) as T;
  } catch (err) {
    console.error(`Failed to fetch ${filename}:`, err);
    return null;
  }
}
