import { useState, useEffect } from "react";
import { FolderInput, Search } from "lucide-react";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";
import { Modal } from "./Modal";
import { PageSpinner } from "./Spinner";
import { useToast } from "../context/ToastContext";
import { DuplicateFindings, DuplicateSummaryLine } from "./DuplicateFindings";

/**
 * Focused "move this file to a different subject" action, separate from
 * the full Edit modal so moving between subjects (the thing the Subjects
 * page is organized around) is a one-click, unambiguous action rather than
 * one field buried in a bigger rename/reclassify form.
 *
 * Under the hood this is the same PATCH /files/:id {subjectId} call
 * EditFileModal makes -- reassigning a subject has never physically moved
 * the file on disk (see fileService.updateFile), it records a new manual
 * classification.
 *
 * THE DUPLICATE CHECK
 *
 * That PATCH now runs through fileOrganizeService.moveToSubject on the
 * backend, which refuses with 409 and a list of findings when the document
 * being filed is a duplicate or near-duplicate of one already in the tree.
 * This modal handles that answer rather than treating it as an error: it
 * shows what was found, and offers to file it anyway.
 *
 * Deliberately a second step and not a checkbox on the first screen. A
 * "file even if duplicate" checkbox is ticked once and then permanently
 * ignored, which is the same as not having the check at all.
 */
export function MoveFileModal({ file, onClose, onMoved }) {
  const { push } = useToast();
  const { data: detail, loading: loadingDetail } = useApiData(
    () => (file ? api.get(`/files/${file.id}`) : Promise.resolve(null)),
    [file?.id]
  );
  const { data: subjects, loading: loadingSubjects } = useApiData(
    () => (file ? api.get("/subjects") : Promise.resolve(null)),
    [file?.id]
  );

  const [subjectId, setSubjectId] = useState("");
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState("");
  // Set when the backend answered 409. Holding the findings here is what turns
  // the modal into its second step.
  const [findings, setFindings] = useState(null);

  const currentSubjectId = detail?.latestClassification?.classified_subject_id || "";

  useEffect(() => {
    setSubjectId(currentSubjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id, currentSubjectId]);

  async function move({ confirmDuplicate = false } = {}) {
    if (subjectId === currentSubjectId) { onClose(); return; }
    setSaving(true);
    try {
      const result = await api.patch(`/files/${file.id}`, {
        subjectId: subjectId || null,
        documentTypeId: detail?.latestClassification?.classified_document_type_id || null,
        confirmDuplicate,
      });

      // 200 with requiresConfirmation should not happen -- the backend answers
      // 409 for that -- but checking both means a change to the status code
      // degrades into "show the warning" rather than "silently file a
      // duplicate", which is the right way round to be wrong.
      if (result?.requiresConfirmation) {
        setFindings(result.findings || []);
        return;
      }

      if (result?.findings?.length) {
        push(`Filed. ${result.findings.length} similar document(s) were noted.`, "info");
      }
      onMoved();
    } catch (err) {
      if (err.status === 409 && err.details?.findings) {
        setFindings(err.details.findings);
        return;
      }
      push(err.message, "error");
    } finally {
      setSaving(false);
    }
  }

  const loading = loadingDetail || loadingSubjects;

  // A tree of any size is unusable as a bare <select>. Filtering on the
  // materialized path means typing "tax" finds Finance / Taxes wherever it
  // sits, without the user having to remember which branch it is under.
  const needle = filter.trim().toLowerCase();
  const options = (subjects || []).filter(
    (s) => !needle ||
      (s.materialized_path || "").toLowerCase().includes(needle) ||
      (s.name || "").toLowerCase().includes(needle)
  );

  if (findings) {
    return (
      <Modal
        open={Boolean(file)}
        onClose={onClose}
        title="A similar document already exists"
        width="max-w-lg"
        footer={
          <>
            <button className="btn-ghost btn-sm" onClick={() => setFindings(null)} disabled={saving}>
              Choose a different folder
            </button>
            <button className="btn-ghost btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
            <button
              className="btn-primary btn-sm"
              disabled={saving}
              onClick={() => move({ confirmDuplicate: true })}
            >
              {saving ? "Filing…" : "Keep both, file it anyway"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <DuplicateSummaryLine findings={findings} />
          <DuplicateFindings findings={findings} />
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={Boolean(file)}
      onClose={onClose}
      title="Move to another folder"
      width="max-w-md"
      footer={
        <>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={() => move()} disabled={saving || loading || subjectId === currentSubjectId}>
            {saving ? "Moving…" : "Move"}
          </button>
        </>
      }
    >
      {!file ? null : loading ? (
        <PageSpinner />
      ) : (
        <div className="space-y-3">
          <p className="flex items-start gap-1.5 text-sm text-base-300">
            <FolderInput size={14} className="mt-0.5 shrink-0 text-base-400" />
            <span className="truncate">{file.filename_current || file.display_name}</span>
          </p>

          <div>
            <label className="label mb-1.5 block" htmlFor="move-filter">Find a folder</label>
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-base-500" aria-hidden="true" />
              <input
                id="move-filter"
                className="input pl-8"
                placeholder="Type to narrow the list…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="label mb-1.5 block" htmlFor="move-subject">Folder</label>
            <select
              id="move-subject"
              className="input"
              size={Math.min(Math.max(options.length + 1, 4), 10)}
              value={subjectId}
              onChange={(e) => setSubjectId(e.target.value)}
            >
              <option value="">— None —</option>
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
