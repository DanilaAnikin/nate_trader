/**
 * Route-level loading UI. Reserves the panel rhythm of the real screens so
 * the layout does not jump when the account-scoped read model arrives.
 */
export default function Loading() {
  return (
    <div className="space-y-5" aria-busy="true">
      <span className="sr-only">Loading…</span>
      {[0, 1, 2].map((index) => (
        <div key={index} className="panel p-4 space-y-3">
          <span className="skeleton block h-4 w-48" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[0, 1, 2, 3].map((cell) => (
              <span key={cell} className="skeleton block h-12 w-full" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
