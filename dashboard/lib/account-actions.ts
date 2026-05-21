"use server";

import { cookies } from "next/headers";
import { SELECTED_ACCOUNT_COOKIE } from "./account-context";

/**
 * Persist which account the dashboard should display. The cookie is httpOnly;
 * `getSelectedAccount()` re-validates ownership on read, so an arbitrary value
 * here can never surface another user's account.
 */
export async function selectAccount(accountId: string) {
  const cookieStore = await cookies();
  cookieStore.set(SELECTED_ACCOUNT_COOKIE, accountId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}
