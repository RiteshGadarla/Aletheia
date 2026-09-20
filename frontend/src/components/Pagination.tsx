import { IconChevronLeft, IconChevronRight, IconChevronsLeft, IconChevronsRight } from './Icons';

export const PAGE_SIZES = [25, 50, 100] as const;

interface Props {
  /** Zero-based row offset, sent straight to the API as `offset`. */
  offset: number;
  limit: number;
  total: number;
  onOffset: (offset: number) => void;
  onLimit: (limit: number) => void;
  /** Row noun, e.g. "events". */
  noun?: string;
  busy?: boolean;
}

/** Server-side pagination controls. Every change re-queries; nothing is sliced client-side. */
export function Pagination({ offset, limit, total, onOffset, onLimit, noun = 'rows', busy }: Props) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(pages, Math.floor(offset / limit) + 1);
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + limit, total);
  const atStart = offset <= 0;
  const atEnd = offset + limit >= total;

  return (
    <div className="pager">
      <span className="showing">
        {total === 0
          ? `No ${noun}`
          : <>Showing <b>{first.toLocaleString()}–{last.toLocaleString()}</b> of <b>{total.toLocaleString()}</b> {noun}</>}
      </span>

      <label className="size">
        <span>Rows per page</span>
        <select
          value={limit}
          disabled={busy}
          onChange={(e) => {
            const next = Number(e.target.value);
            // Keep the first visible row visible when the page size changes.
            onLimit(next);
            onOffset(Math.floor(offset / next) * next);
          }}
        >
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>

      <div className="controls">
        <button type="button" disabled={atStart || busy} onClick={() => onOffset(0)} aria-label="First page" title="First page">
          <IconChevronsLeft size={14} />
        </button>
        <button type="button" disabled={atStart || busy} onClick={() => onOffset(Math.max(0, offset - limit))} aria-label="Previous page" title="Previous page">
          <IconChevronLeft size={14} />
        </button>
        <span className="page-of">Page {page.toLocaleString()} of {pages.toLocaleString()}</span>
        <button type="button" disabled={atEnd || busy} onClick={() => onOffset(offset + limit)} aria-label="Next page" title="Next page">
          <IconChevronRight size={14} />
        </button>
        <button type="button" disabled={atEnd || busy} onClick={() => onOffset((pages - 1) * limit)} aria-label="Last page" title="Last page">
          <IconChevronsRight size={14} />
        </button>
      </div>
    </div>
  );
}
