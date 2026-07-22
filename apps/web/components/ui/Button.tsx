import { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary";
}

export function Button({ variant = "primary", className = "", ...props }: ButtonProps) {
  const base =
    "rounded-sm px-4 py-2 text-sm font-medium transition-all duration-150 active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100";
  const styles =
    variant === "primary"
      ? "bg-marigold-500 text-white shadow-sm hover:bg-marigold-600 hover:shadow"
      : "border border-line bg-surface text-ink hover:border-ink-faint hover:bg-paper";

  return <button className={`${base} ${styles} ${className}`} {...props} />;
}
