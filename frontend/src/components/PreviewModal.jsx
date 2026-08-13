import { Modal } from "./Modal";
import { FilePreviewPane } from "./FilePreviewPane";

/** Standalone "just show me the picture" modal, used by the Eye icon. */
export function PreviewModal({ fileId, onClose }) {
  return (
    <Modal open={Boolean(fileId)} onClose={onClose} title="Preview" width="max-w-2xl">
      <FilePreviewPane fileId={fileId} />
    </Modal>
  );
}
