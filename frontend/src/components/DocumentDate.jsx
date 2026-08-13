import { CalendarDays, HardDrive } from "lucide-react";

/**
 * When a document is FROM, shown so that a real date and a guessed one never
 * look alike (task #43).
 *
 * The distinction is the whole reason `document_date_source` exists
 * (migration 024). This archive was assembled from backups and copies, so a
 * file's filesystem timestamps mostly record the day someone ran the backup
 * -- rendering that as "12 Mar 2021" next to a date genuinely read out of a
 * PDF header would be presenting a guess with the same authority as a fact.
 *
 *   exif | pdf | embedded | ole   read out of the document -- shown plainly
 *   filesystem                    inferred -- shown muted and prefixed "~"
 *   none | null                   nothing known -- an em dash, not a blank
 *
 * A blank cell would read as "no column here"; an em dash reads as "we
 * looked and there is nothing", which is the true statement.
 */
const READ_FROM_DOCUMENT = ["exif", "pdf", "embedded", "ole"];

const SOURCE_LABEL = {
  exif: "Read from the photo's EXIF data.",
  pdf: "Read from the PDF's own metadata.",
  embedded: "Read from the document's embedded properties.",
  ole: "Read from the legacy Office document's properties.",
  filesystem:
    "Inferred from the file's timestamps, not read from the document. This archive came from " +
    "backups and copies, so that is often the day it was copied rather than the day it is from.",
};

function formatDay(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function DocumentDate({ date, source, className = "" }) {
  const formatted = date ? formatDay(date) : null;

  if (!formatted) {
    return (
      <span className={`text-base-600 ${className}`} title="No date could be established for this document.">
        —
      </span>
    );
  }

  const trusted = READ_FROM_DOCUMENT.includes(source);
  return (
    <span
      className={`whitespace-nowrap tabular-nums ${trusted ? "text-base-300" : "text-base-500"} ${className}`}
      title={SOURCE_LABEL[source] || "Source of this date is unknown."}
    >
      {trusted ? "" : "~"}{formatted}
    </span>
  );
}

/** The same thing as a labelled inline chip, for list rows rather than table cells. */
export function DocumentDateInline({ date, source }) {
  if (!date) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <CalendarDays size={10} className="shrink-0" />
      <DocumentDate date={date} source={source} />
    </span>
  );
}

/** Which registered folder the file physically lives in. */
export function LocationLabel({ name, isReadOnly, className = "" }) {
  if (!name) return <span className="text-base-600">—</span>;
  return (
    <span
      className={`inline-flex items-center gap-1 ${className}`}
      title={
        `Storage location: ${name}` +
        (isReadOnly ? " (read-only — originals here are never renamed or moved)" : "")
      }
    >
      <HardDrive size={10} className="shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}
