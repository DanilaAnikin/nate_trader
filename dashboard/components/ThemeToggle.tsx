"use client";

/**
 * Light/dark theme toggle. Flips the `.dark` class on <html> and persists the
 * choice; the no-FOUC script in the root layout applies it on next load.
 *
 * Holds no React state — the icon/label switch is driven purely by the `dark:`
 * CSS variant, so there's no setState-in-effect and no hydration mismatch.
 */
function toggleTheme() {
  const el = document.documentElement;
  const next = !el.classList.contains("dark");
  el.classList.toggle("dark", next);
  try {
    localStorage.setItem("theme", next ? "dark" : "light");
  } catch {
    // localStorage unavailable (private mode) — theme just won't persist.
  }
}

export default function ThemeToggle() {
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label="Toggle dark mode"
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-secondary hover:text-foreground hover:bg-surface transition-all duration-200"
    >
      {/* Moon — shown in light mode (click to go dark) */}
      <span className="flex items-center gap-3 dark:hidden">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
        Dark mode
      </span>
      {/* Sun — shown in dark mode (click to go light) */}
      <span className="hidden items-center gap-3 dark:flex">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
        Light mode
      </span>
    </button>
  );
}
