import { fetchStateFile } from "@/lib/github";
import type { PerformanceData, ResearchData } from "@/lib/types";
import DashboardClient from "@/components/DashboardClient";
import { SUPABASE_CONFIGURED } from "@/lib/supabase/config";
import { getSelectedAccount } from "@/lib/account-context";

export default async function DashboardPage() {
  const [performance, research] = await Promise.all([
    fetchStateFile<PerformanceData>("performance.json"),
    fetchStateFile<ResearchData>("research.json"),
  ]);

  let selectedAccountId: string | null = null;
  if (SUPABASE_CONFIGURED) {
    const { selected } = await getSelectedAccount();
    selectedAccountId = selected?.id ?? null;
  }

  return (
    <DashboardClient
      performance={performance}
      research={research}
      selectedAccountId={selectedAccountId}
    />
  );
}
