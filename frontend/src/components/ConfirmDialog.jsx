import { Modal } from "./Modal";
import { AlertTriangle } from "lucide-react";

export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel = "Confirm", danger = false, loading = false }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width="max-w-sm"
      footer={
        <>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button
            className={danger ? "btn-danger btn-sm" : "btn-primary btn-sm"}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      <div className="flex gap-3">
        {danger && <AlertTriangle size={20} className="mt-0.5 shrink-0 text-rose-400" />}
        <p className="text-sm text-base-300">{description}</p>
      </div>
    </Modal>
  );
}
