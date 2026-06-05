import Skeleton from "@/components/Skeleton";

/**
 * Route-level loading UI for every authenticated screen. Next renders this
 * instantly while the server component fetches its data (GitHub state,
 * Supabase), so screens reserve their layout instead of flashing empty.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-3 w-56" />
        </div>
        <Skeleton className="h-8 w-28" />
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>

      {/* Chart + side panel */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <Skeleton className="h-80 w-full lg:col-span-3" />
        <Skeleton className="h-80 w-full lg:col-span-2" />
      </div>

      {/* Lower cards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-40 w-full" />
        ))}
      </div>

      <Skeleton className="h-[420px] w-full" />
    </div>
  );
}
