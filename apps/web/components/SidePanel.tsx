import { useEffect } from "react";

/**
 * Slide-out panel from the right, Azure-portal "blade" style — per Adam's
 * ask ("pop up form or a form that opens from the right") for the Deploy >
 * Template flow. A right-side blade fits this product's Azure-portal-
 * adjacent feel better than a centered modal, and doesn't fully obscure
 * the page behind it (a dimmed overlay is still used to focus attention
 * and allow click-outside-to-close, matching standard blade/drawer UX).
 */
export default function SidePanel({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  // Escape key closes the panel, matching Azure portal blade behavior.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="side-panel-overlay" onClick={onClose}>
      <div className="side-panel" onClick={(e) => e.stopPropagation()}>
        <div className="side-panel-header">
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="secondary side-panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="side-panel-body">{children}</div>
      </div>
    </div>
  );
}
