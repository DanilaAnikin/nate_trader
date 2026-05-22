import { SUPABASE_CONFIGURED } from "@/lib/supabase/config";
import { getSelectedAccount } from "@/lib/account-context";
import TradesClient from "@/components/TradesClient";

export const dynamic = "force-dynamic";

export default async function TradesPage() {
  if (!SUPABASE_CONFIGURED) {
    return (
      <div>
        <h2 className="text-2xl font-semibold text-foreground mb-1">Trades</h2>
        <p className="text-sm text-muted">
          The trade log requires Supabase to be configured.
        </p>
      </div>
    );
  }

  const { selected } = await getSelectedAccount();
  return <TradesClient accountId={selected?.id ?? null} />;
}
