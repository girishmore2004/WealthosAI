import { InputHTMLAttributes, forwardRef } from "react";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className = "", ...props }, ref) => (
    <input
      ref={ref}
      className={`w-full rounded-sm border border-line bg-surface px-3 py-2.5 text-sm text-ink placeholder:text-ink-faint transition-colors focus:border-marigold-500 ${className}`}
      {...props}
    />
  ),
);
Input.displayName = "Input";
