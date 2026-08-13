import { useState, useEffect } from "react";
import { FolderInput } from "lucide-react";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";
import { Modal } from "./Modal";
import { PageSpinner } from "./Spinner";
import { useToast } from "../context/ToastContext";

/**
 * Focused "move this file to a different subject" action, separate from
 * the full Edit modal so moving between subjects (the thing the Subjects
 * page is organized around) is a one-click, unambiguous action rather than
 * one field buried in a bigger rename/reclassify form.
 *
 * Under the hood this is the same PATCH /files/:id {subjectId} call
 * EditFileModal makes -- reassigning a subject has never physically moved
 * the file on disk (see fileService.updateFile), it records a new manual
 * classification. documentTypeId is resent unchanged so moving subjects
 * doesn't silently clear an existing document-type classification.
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

  const currentSubjectId = detail?.latestClassification?.classified_subject_id || "";

  useEffect(() => {
    setSubjectId(currentSubjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id, currentSubjectId]);

  async function move() {
    if (subjectId === currentSubjectId) { onClose(); return; }
    setSaving(true);
    try {
      await api.patch(`/files/${file.id}`, {
        subjectId: subjectId || null,
        documentTypeId: detail?.latestClassification?.classified_document_type_id || null,
      });
      onMoved();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setSaving(false);
    }
  }

  const loading = loadingDetail || loadingSubjects;

  return (
    <Modal
      open={Boolean(file)}
      onClose={onClose}
      title="Move to another subject"
      width="max-w-sm"
      footer={
        <>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={move} disabled={saving || loading || subjectId === currentSubjectId}>
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
            <label className="label mb-1.5 block">New subject</label>
            <select className="input" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
              <option value="">— None —</option>
              {(subjects || []).map((s) => (
                <option key={s.id} value={s.id}>{s.materialized_path || s.name}</option>
              ))}
            </select>
          </div>
        </div>
      )}
    </Modal>
  );
}
