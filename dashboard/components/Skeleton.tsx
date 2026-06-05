/**
 * Shimmer placeholder block. Use to reserve layout space while server data
 * loads so screens don't pop in from empty.
 */
export default function Skeleton({
  className = "",
}: {
  className?: string;
}) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}
