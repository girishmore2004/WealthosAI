import { ReactNode } from "react";

type BadgeTone = "info" | "warning" | "critical" | "success";

const TONE_CLASS: Record<BadgeTone, string> = {
  info: "badge-info",
  warning: "badge-warning",
  critical: "badge-critical",
  success: "badge-success",
};

export function Badge({ tone = "info", children }: { tone?: BadgeTone; children: ReactNode}) {
  return <span className={`badge ${TONE_CLASS[tone]}`}>{children}</span>;
}
