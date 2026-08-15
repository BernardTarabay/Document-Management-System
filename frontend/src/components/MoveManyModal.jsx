import { useState } from "react";
import { FolderInput, Search } from "lucide-react";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";
import { Modal } from "./Modal";
import { PageSpinner } from "./Spinner";
import { useToast } from "../context/ToastContext";
import { DuplicateFindings, DuplicateSummaryLine } from "./DuplicateFindings";

/**
 * Move several files into one folder.
 *
 * WHY THIS IS NOT A LOOP OVER MoveFileModal
 *
 * Because the duplicate guard runs per file, and a bulk move can therefore
 * come back partially blocked: 27 filed, 2 need a decision. A loop of single
 * modals would ask 29 separate questions; a single request that reports the
 * outcome per file asks one, and only about the files that actually need it.
 *
 * The backend does loop -- fileOrganizeService.moveManyToSubject calls the
 * same single-file path for each, so every safety check applies. What is
 * batched is the CONVERSATION, not the checking.
 *
 * @param {object} props
 * @param {string[]} props.fileIds
 * @param {string} props.endpoint - "/photos/move" or "/triage/move"
 */
export function MoveManyModal({ fileIds, endpoint, title, onClose, onMoved }) {
  const { push } = useToast();
  const { data: subjects, loading } = useApiData(() => api.get("/subjects"), []);
  const [subjectId, setSubjectId] = useState("");
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflicts, setConflicts] = useState(null);

  const needle = filter.trim().toLowerCase();
  const options = (subjects || []).filter(
    (s) => !needle ||
      (s.materialized_path || "").toLowerCase().includes(needle) ||
      (s.name || "").toLowerCase().includes(needle)
  );

  async function move({ confirmDuplicates = false } = {}) {
    if (!subjectId) return;
    setSaving(true);
    try {
      const result = await api.post(endpoint, { fileIds, subjectId, confirmDuplicates });
      const blocked = result.needsConfirmation || [];

      if (blocked.length > 0 && !confirmDuplicates) {
        setConflicts(result);
        return;
      }

      // Reported precisely rather than as a bare "done". On a batch the
      // interesting part is always what did NOT go, and silently dropping
      // those is how files appear to vanish.
      const parts = [`${result.moved.length} filed`];
      if (result.failed?.length) parts.push(`${result.failed.length} failed`);
      if (result.notFound?.length) parts.push(`${result.notFound.length} not found`);
      push(parts.join(", ") + ".", result.failed?.length ? "info" : "success");
      onMoved();
    } catch (err) {
      // 409 carries the findings; anything else is a real error.
      if (err.status === 409 && err.details) setConflicts(err.details);
      else push(err.message, "error");
    } finally {
      setSaving(false);
    }
  }

  if (conflicts) {
    const blocked = conflicts.needsConfirmation || [];
    const allFindings = blocked.flatMap((b) => b.findings || []);
    return (
      <Modal
        open
        onClose={onClose}
        title="Some of these already exist"
        width="max-w-lg"
        footer={
          <>
            <button className="btn-ghost btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
            <button
              className="btn-primary btn-sm"
              disabled={saving}
              onClick={() => move({ confirmDuplicates: true })}
            >
              {saving ? "Filing…" : `Keep both, file all ${fileIds.length}`}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-base-200">
            {conflicts.moved?.length > 0 && (
              <><strong>{conflicts.moved.length}</strong> filed already. </>
            )}
            <strong>{blocked.length}</strong> look like documents you already have.
          </p>
          <DuplicateSummaryLine findings={allFindings} />
          <DuplicateFindings findings={allFindings.slice(0, 8)} />
          {allFindings.length > 8 && (
            <p className="text-xs text-base-500">…and {allFindings.length - 8} more.</p>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={title || `Move ${fileIds.length} file${fileIds.length === 1 ? "" : "s"}`}
      width="max-w-md"
      footer={
        <>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={() => move()} disabled={saving || !subjectId}>
            {saving ? "Moving…" : `Move ${fileIds.length}`}
          </button>
        </>
      }
    >
      {loading ? (
        <PageSpinner />
      ) : (
        <div className="space-y-3">
          <p className="flex items-start gap-1.5 text-sm text-base-300">
            <FolderInput size={14} className="mt-0.5 shrink-0 text-base-400" />
            Moving <strong className="text-base-100">{fileIds.length}</strong> file
            {fileIds.length === 1 ? "" : "s"} into one folder.
          </p>

          <div>
            <label className="label mb-1.5 block" htmlFor="move-many-filter">Find a folder</label>
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-base-500" aria-hidden="true" />
              <input
                id="move-many-filter"
                className="input pl-8"
                placeholder="Type to narrow the list…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="label mb-1.5 block" htmlFor="move-many-subject">Folder</label>
            <select
              id="move-many-subject"
              className="input"
              size={Math.min(Math.max(options.length, 4), 10)}
              value={subjectId}
              onChange={(e) => setSubjectId(e.target.value)}
            >
              {options.map((s) => (
                <option key={s.id} value={s.id}>{s.materialized_path || s.name}</option>
              ))}
            </select>
            {needle && options.length === 0 && (
              <p className="mt-1.5 text-xs text-base-500">
                No folder matches “{filter}”. Create one on the Subjects page.
              </p>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
