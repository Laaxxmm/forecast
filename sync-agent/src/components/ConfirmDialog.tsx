interface Props {
  open: boolean;
  title: string;
  body: string | JSX.Element;
  confirmLabel?: string;
  cancelLabel?: string;
  /** When true, the confirm button uses the danger gradient. */
  danger?: boolean;
  /** Disables the confirm button while a parent IPC call is in flight. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * In-app confirm modal — replaces window.confirm() so the dialog can never
 * fall behind the agent window or steal focus. Renders nothing when !open.
 */
export default function ConfirmDialog({
  open, title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  danger = false, busy = false, onConfirm, onCancel,
}: Props) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        <div className="modal-body">{body}</div>
        <div className="modal-actions">
          <button className="modal-btn-cancel" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            className={`modal-btn-confirm ${danger ? 'danger' : ''}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
