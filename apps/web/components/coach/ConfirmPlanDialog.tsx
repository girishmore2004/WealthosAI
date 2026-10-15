"use client";

import { useState } from "react";
import type { CoachExecutionActionDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

/**
 * Shows exactly what will be created and only writes after an explicit click on "Confirm". The request body is the
 * proposal's own payload from the server; nothing is created by asking the question.
 */
export function ConfirmPlanDialog({ action, onClose, onCreated }: { action: CoachExecutionActionDTO | null; onClose: () => void; onCreated: (message: string) => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (saving) return;
    setError(null);
    onClose();
  };

  const confirm = async () => {
    if (!action?.payload || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.coach2.createPlan(action.payload);
      onCreated(result.alreadyExisted ? "This plan already exists, so nothing new was created." : "Plan created. You can track it from your plans and tasks.");
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the plan. Nothing was saved. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={action !== null} onClose={close} title="Create this plan?">
      {action && (
        <div className="space-y-4">
          <p className="text-sm text-ink-soft">{action.description}</p>
          {action.preview && (
            <div className="rounded-md border border-line bg-surface-muted p-3">
              <p className="text-sm font-medium text-ink">{action.preview.title}</p>
              <dl className="mt-2 space-y-1 text-sm">
                {action.preview.changes.map((c) => (
                  <div key={c.label} className="flex justify-between gap-4">
                    <dt className="text-ink-faint">{c.label}</dt>
                    <dd className="text-right text-ink">{c.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-loss">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={confirm} disabled={saving}>
              {saving ? "Creating…" : "Confirm"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
