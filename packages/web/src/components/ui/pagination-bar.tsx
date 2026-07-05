import { Button } from './button.js';

/**
 * Which page numbers to render: current ±1, first, last, with 'gap'
 * markers where the sequence jumps. Exported for direct unit testing.
 */
export function pageWindow(page: number, totalPages: number): Array<number | 'gap'> {
  const wanted = [1, page - 1, page, page + 1, totalPages];
  const pages = [...new Set(wanted)]
    .filter((p) => p >= 1 && p <= totalPages)
    .sort((a, b) => a - b);
  const out: Array<number | 'gap'> = [];
  let prev = 0;
  for (const p of pages) {
    if (p - prev > 1) out.push('gap');
    out.push(p);
    prev = p;
  }
  return out;
}

interface PaginationBarProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

/**
 * Numbered pagination with Prev/Next and a "Showing X–Y of N" summary.
 * Purely presentational; hidden entirely when one page holds everything.
 */
export function PaginationBar({
  page,
  pageSize,
  total,
  onPageChange,
}: PaginationBarProps): JSX.Element | null {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
      <span className="text-xs text-ink-muted">
        Showing {from}–{to} of {total}
      </span>
      <nav aria-label="Pagination" className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          ◀ Prev
        </Button>
        {pageWindow(page, totalPages).map((p, i) =>
          p === 'gap' ? (
            <span key={`gap-${i}`} aria-hidden className="px-1 text-ink-muted">
              …
            </span>
          ) : (
            <Button
              key={p}
              variant="ghost"
              size="sm"
              aria-current={p === page ? 'page' : undefined}
              className={p === page ? 'font-semibold text-ink-primary underline' : ''}
              onClick={() => onPageChange(p)}
            >
              {p}
            </Button>
          ),
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next ▶
        </Button>
      </nav>
    </div>
  );
}
