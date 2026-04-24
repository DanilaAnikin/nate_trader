const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "DanilaAnikin/nate_trader";

export async function fetchStateFile<T>(filename: string): Promise<T | null> {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/state/${filename}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "nate-trader-dashboard",
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

    const data = await res.json();
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return JSON.parse(content) as T;
  } catch (err) {
    console.error(`Failed to fetch ${filename}:`, err);
    return null;
  }
}
