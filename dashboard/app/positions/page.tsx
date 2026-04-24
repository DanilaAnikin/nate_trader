import { fetchStateFile } from "@/lib/github";
import type { PositionsData } from "@/lib/types";
import PositionsTable from "@/components/PositionsTable";

export default async function PositionsPage() {
  const data = await fetchStateFile<PositionsData>("positions.json");
  const positions = data?.positions ?? [];
  const updatedAt = data?.updated_at ?? "N/A";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Positions</h2>
        <p className="text-xs text-muted mt-0.5">Last updated: {updatedAt}</p>
      </div>
      <PositionsTable positions={positions} />
    </div>
  );
}
