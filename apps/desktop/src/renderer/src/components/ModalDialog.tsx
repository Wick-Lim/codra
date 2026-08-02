import React from "react";
import { createPortal } from "react-dom";

export interface ModalDialogProps {
  open: boolean;
  title: string;
  description?: string;
  className?: string;
  onClose(): void;
  children: React.ReactNode;
}

export function ModalDialog({
  open,
  title,
  description,
  className = "",
  onClose,
  children,
}: ModalDialogProps) {
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const closeRef = React.useRef(onClose);
  const titleId = React.useId();
  const descriptionId = React.useId();

  closeRef.current = onClose;

  React.useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }

    const firstControl = dialog.querySelector<HTMLElement>(
      "button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex='-1'])",
    );
    firstControl?.focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      opener?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <dialog
      ref={dialogRef}
      className={`modal-dialog ${className}`.trim()}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="modal-surface">
        <header className="modal-header">
          <div>
            <p className="modal-eyebrow">CODRA CONTROL</p>
            <h2 id={titleId}>{title}</h2>
            {description ? (
              <p className="modal-description" id={descriptionId}>
                {description}
              </p>
            ) : null}
          </div>
          <button
            className="icon-button modal-close-button"
            type="button"
            aria-label={`Close ${title}`}
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </dialog>,
    document.body,
  );
}
