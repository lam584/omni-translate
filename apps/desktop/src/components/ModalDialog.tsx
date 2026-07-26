import { useEffect, type MouseEvent, type ReactNode } from 'react';

type ModalDialogProps = {
  onClose: () => void;
  children: ReactNode;
  'aria-label'?: string;
  /** Extra classes applied to the dialog panel (the element that stops backdrop propagation). */
  className?: string;
  /** Opt-in Escape-to-close. Defaults to false so migrated dialogs keep their original behavior. */
  closeOnEscape?: boolean;
  /** Appends a `modal-backdrop--<variant>` modifier class to the shared `modal-backdrop` base class. */
  variant?: string;
};

function stopBackdropPropagation(event: MouseEvent<HTMLDivElement>) {
  event.stopPropagation();
}

export default function ModalDialog({
  onClose,
  children,
  'aria-label': ariaLabel,
  className,
  closeOnEscape = false,
  variant,
}: ModalDialogProps) {
  useEffect(() => {
    if (!closeOnEscape) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeOnEscape, onClose]);

  const backdropClassName = ['modal-backdrop', variant ? `modal-backdrop--${variant}` : ''].filter(Boolean).join(' ');
  return (
    <div className={backdropClassName} onClick={onClose} role="presentation">
      <div
        aria-label={ariaLabel}
        aria-modal="true"
        className={className}
        onClick={stopBackdropPropagation}
        role="dialog"
      >
        {children}
      </div>
    </div>
  );
}
