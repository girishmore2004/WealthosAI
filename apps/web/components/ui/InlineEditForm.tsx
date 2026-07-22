"use client";

import { FormEvent, useState } from "react";
import { Button } from "./Button";
import { Input } from "./Input";

export interface EditField {
  key: string;
  label: string;
  type?: "text" | "number" | "date" | "select" | "checkbox";
  options?: { value: string; label: string }[];
  money?: boolean;
}

interface InlineEditFormProps {
  fields: EditField[];
  // All values are strings (or boolean for checkboxes) — the raw, uncoerced form
  // state. The caller converts to numbers/booleans as needed when building the PATCH
  // payload, exactly like every "Add" form in this app already does with parseFloat.
  initialValues: Record<string, string | boolean>;
  onSave: (values: Record<string, string | boolean>) => Promise<void>;
  onCancel: () => void;
}

export function InlineEditForm({ fields, initialValues, onSave, onCancel }: InlineEditFormProps) {
  const [values, setValues] = useState<Record<string, string | boolean>>(initialValues);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setField = (key: string, value: string | boolean) => setValues((prev) => ({ ...prev, [key]: value }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave(values);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save changes.");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="rounded-sm border border-marigold-500 bg-paper p-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((field) => {
          const value = values[field.key];
          if (field.type === "select" && field.options) {
            return (
              <select
                key={field.key}
                value={typeof value === "string" ? value : ""}
                onChange={(e) => setField(field.key, e.target.value)}
                className="rounded-sm border border-line bg-surface px-3 py-2 text-sm"
              >
                {field.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            );
          }
          if (field.type === "checkbox") {
            return (
              <label key={field.key} className="flex items-center gap-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  checked={typeof value === "boolean" ? value : false}
                  onChange={(e) => setField(field.key, e.target.checked)}
                  className="h-4 w-4 accent-marigold-500"
                />
                {field.label}
              </label>
            );
          }
          return (
            <Input
              key={field.key}
              type={field.type ?? "text"}
              placeholder={field.label}
              value={typeof value === "string" ? value : ""}
              onChange={(e) => setField(field.key, e.target.value)}
              className={field.money ? "money" : ""}
            />
          );
        })}
      </div>
      {error && <p className="mt-2 text-sm text-loss">{error}</p>}
      <div className="mt-3 flex gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
