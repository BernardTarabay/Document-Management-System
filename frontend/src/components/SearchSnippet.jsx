import { Quote } from "lucide-react";

/**
 * The matching excerpt from inside a document, with the search term marked.
 *
 * The snippet arrives from Postgres `ts_headline` wrapped in <mark> tags --
 * but ts_headline does NOT escape the document's own text, so rendering it
 * with dangerouslySetInnerHTML would execute whatever HTML happened to be
 * inside somebody's file. Splitting on the tags and letting React build the
 * nodes keeps the highlight and escapes the content, which is exactly what
 * React's default behaviour is for.
 *
 * Shared by the Files page and the Subjects page so a search result looks
 * the same wherever it is shown.
 */
export function SearchSnippet({ snippet, className = "" }) {
  if (!snippet) return null;

  const parts = String(snippet).split(/<\/?mark>/);
  return (
    <p className={`mt-1 line-clamp-2 text-xs leading-relaxed text-base-400 ${className}`}>
      <Quote size={10} className="mr-1 inline shrink-0 text-base-600" />
      {parts.map((part, i) =>
        // Odd indices are what sat between the tags -- the matched term.
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-brand-500/25 px-0.5 text-brand-100">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </p>
  );
}

/**
 * Why a result matched -- content, name, or the AI title/summary. Worth
 * showing: "this matched inside the document" and "this matched its
 * filename" are very different levels of confidence for the person reading.
 */
export function MatchReason({ file }) {
  const reasons = [
    file.matched_content && "in content",
    file.matched_filename && "in name",
    file.matched_ai && "in AI title",
  ].filter(Boolean);

  if (reasons.length === 0) return null;
  return <span className="text-[11px] text-base-500">matched {reasons.join(" · ")}</span>;
}
