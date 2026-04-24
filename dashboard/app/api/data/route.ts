import { NextRequest } from "next/server";
import { fetchStateFile } from "@/lib/github";

const VALID_FILES = ["performance", "positions", "research", "screener"];

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const file = searchParams.get("file");

  if (!file || !VALID_FILES.includes(file)) {
    return Response.json(
      { error: `Invalid file. Must be one of: ${VALID_FILES.join(", ")}` },
      { status: 400 }
    );
  }

  const data = await fetchStateFile(`${file}.json`);
  if (!data) {
    return Response.json({ error: `Failed to fetch ${file}.json` }, { status: 502 });
  }

  return Response.json(data);
}
