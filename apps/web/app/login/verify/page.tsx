"use client";

import { useState, FormEvent, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { api, ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";

function VerifyForm() {
  const params = useSearchParams();
  const email = params.get("email") ?? "";
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();
  const { refresh } = useAuth();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.auth.verifyOtp(email, code);
      await refresh();
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Invalid code. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="font-display text-2xl text-ink">Enter your code</p>
          <p className="mt-1 text-sm text-ink-faint">
            Sent to {email || "your email"}. In dev, check the API console log.
          </p>
        </div>
        <Card>
          <form onSubmit={onSubmit} className="space-y-4">
            <Input
              inputMode="numeric"
              maxLength={6}
              required
              placeholder="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="money text-center text-lg tracking-[0.3em]"
            />
            {error && <p className="text-sm text-loss">{error}</p>}
            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? "Verifying…" : "Verify and continue"}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense>
      <VerifyForm />
    </Suspense>
  );
}
