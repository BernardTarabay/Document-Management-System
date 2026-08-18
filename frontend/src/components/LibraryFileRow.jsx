import {
  FileText, Eye, Download, FolderInput, Pencil, Trash2, Sparkles, CheckSquare, Square,
} from "lucide-react";
import { DocumentDateInline, LocationLabel } from "./DocumentDate";
import { SearchSnippet, MatchReason } from "./SearchSnippet";

/**
 * One file in the Library's file panel.
 *
 * Extracted from LibraryPage so the panel can be windowed: react-window asks
 * for "row N" and needs a component to render it, which a `.map()` inside the
 * page cannot provide.
 *
 * ROW HEIGHT IS MEASURED, NOT ASSUMED. These rows are genuinely variable --
 * a search hit carries a snippet and a match reason, a plain listing does not,
 * and a long path wraps. The list is given `useDynamicRowHeight`, which
 * observes the rendered rows (DynamicRowHeight.observeRowElements) and caches
 * what they actually measure. Hard-coding a height would either clip snippets
 * or leave a gap under every plain row.
 */
export function LibraryFileRow({
  index, style,
  documents, selectedFileIds, cursor, canMove, canModify, canDownload, canRename, canDelete,
  onSelectRow, onToggleSelect, onPreview, onDownload, onEdit, onMove, onRemove,
}) {
  const d = documents[index];
  if (!d) return null;
  const isSelected = selectedFileIds.has(d.id);
  const isCursor = index === cursor;

  return (
    <div style={style} className="pb-2">
      <div
            // Draggable straight onto a folder in the tree to reclassify.
            // The custom MIME type keeps this from being interpreted
            // as a text drop by anything else on the page.
            draggable={canModify}
            onDragStart={(e) => {
              e.dataTransfer.setData("text/dms-file-id", d.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            className={
              "table-row-hover flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm " +
              (canModify ? "cursor-grab active:cursor-grabbing " : "cursor-pointer ") +
              (isSelected
                ? "border-brand-500/40 bg-brand-500/10"
                : isCursor
                  // The keyboard cursor is a ring, not a fill: it says
                  // "you are here", which is a different statement from
                  // "this is selected", and conflating them makes j/k
                  // feel like it is ticking things.
                  ? "border-white/20 bg-white/[0.04] ring-1 ring-inset ring-white/15"
                  : "border-white/5 bg-white/[0.02]")
            }
            onClick={() => onSelectRow(index, d)}
          >
            {canMove && (
              <button
                className="shrink-0 p-0.5 text-base-500 hover:text-brand-300"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSelect(index, { shiftKey: e.shiftKey });
                }}
                title={isSelected ? "Deselect" : "Select (shift-click for a range)"}
                aria-pressed={isSelected}
              >
                {isSelected
                  ? <CheckSquare size={15} className="text-brand-400" />
                  : <Square size={15} />}
              </button>
            )}
            <FileText size={14} className="mt-0.5 shrink-0 text-base-400" />
            <div className="min-w-0 flex-1">
              {/* display_name comes from listBySubject; search
                  results return the raw row, so fall back to
                  filename_current rather than rendering blank. */}
              <p className="truncate font-medium text-base-100">
                {d.ai_short_title || d.display_name || d.filename_current}
              </p>
              {d.ai_short_title ? (
                <p className="flex items-center gap-1 truncate text-xs text-base-500">
                  <Sparkles size={10} className="shrink-0 text-brand-400" />
                  {d.display_name || d.filename_current}
                </p>
              ) : (
                <p className="truncate font-mono text-xs text-base-500">{d.current_path}</p>
              )}
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-base-500">
                <DocumentDateInline date={d.document_date} source={d.document_date_source} />
                <LocationLabel name={d.location_name} isReadOnly={d.location_is_read_only} />
              </div>
              <SearchSnippet snippet={d.snippet} />
              <MatchReason file={d} />
            </div>
            <div className="flex shrink-0 gap-1">
              {canDownload && (
                <button
                  className="btn-ghost btn-sm"
                  onClick={(e) => { e.stopPropagation(); onPreview(d); }}
                  title="Preview"
                >
                  <Eye size={13} />
                </button>
              )}
              <button
                className="btn-ghost btn-sm"
                onClick={(e) => { e.stopPropagation(); onDownload(d); }}
                title="Download"
              >
                <Download size={13} />
              </button>
              {(canRename || canModify) && (
                <button
                  className="btn-ghost btn-sm"
                  onClick={(e) => { e.stopPropagation(); onEdit(d); }}
                  title="Edit"
                >
                  <Pencil size={13} />
                </button>
              )}
              {canModify && (
                <button
                  className="btn-ghost btn-sm"
                  onClick={(e) => { e.stopPropagation(); onMove(d); }}
                  title="Move to another subject"
                >
                  <FolderInput size={13} />
                </button>
              )}
              {canDelete && (
                <button
                  className="btn-ghost btn-sm text-rose-400 hover:text-rose-300"
                  onClick={(e) => { e.stopPropagation(); onRemove(d); }}
                  title="Remove file"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          </div>
    </div>
  );
}
