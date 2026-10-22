import Link from "next/link";

/** Choices for rows per page. */
export const PAGE_SIZES = [10, 25, 50, 100] as const;

/**
 * Below a long list: which rows are showing, page numbers, and how many rows a page has. `href`
 * gives the address for another page or page size.
 */
export function Pager({ page, per, count, href }: { page: number; per: number; count: number; href: (change: { page?: number; per?: number }) => string }) {
  const pages = Math.max(1, Math.ceil(count / per));
  const first = count ? (page - 1) * per + 1 : 0;
  const last = Math.min(count, page * per);
  // Page numbers: the first, the last, and two either side of this one.
  const shown = [...new Set([1, page - 2, page - 1, page, page + 1, page + 2, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  return (
    <nav className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-sm" aria-label="Pages">
      <span className="text-muted">
        Showing {first}–{last} of {count.toLocaleString("en-US")}
      </span>
      {pages > 1 && (
        <span className="flex flex-wrap items-center gap-1">
          {page > 1 && (
            <Link href={href({ page: page - 1 })} className="px-1.5">
              ← Previous
            </Link>
          )}
          {shown.map((n, i) => (
            <span key={n} className="flex items-center gap-1">
              {i > 0 && n - shown[i - 1] > 1 && <span className="text-muted">…</span>}
              {n === page ? (
                <span aria-current="page" className="rounded-sm bg-surface-2 px-2 py-0.5 font-bold">
                  {n}
                </span>
              ) : (
                <Link href={href({ page: n })} className="px-2 py-0.5">
                  {n}
                </Link>
              )}
            </span>
          ))}
          {page < pages && (
            <Link href={href({ page: page + 1 })} className="px-1.5">
              Next →
            </Link>
          )}
        </span>
      )}
      <span className="flex items-center gap-2 text-muted">
        Rows per page:
        {PAGE_SIZES.map((n) =>
          n === per ? (
            <span key={n} className="font-bold text-text">
              {n}
            </span>
          ) : (
            <Link key={n} href={href({ per: n, page: 1 })}>
              {n}
            </Link>
          ),
        )}
      </span>
    </nav>
  );
}
