"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { UserSettingsDTO, DigestFrequency, Theme, AppLanguage } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/lib/auth-context";

const DIGESTS: DigestFrequency[] = ["DAILY", "WEEKLY", "OFF"];
const THEMES: Theme[] = ["LIGHT", "DARK", "SYSTEM"];
const LANGUAGES: { value: AppLanguage; label: string }[] = [
  { value: "EN", label: "English" },
  { value: "HI", label: "हिन्दी (Hindi)" },
  { value: "MR", label: "मराठी (Marathi)" },
];

export default function SettingsPage() {
  const { logout } = useAuth();
  const router = useRouter();
  const [settings, setSettings] = useState<UserSettingsDTO | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    api.settings
      .get()
      .then(setSettings)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load settings."));
  }, []);

  const save = async (patch: Partial<UserSettingsDTO>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    setSaving(true);
    try {
      await api.settings.update(patch);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this preference.");
    } finally {
      setSaving(false);
    }
  };

  const onExport = async () => {
    setExporting(true);
    try {
      const data = await api.users.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "wealthos-data-export.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not export your data.");
    } finally {
      setExporting(false);
    }
  };

  const onDelete = async () => {
    setDeleting(true);
    try {
      await api.users.deleteAccount();
      await logout();
      router.push("/login");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete your account.");
      setDeleting(false);
    }
  };

  if (!settings) {
    return <p className="text-sm text-ink-faint">Loading settings…</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Settings</h1>
        <p className="text-sm text-ink-soft">Notifications, privacy, appearance, and account controls.</p>
      </div>

      {error && <p className="text-sm text-loss">{error}</p>}

      <Card title="Notifications">
        <div className="flex items-center justify-between py-2">
          <div>
            <p className="text-sm text-ink">Email notifications</p>
            <p className="text-xs text-ink-faint">Alerts about renewals, EMIs, and goal progress.</p>
          </div>
          <input
            type="checkbox"
            checked={settings.notifyEmail}
            onChange={(e) => save({ notifyEmail: e.target.checked })}
            className="h-4 w-4 accent-marigold-500"
          />
        </div>
        <div className="ledger-rule flex items-center justify-between py-2 pt-3">
          <p className="text-sm text-ink">Digest frequency</p>
          <select
            value={settings.digestFrequency}
            onChange={(e) => save({ digestFrequency: e.target.value as DigestFrequency })}
            className="rounded-sm border border-line bg-surface px-3 py-1.5 text-sm"
          >
            {DIGESTS.map((d) => (
              <option key={d} value={d}>
                {d.charAt(0) + d.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
        </div>
      </Card>

      <Card title="Appearance & language">
        <div className="flex items-center justify-between py-2">
          <p className="text-sm text-ink">Theme</p>
          <select
            value={settings.theme}
            onChange={(e) => save({ theme: e.target.value as Theme })}
            className="rounded-sm border border-line bg-surface px-3 py-1.5 text-sm"
          >
            {THEMES.map((t) => (
              <option key={t} value={t}>
                {t.charAt(0) + t.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        <div className="ledger-rule flex items-center justify-between py-2 pt-3">
          <p className="text-sm text-ink">Language</p>
          <select
            value={settings.language}
            onChange={(e) => save({ language: e.target.value as AppLanguage })}
            className="rounded-sm border border-line bg-surface px-3 py-1.5 text-sm"
          >
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        {saving && <p className="mt-2 text-xs text-ink-faint">Saving…</p>}
        <p className="mt-3 text-[11px] text-ink-faint">
          Dark theme and Hindi/Marathi translations are stored as a preference here; full theming and translated
          copy across the app are planned for a later pass.
        </p>
      </Card>

      <Card title="Privacy & data">
        <div className="flex items-center justify-between py-2">
          <div>
            <p className="text-sm text-ink">Export your data</p>
            <p className="text-xs text-ink-faint">Download everything WealthOS AI has stored about you as JSON.</p>
          </div>
          <Button variant="secondary" onClick={onExport} disabled={exporting}>
            {exporting ? "Preparing…" : "Export"}
          </Button>
        </div>
        <div className="ledger-rule flex items-center justify-between py-3">
          <div>
            <p className="text-sm text-ink">Delete account</p>
            <p className="text-xs text-ink-faint">Permanently removes your profile and all financial data.</p>
          </div>
          {!confirmDelete ? (
            <Button variant="secondary" onClick={() => setConfirmDelete(true)} className="text-loss">
              Delete
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button onClick={onDelete} disabled={deleting} className="bg-loss hover:bg-loss">
                {deleting ? "Deleting…" : "Confirm delete"}
              </Button>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
