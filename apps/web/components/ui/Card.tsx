import { ReactNode } from "react";

export function Card({
  children,
  className = "",
  title,
  eyebrow,
  action,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  eyebrow?: string;
  action?: ReactNode;
}) {
  return (
    <div className={`rounded-sm border border-line bg-surface p-5 shadow-sm ${className}`}>
      {(title || eyebrow || action) && (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            {eyebrow && <p className="mb-1 text-xs uppercase tracking-wide text-ink-faint">{eyebrow}</p>}
            {title && <h3 className="font-display text-lg text-ink">{title}</h3>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
