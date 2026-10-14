"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { api, ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();
  const { refresh } = useAuth();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = (await api.auth.requestOtp(email)) as { otpRequired?: boolean };
      if (res.otpRequired === false) {
        // Demo account: the API skips the OTP, so sign straight in (any 6 digits are accepted).
        await api.auth.verifyOtp(email, "000000");
        await refresh();
        router.push("/dashboard");
        return;
      }
      router.push(`/login/verify?email=${encodeURIComponent(email)}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="font-display text-2xl text-ink">WealthOS AI</p>
          <p className="mt-1 text-sm text-ink-faint">Understand, grow, and protect your money.</p>
        </div>
        <Card>
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="mb-1 block text-xs uppercase tracking-wide text-ink-faint">
                Email
              </label>
              <Input
                id="email"
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-loss">{error}</p>}
            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? "Sending code…" : "Send login code"}
            </Button>
          </form>
        </Card>
        <p className="mt-4 text-center text-xs text-ink-faint">
          No password needed — we&apos;ll email a 6-digit code. Demo login (no code needed): demo@wealthos.ai
        </p>
      </div>
    </div>
  );
}
