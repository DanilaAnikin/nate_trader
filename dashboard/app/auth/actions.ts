"use server";

import { redirect } from "next/navigation";
import { getSupabaseServer } from "@/lib/supabase/server";

/** Ends the current session and returns to the login screen. */
export async function signOut() {
  const supa = await getSupabaseServer();
  await supa.auth.signOut();
  redirect("/login");
}
