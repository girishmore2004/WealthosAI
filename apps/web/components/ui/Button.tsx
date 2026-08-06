import { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
}

export function Button({ variant = "primary", size = "md", className = "", ...props }: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-all duration-150 active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100 disabled:cursor-not-allowed";

  const sizes = size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2.5 text-sm";

  const styles =
    variant === "primary"
      ? "bg-marigold-500 text-white shadow-card hover:bg-marigold-600 hover:shadow-card-hover"
      : variant === "secondary"
        ? "border border-line bg-surface text-ink hover:border-ink-faint hover:bg-surface-muted"
        : "text-ink-soft hover:bg-surface-muted hover:text-ink";

  return <button className={`${base} ${sizes} ${styles} ${className}`} {...props} />;
}
