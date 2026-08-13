import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * @param {object} props
 * @param {number} props.offset
 * @param {number} props.limit
 * @param {number} [props.total]   - total matching rows, when the caller knows it
 * @param {number} [props.pageCount] - rows actually returned for THIS page.
 *   Lets the control behave correctly even without a total: a short page is
 *   proof there is no next one.
 * @param {(offset: number) => void} props.onChange
 */
export function Pagination({ offset, limit, total, pageCount, onChange }) {
  const page = Math.floor(offset / limit) + 1;
  const canPrev = offset > 0;

  // "Next" used to be unconditionally enabled whenever `total` was undefined,
  // which is the case on five of the pages that use this. Clicking it past the
  // end produced an empty list that -- before ErrorState and this fix -- read
  // as "no files found", i.e. the app told you your repository was empty
  // because you pressed Next once too often.
  //
  // pageCount closes that without needing a count query: a page that came back
  // shorter than `limit` is the last page, by definition.
  const canNext =
    total !== undefined
      ? offset + limit < total
      : pageCount === undefined
        ? true
        : pageCount >= limit;

  // The upper bound is the last row that actually exists, not offset+limit.
  // On the final page of 9,398 rows the old arithmetic read "Showing
  // 9376–9400 of 9398" -- a range running past the total it printed beside it.
  const lastOnPage =
    total !== undefined
      ? Math.min(offset + limit, total)
      : pageCount !== undefined
        ? offset + pageCount
        : offset + limit;

  // Nothing at all to show: say so rather than "Showing 1–0".
  const showingLabel =
    lastOnPage <= offset
      ? "No results"
      : `Showing ${offset + 1}–${lastOnPage}${total !== undefined ? ` of ${total}` : ""}`;

  return (
    <nav
      className="flex items-center justify-between border-t border-white/5 px-4 py-3 text-sm text-base-400"
      aria-label="Pagination"
    >
      <span aria-live="polite">{showingLabel}</span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="btn-ghost btn-sm"
          disabled={!canPrev}
          onClick={() => onChange(Math.max(0, offset - limit))}
        >
          <ChevronLeft size={14} aria-hidden="true" /> Prev
        </button>
        <span className="px-2 text-base-300">Page {page}</span>
        <button
          type="button"
          className="btn-ghost btn-sm"
          disabled={!canNext}
          onClick={() => onChange(offset + limit)}
        >
          Next <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
