import { useState } from "react";
import { Wand2, Check, X, PlayCircle, ArrowRight, RotateCcw, FolderInput, Pencil, RefreshCw, ListX } from "lucide-react";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";
import { PageHeader } from "../components/PageHeader";
import { PageSpinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { StatusBadge } from "../components/StatusBadge";
import { EditFileModal } from "../components/EditFileModal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";

const STATUSES = ["pending", "approved", "rejected", "applied"];

export function RenameProposalsPage() {
  const [status, setStatus] = useState("pending");
  const [selected, setSelected] = useState(() => new Set());
  const [busyId, setBusyId] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const { push } = useToast();
  const { hasPermission } = useAuth();

  const { data: proposals, loading, error, reload, setData } = useApiData(() => api.get("/rename-proposals", { status, limit: 100 }), [status]);

  // Counted server-side rather than from the page of 100 rows above -- the
  // whole point is that there may be thousands, and a button offering to
  // clear "37" when the real number is 3,700 would be a lie.
  const { data: zeroConfidence, reload: reloadZeroCount } = useApiData(
    () => api.get("/rename-proposals/below-confidence", { maxConfidence: 0 }),
    [status]
  );
  const zeroConfidenceCount = zeroConfidence?.count || 0;

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Removes the row from the currently-viewed tab immediately, instead of
  // re-fetching (which flashes the whole table through a loading spinner).
  // Whatever just happened to it (approved/rejected/retried) means it no
  // longer belongs in this tab's list either way -- if it moved to a
  // different tab, it'll be there next time that tab loads.
  function removeLocally(id) {
    setData((prev) => (prev || []).filter((p) => p.id !== id));
  }

  async function review(id, action) {
    setBusyId(id);
    try {
      await api.post(`/rename-proposals/${id}/${action}`);
      // Approving immediately enqueues the actual rename/move (no separate
      // "apply" step) -- say so, since the file won't visibly move for a
      // moment while the background job picks it up.
      push(
        action === "approve"
          ? "Approved — renaming/moving the file now. Check Processing Jobs for progress."
          : "Proposal rejected.",
        "success"
      );
      removeLocally(id);
    } catch (err) {
      push(err.message, "error");
    } finally {
      setBusyId(null);
    }
  }

  // Discards a rejected/applied proposal and re-queues its file for
  // classification, so a new pending proposal gets generated -- no more
  // needing to wipe the database just to try a file again.
  async function retry(id) {
    setBusyId(id);
    try {
      await api.post(`/rename-proposals/${id}/retry`);
      push("File re-queued for classification — check Pending shortly.", "success");
      removeLocally(id);
    } catch (err) {
      push(err.message, "error");
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Clears the long tail of proposals the classifier had no basis for.
   *
   * A scan of a real drive produces one proposal per file, including the
   * thousands it could not read -- image-only PDFs, formats with no text
   * extractor, scans whose only content is a letterhead. Those land at 0.0
   * and bury the proposals actually worth a decision, and rejecting them one
   * row at a time is why nobody ever reaches the bottom of the queue.
   */
  async function clearZeroConfidence() {
    setClearBusy(true);
    try {
      const res = await api.post("/rename-proposals/below-confidence/reject", { maxConfidence: 0 });
      push(
        res.rejected > 0
          ? `Discarded ${res.rejected} zero-confidence suggestion(s). No files were touched.`
          : "Nothing to discard.",
        "success"
      );
      setClearOpen(false);
      reload();
      reloadZeroCount();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setClearBusy(false);
    }
  }

  async function bulkApply() {
    setBulkBusy(true);
    try {
      await api.post("/rename-proposals/bulk-apply", { proposalIds: Array.from(selected) });
      push(`Bulk rename queued for ${selected.size} file(s).`, "success");
      setSelected(new Set());
      reload();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Rename proposals"
        description="System-generated canonical names, held for review — nothing is ever applied without approval."
        actions={
          <>
            <button className="btn-ghost btn-sm" onClick={reload} disabled={loading} title="Reload">
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
            </button>
            {/* Only on Pending: the other tabs hold decisions already made,
                and "clear the junk" is about the queue you still have to get
                through. */}
            {hasPermission("bulk.approve") && status === "pending" && zeroConfidenceCount > 0 ? (
              <button className="btn-ghost btn-sm text-amber-300" onClick={() => setClearOpen(true)} disabled={clearBusy}>
                <ListX size={14} /> Clear {zeroConfidenceCount} at 0%
              </button>
            ) : null}
            {hasPermission("bulk.approve") && selected.size > 0 ? (
              <button className="btn-primary btn-sm" onClick={bulkApply} disabled={bulkBusy}>
                <PlayCircle size={14} /> {bulkBusy ? "Applying…" : `Apply ${selected.size} approved`}
              </button>
            ) : null}
          </>
        }
      />

      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        onConfirm={clearZeroConfidence}
        // `busy` is not a prop ConfirmDialog takes -- it reads `loading`. So
        // the confirm button was never disabled and never showed "Working…",
        // and a second click fired POST /below-confidence/reject again while
        // the first bulk rejection of potentially thousands of proposals was
        // still running.
        loading={clearBusy}
        title={`Discard ${zeroConfidenceCount} suggestion${zeroConfidenceCount === 1 ? "" : "s"}?`}
        confirmLabel="Discard them"
        description={
          `These are the proposals the classifier had nothing to go on for — usually scanned images, ` +
          `formats with no extractable text, or files whose only content is a letterhead. ` +
          `Discarding them changes no file on disk and queues no work; it only clears them out of this ` +
          `queue. If a file is re-processed later (say text extraction improves), it gets a fresh suggestion.`
        }
      />

      <div className="mb-4 flex gap-1.5">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => { setStatus(s); setSelected(new Set()); }}
            className={s === status ? "btn-secondary btn-sm" : "btn-ghost btn-sm"}
          >
            {s}
          </button>
        ))}
      </div>

      {loading ? (
        <PageSpinner />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} title="Couldn't load rename proposals" />
      ) : !proposals?.length ? (
        <EmptyState icon={Wand2} title={`No ${status} proposals`} description="Rename proposals appear here once files are classified with sufficient confidence." />
      ) : (
        <div className="table-shell glass-card">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/5 text-xs uppercase tracking-wider text-base-400">
                {status === "approved" && <th className="w-10 px-4 py-3" />}
                <th className="px-4 py-3 font-medium">Rename &amp; Move</th>
                <th className="px-4 py-3 font-medium">Confidence</th>
                <th className="px-4 py-3 font-medium">Reason</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {proposals.map((p) => (
                <tr key={p.id} className="table-row-hover border-b border-white/5 last:border-0 align-top">
                  {status === "approved" && (
                    <td className="px-4 py-3">
                      <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} className="accent-brand-500" />
                    </td>
                  )}
                  <td className="px-4 py-3">
                    {p.current_filename !== p.proposed_filename && (
                      <div className="flex items-center gap-2 text-sm">
                        <span className="max-w-[180px] truncate text-base-400 line-through decoration-base-600">{p.current_filename}</span>
                        <ArrowRight size={13} className="shrink-0 text-base-500" />
                        <span className="max-w-[220px] truncate font-medium text-base-50">{p.proposed_filename}</span>
                      </div>
                    )}
                    {p.current_filename === p.proposed_filename && (
                      <span className="max-w-[220px] truncate text-sm font-medium text-base-50">{p.proposed_filename}</span>
                    )}
                    {p.proposed_relative_dir && (
                      <div className="mt-1 flex items-center gap-1.5 text-xs text-brand-300">
                        <FolderInput size={12} className="shrink-0" />
                        <span className="truncate">Move to {p.proposed_relative_dir}</span>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge value={p.confidence_level} />
                    <span className="ml-1.5 text-xs text-base-500">{Number(p.confidence_score).toFixed(2)}</span>
                  </td>
                  <td className="max-w-sm px-4 py-3 text-xs text-base-400">{p.reason}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1.5">
                      {/* Name it yourself instead of accepting or waiting on
                          the proposal -- the third option that was missing
                          here, where you can see the suggestion you disagree
                          with. */}
                      {hasPermission("document.rename") && (
                        <button
                          className="btn-ghost btn-sm"
                          onClick={() =>
                            setRenameTarget({ id: p.file_id, filename_current: p.current_filename })
                          }
                          title="Rename this file yourself"
                        >
                          <Pencil size={13} />
                        </button>
                      )}
                      {p.status === "pending" && (
                        <>
                          <button className="btn-secondary btn-sm" disabled={busyId === p.id} onClick={() => review(p.id, "approve")} title="Approve">
                            <Check size={13} />
                          </button>
                          <button className="btn-danger btn-sm" disabled={busyId === p.id} onClick={() => review(p.id, "reject")} title="Reject">
                            <X size={13} />
                          </button>
                        </>
                      )}
                      {(p.status === "rejected" || p.status === "applied") && hasPermission("document.rename") && (
                        <button
                          className="btn-secondary btn-sm"
                          disabled={busyId === p.id}
                          onClick={() => retry(p.id)}
                          title="Discard this proposal and re-run classification on the file"
                        >
                          <RotateCcw size={13} /> Retry
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <EditFileModal
        file={renameTarget}
        onClose={() => setRenameTarget(null)}
        onSaved={() => {
          setRenameTarget(null);
          reload();
          push("File updated.", "success");
        }}
      />
    </div>
  );
}
