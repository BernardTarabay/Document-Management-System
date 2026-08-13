import { useState, useEffect } from "react";
import {
  Copy, CheckCircle2, Wand2, GitCompare, Fingerprint, ScanSearch, Pencil,
  RefreshCw, Eye, Cloud, ScanLine, Crown, FolderOpen, Download, FolderInput, Trash2,
} from "lucide-react";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";
import { PageHeader } from "../components/PageHeader";
import { PageSpinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { StatusBadge } from "../components/StatusBadge";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CompareFilesModal } from "../components/CompareFilesModal";
import { EditFileModal } from "../components/EditFileModal";
import { PreviewModal } from "../components/PreviewModal";
import { FileDetailModal } from "../components/FileDetailModal";
import { MoveFileModal } from "../components/MoveFileModal";
import { DocumentDateInline, LocationLabel } from "../components/DocumentDate";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";
import { formatBytes } from "../utils/format";

/** 0.9306 -> "93.1%". Null/undefined scores render as a dash, never "NaN%". */
function formatScore(score) {
  if (score === null || score === undefined) return null;
  const n = Number(score);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : null;
}

/**
 * A duplicate-group member as the compare modal wants it. Members carry
 * `file_id`, files carry `id`; without this the pair silently compares
 * `undefined` against `undefined`.
 */
function asFile(member) {
  return {
    id: member.file_id,
    filename_current: member.filename_current,
    current_path: member.current_path,
    ai_short_title: member.ai_short_title,
  };
}

export function DuplicateGroupsPage() {
  const { push } = useToast();
  const { hasPermission } = useAuth();
  const { data: groups, loading, error, reload } = useApiData(
    () => api.get("/duplicate-groups", { status: "open", limit: 100 }),
    []
  );
  const [expanded, setExpanded] = useState(null);
  const [autoOpen, setAutoOpen] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);

  const exactCount = (groups || []).filter((g) => g.group_type === "exact").length;

  async function confirmAutoResolve() {
    setAutoBusy(true);
    try {
      await api.post("/duplicate-groups/auto-resolve");
      push("Auto-resolving exact groups — check Processing Jobs for progress.", "success");
      setAutoOpen(false);
      reload();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setAutoBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Duplicate groups"
        description="Exact duplicates are byte-identical (SHA-256 match). Probable duplicates share most of their text without being identical — a re-saved or re-exported copy. Nothing is ever deleted automatically."
        actions={
          <>
            <button className="btn-ghost btn-sm" onClick={reload} disabled={loading} title="Reload">
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
            </button>
            <button className="btn-ghost btn-sm" onClick={() => setCompareOpen(true)}>
              <GitCompare size={13} /> Compare two files
            </button>
            {hasPermission("duplicate.manage") && exactCount > 0 ? (
              <button className="btn-secondary btn-sm" onClick={() => setAutoOpen(true)}>
                <Wand2 size={13} /> Auto-resolve exact
              </button>
            ) : null}
          </>
        }
      />

      {loading ? (
        <PageSpinner />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} title="Couldn't load duplicate groups" />
      ) : !groups?.length ? (
        <EmptyState
          icon={Copy}
          title="No open duplicate groups"
          description="Nothing unresolved. You can still compare any two files directly if you suspect a near-copy the pipeline didn't flag."
          action={
            <button className="btn-secondary btn-sm" onClick={() => setCompareOpen(true)}>
              <GitCompare size={13} /> Compare two files
            </button>
          }
        />
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <DuplicateGroupCard
              key={g.id}
              group={g}
              expanded={expanded === g.id}
              onToggle={() => setExpanded(expanded === g.id ? null : g.id)}
              onResolved={() => { reload(); push("Duplicate group resolved.", "success"); }}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={autoOpen}
        onClose={() => setAutoOpen(false)}
        onConfirm={confirmAutoResolve}
        loading={autoBusy}
        title="Auto-resolve exact duplicate groups"
        confirmLabel="Auto-resolve"
        description={
          "Picks a canonical copy for every open EXACT group — preferring a copy that already has a real " +
          "title from the naming pipeline, otherwise the earliest import. Probable groups are deliberately " +
          "skipped: their members are not identical, so choosing between them is a judgement only you can " +
          "make. Nothing is ever deleted; this only records which copy is canonical. Runs as a background job."
        }
      />

      <CompareFilesModal open={compareOpen} onClose={() => setCompareOpen(false)} />
    </div>
  );
}

/**
 * The facts that actually decide which copy to keep, on the row itself.
 *
 * For an EXACT group the bytes are identical, so nothing about the content
 * can break the tie -- what breaks it is where the copy lives, whether it got
 * indexed, whether it is filed, and whether it is really on this machine at
 * all. Those were all knowable and none of them were shown.
 */
function MemberFacts({ member }) {
  const unreadable = member.text_quality && member.text_quality !== "ok";
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-base-500">
      <span className="tabular-nums">{formatBytes(member.size_bytes)}</span>
      <span className="text-base-600">·</span>
      <DocumentDateInline date={member.document_date} source={member.document_date_source} />
      <LocationLabel name={member.location_name} isReadOnly={member.location_is_read_only} />
      <span className="text-base-600">·</span>
      <span className="inline-flex items-center gap-1" title={member.subject_name ? "Filed under this subject" : "Not classified into any subject"}>
        <FolderOpen size={10} /> {member.subject_name || "unfiled"}
      </span>
      {member.is_cloud_placeholder && (
        <span className="inline-flex items-center gap-1 text-sky-300" title="Stored in the cloud and not downloaded locally — keeping this copy keeps a pointer, not the bytes.">
          <Cloud size={10} /> cloud only
        </span>
      )}
      {unreadable && (
        <span className="inline-flex items-center gap-1 text-amber-300" title={`Text extraction returned "${member.text_quality}" — this copy isn't searchable by content. A readable copy is the better one to keep.`}>
          <ScanLine size={10} /> {member.needs_ocr ? "needs OCR" : "unreadable"}
        </span>
      )}
      {member.text_length > 0 && !unreadable && (
        <span title="Characters of extracted, searchable text">
          {member.text_length.toLocaleString()} chars indexed
        </span>
      )}
      {member.status !== "active" && <StatusBadge value={member.status} />}
    </div>
  );
}

function DuplicateGroupCard({ group, expanded, onToggle, onResolved }) {
  const { push } = useToast();
  const { hasPermission } = useAuth();
  const { data: detail, loading, reload: reloadDetail } = useApiData(
    () => (expanded ? api.get(`/duplicate-groups/${group.id}`) : Promise.resolve(null)),
    [expanded]
  );
  const [resolving, setResolving] = useState(null);
  const [renameTarget, setRenameTarget] = useState(null);
  const [previewFileId, setPreviewFileId] = useState(null);
  const [detailFileId, setDetailFileId] = useState(null);
  const [moveTarget, setMoveTarget] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removing, setRemoving] = useState(false);
  const [selected, setSelected] = useState(() => []);
  const [comparePair, setComparePair] = useState(null);

  async function downloadFile(id, filename) {
    try {
      await api.download(`/files/${id}/download`, filename);
    } catch (err) {
      push(err.message, "error");
    }
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await api.del(`/files/${removeTarget.id}`);
      push(`"${removeTarget.filename_current}" removed.`, "success");
      setRemoveTarget(null);
      reloadDetail();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setRemoving(false);
    }
  }

  const isExact = group.group_type === "exact";
  const groupScore = formatScore(group.confidence_score);
  const members = detail?.members || [];

  // The overwhelmingly common group is a pair, and for a pair there is only
  // one comparison to make -- so make it the default rather than asking the
  // user to tick two boxes to express the only possible choice.
  useEffect(() => {
    setSelected(members.length === 2 ? members.map((m) => m.file_id) : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

  /**
   * Selection is capped at two because comparison is pairwise. Ticking a
   * third drops the oldest rather than refusing the click: "you must untick
   * something first" is a rule the user has to discover by being blocked.
   */
  function toggleSelected(fileId) {
    setSelected((prev) =>
      prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId].slice(-2)
    );
  }

  function compareSelected() {
    const [a, b] = selected.map((id) => members.find((m) => m.file_id === id)).filter(Boolean);
    if (a && b) setComparePair({ a: asFile(a), b: asFile(b) });
  }

  async function resolve(fileId) {
    setResolving(fileId);
    try {
      await api.post(`/duplicate-groups/${group.id}/resolve`, { canonicalFileId: fileId });
      onResolved();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setResolving(null);
    }
  }

  return (
    <div className="glass-card animate-fade-in-up overflow-hidden">
      <button onClick={onToggle} className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left">
        <div className="flex min-w-0 items-center gap-3">
          {isExact ? (
            <Fingerprint size={16} className="shrink-0 text-rose-400" />
          ) : (
            <ScanSearch size={16} className="shrink-0 text-amber-400" />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium text-base-100">
                {isExact ? "Exact duplicate" : "Probable duplicate"}
              </p>
              <span className={isExact ? "badge-rose" : "badge-amber"}>
                {isExact ? "100% identical" : groupScore ? `~${groupScore} similar` : "similarity unknown"}
              </span>
              {group.confidence_level && (
                <span className="text-xs text-base-500">{group.confidence_level} confidence</span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-base-400">
              {isExact
                ? "Byte-for-byte identical — matched on SHA-256 hash."
                : "Not identical. Matched on content similarity, and needs your review before anything is resolved."}
            </p>
          </div>
        </div>
        <StatusBadge value={group.status} />
      </button>

      {expanded && (
        <div className="border-t border-white/5 px-5 py-4">
          {loading ? (
            <PageSpinner />
          ) : (
            <>
              {/* Comparing is the answer to "are these really the same
                  document?", which is the question a PROBABLE group asks and
                  cannot answer for you. For an exact group the comparison is
                  still offered -- it comes back "byte-for-byte identical",
                  which is a confirmation worth being able to get. */}
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-base-400">
                  {members.length} cop{members.length === 1 ? "y" : "ies"} · pick any two to compare, or open one to look at it.
                </p>
                <button
                  className="btn-ghost btn-sm"
                  disabled={selected.length !== 2}
                  onClick={compareSelected}
                  title={
                    selected.length === 2
                      ? "Compare the two selected copies"
                      : "Select exactly two copies to compare them"
                  }
                >
                  <GitCompare size={13} />
                  {selected.length === 2 ? "Compare these two" : `Compare (${selected.length}/2)`}
                </button>
              </div>

              <ul className="space-y-2">
                {members.map((m) => {
                  const memberScore = formatScore(m.similarity_score);
                  const isSelected = selected.includes(m.file_id);
                  return (
                    <li
                      key={m.id}
                      // Click-the-row-for-detail, exactly like the Files tab.
                      // The checkbox and every button stopPropagation so
                      // selecting a copy to compare is not also "open it".
                      onClick={() => setDetailFileId(m.file_id)}
                      className={
                        "table-row-hover flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-2.5 transition-colors " +
                        (isSelected
                          ? "border-brand-500/40 bg-brand-500/[0.07]"
                          : "border-white/5 bg-white/[0.02]")
                      }
                    >
                      <input
                        type="checkbox"
                        className="mt-1 shrink-0 accent-brand-500"
                        checked={isSelected}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleSelected(m.file_id)}
                        title="Select this copy to compare"
                      />

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm text-base-100">
                            {m.ai_short_title || m.canonical_filename || m.filename_current}
                          </p>
                          {m.is_canonical && (
                            <span className="badge-emerald" title="Already recorded as the canonical copy for this group.">
                              <Crown size={10} /> canonical
                            </span>
                          )}
                        </div>
                        <p className="truncate font-mono text-xs text-base-500" title={m.current_path}>
                          {m.current_path}
                        </p>
                        <MemberFacts member={m} />
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        {memberScore && (
                          <span
                            className="mr-1 font-mono text-xs tabular-nums text-base-300"
                            title={
                              isExact
                                ? "Exact hash match"
                                : "Share of five-word phrases in common with the file that triggered this group"
                            }
                          >
                            {memberScore}
                          </span>
                        )}
                        {/* Same action set, same order, same permission gates
                            as a Files-tab row -- plus the one action that
                            only means anything here. */}
                        {hasPermission("document.download") && m.status === "active" && (
                          <button
                            className="btn-ghost btn-sm"
                            onClick={(e) => { e.stopPropagation(); setPreviewFileId(m.file_id); }}
                            title="Preview"
                          >
                            <Eye size={13} />
                          </button>
                        )}
                        <button
                          className="btn-ghost btn-sm"
                          onClick={(e) => { e.stopPropagation(); downloadFile(m.file_id, m.filename_current); }}
                          title="Download"
                        >
                          <Download size={13} />
                        </button>
                        {(hasPermission("document.rename") || hasPermission("classification.modify")) && m.status !== "deleted" && (
                          <button
                            className="btn-ghost btn-sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenameTarget({ id: m.file_id, filename_current: m.filename_current });
                            }}
                            title="Edit"
                          >
                            <Pencil size={13} />
                          </button>
                        )}
                        {hasPermission("classification.modify") && m.status !== "deleted" && (
                          <button
                            className="btn-ghost btn-sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setMoveTarget({ id: m.file_id, filename_current: m.filename_current });
                            }}
                            title="Move to another subject"
                          >
                            <FolderInput size={13} />
                          </button>
                        )}
                        {hasPermission("document.delete") && m.status !== "deleted" && (
                          <button
                            className="btn-ghost btn-sm text-rose-400 hover:text-rose-300"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRemoveTarget({ id: m.file_id, filename_current: m.filename_current });
                            }}
                            title="Remove file"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                        <button
                          className="btn-secondary btn-sm"
                          disabled={resolving === m.file_id}
                          onClick={(e) => { e.stopPropagation(); resolve(m.file_id); }}
                          title="Record this copy as the one to keep. Nothing is deleted."
                        >
                          <CheckCircle2 size={13} /> {resolving === m.file_id ? "Setting…" : "Set canonical"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}

      <PreviewModal fileId={previewFileId} onClose={() => setPreviewFileId(null)} />

      {/* All three handlers wired, same as FilesPage. Previously only onEdit
          was passed, so the detail modal's Move and Remove buttons rendered
          for anyone holding the permission and called an undefined handler. */}
      <FileDetailModal
        fileId={detailFileId}
        onClose={() => setDetailFileId(null)}
        onEdit={(f) => { setDetailFileId(null); setRenameTarget(f); }}
        onMove={(f) => { setDetailFileId(null); setMoveTarget(f); }}
        onDelete={(f) => { setDetailFileId(null); setRemoveTarget(f); }}
      />

      <MoveFileModal
        file={moveTarget}
        onClose={() => setMoveTarget(null)}
        onMoved={() => { setMoveTarget(null); reloadDetail(); push("File moved.", "success"); }}
      />

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        onConfirm={confirmRemove}
        loading={removing}
        danger
        title="Remove file"
        confirmLabel="Remove"
        description={
          removeTarget
            ? `Remove "${removeTarget.filename_current}"? It's marked deleted (not erased from disk) and any pending rename proposal for it is cancelled. The other copies in this group are untouched.`
            : ""
        }
      />

      {/* Seeded with both copies, and with the rest of the group as one-click
          alternatives -- searching by filename for files listed on screen is
          the step this page was missing. */}
      <CompareFilesModal
        open={Boolean(comparePair)}
        onClose={() => setComparePair(null)}
        initialFile={comparePair?.a || null}
        initialFileB={comparePair?.b || null}
        candidates={members.map(asFile)}
      />

      <EditFileModal
        file={renameTarget}
        onClose={() => setRenameTarget(null)}
        onSaved={() => {
          setRenameTarget(null);
          reloadDetail();
          push("File updated.", "success");
        }}
      />
    </div>
  );
}
