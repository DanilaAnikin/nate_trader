import { redirect } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import RefreshButton from "@/components/RefreshButton";
import { getSupabaseServer } from "@/lib/supabase/server";

/**
 * Authenticated shell for every dashboard screen.
 *
 * Auth is enforced only once Supabase is configured via env vars. Until then
 * the dashboard keeps working in its legacy (GitHub-state) mode so deploying
 * this code does not lock anyone out before the environment is wired up.
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const configured =
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (configured) {
    const supa = await getSupabaseServer();
    const {
      data: { user },
    } = await supa.auth.getUser();
    if (!user) redirect("/login");
  }

  return (
    <div className="min-h-screen flex">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <div className="max-w-[1600px] mx-auto p-8">
          <div className="flex justify-end mb-4">
            <RefreshButton />
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
