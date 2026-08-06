import { ReactNode } from "react";

export function Card({
  children,
  className = "",
  title,
  eyebrow,
  action,
  hover = false,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  eyebrow?: string;
  action?: ReactNode;
  /** Adds a subtle lift on hover — use for cards that link elsewhere or represent a selectable item. */
  hover?: boolean;
}) {
  return (
    <div className={`panel ${hover ? "panel-hover" : ""} p-5 sm:p-6 ${className}`}>
      {(title || eyebrow || action) && (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            {eyebrow && <p className="stat-label mb-1">{eyebrow}</p>}
            {title && <h3 className="font-display text-lg leading-snug text-ink">{title}</h3>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
