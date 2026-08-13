import { useState, useEffect, useRef } from "react";
import { api } from "../services/apiClient";
import { useApiData } from "../hooks/useApiData";
import { Modal } from "./Modal";
import { FilePreviewPane } from "./FilePreviewPane";
import { Field } from "./Field";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";

/**
 * Rename + reclassify (subject/document type) in one modal. Shared between
 * FilesPage and SubjectsPage -- editing a file looks the same regardless
 * of which tab it was opened from.
 */
export function EditFileModal({ file, onClose, onSaved }) {
  const { hasPermission } = useAuth();
  const { push } = useToast();
  const canRename = hasPermission("document.rename");
  const canReclassify = hasPermission("classification.modify");

  const { data: detail } = useApiData(
    () => (file ? api.get(`/files/${file.id}`) : Promise.resolve(null)),
    [file?.id]
  );
  const { data: subjects } = useApiData(() => (file ? api.get("/subjects") : Promise.resolve(null)), [file?.id]);
  const { data: documentTypes } = useApiData(() => (file ? api.get("/document-types") : Promise.resolve(null)), [file?.id]);

  const [filename, setFilename] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [documentTypeId, setDocumentTypeId] = useState("");
  const [saving, setSaving] = useState(false);

  // Seed the form ONCE per file, when its current values first arrive --
  // detail is fetched after the modal is already open.
  //
  // The dependency was `detail`, the whole object, which is a fresh identity
  // on every fetch. useApiData refetches on window focus, so this re-ran and
  // overwrote the form whenever the tab regained focus: type a new filename,
  // alt-tab to check something, come back, and your typing had been silently
  // reverted to the old name. Keyed on a ref instead of on detail's identity
  // so a background refresh cannot discard work in progress.
  const seededFor = useRef(null);
  useEffect(() => {
    if (!file) {
      seededFor.current = null;
      return;
    }
    if (!detail || seededFor.current === file.id) return;
    seededFor.current = file.id;
    setFilename(file.filename_current || "");
    setSubjectId(detail.latestClassification?.classified_subject_id || "");
    setDocumentTypeId(detail.latestClassification?.classified_document_type_id || "");
  }, [file, detail]);

  async function save() {
    const body = {};
    if (canRename && filename.trim() && filename.trim() !== file.filename_current) body.filename = filename.trim();
    if (canReclassify) {
      const currentSubjectId = detail?.latestClassification?.classified_subject_id || "";
      const currentDocTypeId = detail?.latestClassification?.classified_document_type_id || "";
      if (subjectId !== currentSubjectId || documentTypeId !== currentDocTypeId) {
        body.subjectId = subjectId || null;
        body.documentTypeId = documentTypeId || null;
      }
    }
    if (Object.keys(body).length === 0) { onClose(); return; }

    setSaving(true);
    try {
      await api.patch(`/files/${file.id}`, body);
      onSaved();
    } catch (err) {
      push(err.message, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={Boolean(file)}
      onClose={onClose}
      title="Edit file"
      width="max-w-lg"
      footer={
        <>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </>
      }
    >
      {file && (
        <div className="space-y-4">
          {/* Preview right where the rename decision gets made -- the whole
              point is not having to guess what the file is from its old name. */}
          <FilePreviewPane fileId={file.id} compact />

          {canRename ? (
            <div>
              <label className="label mb-1.5 block">Filename</label>
              <input className="input" value={filename} onChange={(e) => setFilename(e.target.value)} />
              <p className="mt-1 text-xs text-base-500">Renames in place — doesn't move the file to a different folder.</p>
            </div>
          ) : (
            <Field label="Filename">{file.filename_current}</Field>
          )}

          {canReclassify ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label mb-1.5 block">Subject</label>
                <select className="input" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                  <option value="">— None —</option>
                  {(subjects || []).map((s) => (
                    <option key={s.id} value={s.id}>{s.materialized_path || s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label mb-1.5 block">Document type</label>
                <select className="input" value={documentTypeId} onChange={(e) => setDocumentTypeId(e.target.value)}>
                  <option value="">— None —</option>
                  {(documentTypes || []).map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
