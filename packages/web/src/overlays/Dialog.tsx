import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), audio[controls], video[controls], [tabindex]:not([tabindex="-1"])';

/** Focusable descendants of `root`, in tab order. */
function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('inert'));
}

/** Props for {@link Dialog}. */
export interface DialogProps {
  /** Visible title, also the dialog's accessible name. Plain text only. */
  title: ReactNode;
  /** Header content after the title (controls, status). */
  actions?: ReactNode;
  /** Called on Esc, the close button, or a click on the backdrop. */
  onClose: () => void;
  /** Extra class on the panel, for layout variants. */
  className?: string;
  /** Accessible label of the close button. */
  closeLabel?: string;
  children: ReactNode;
}

/**
 * A modal overlay panel with a focus trap: focus moves into it on open,
 * Tab and Shift+Tab cycle inside it, Esc closes it, and focus returns to
 * where it was on close. Nested dialogs (a lightbox) stop Esc from reaching
 * the outer one.
 */
export function Dialog({ title, actions, onClose, className, closeLabel = 'Close', children }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus();
    return () => {
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      onCloseRef.current();
      return;
    }
    if (e.key !== 'Tab' || !panelRef.current) return;
    // A nested dialog keeps Tab to itself; the outer trap must not see it.
    e.stopPropagation();
    const list = focusables(panelRef.current);
    if (list.length === 0) {
      e.preventDefault();
      panelRef.current.focus();
      return;
    }
    const first = list[0] as HTMLElement;
    const last = list[list.length - 1] as HTMLElement;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="overlay-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={panelRef}
        className={className ? `overlay ${className}` : 'overlay'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="overlay-header">
          <h2 id={titleId} className="overlay-title">
            {title}
          </h2>
          {actions}
          <button type="button" className="button icon-button" aria-label={closeLabel} onClick={() => onCloseRef.current()}>
            <span aria-hidden="true">×</span>
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
