"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useAuth } from "@/lib/auth-context";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export default function OnboardingPage() {
  const { refresh } = useAuth();
  const router = useRouter();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    await fetch(`${API_URL}/users/me`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    await refresh();
    router.push("/dashboard");
    setSubmitting(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="font-display text-2xl text-ink">Welcome to WealthOS AI</p>
          <p className="mt-1 text-sm text-ink-soft">Let&apos;s set up your profile. This takes under a minute.</p>
        </div>
        <Card>
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label htmlFor="name" className="mb-1 block text-xs uppercase tracking-wide text-ink-faint">
                Your name
              </label>
              <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Aarav Sharma" />
            </div>
            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? "Saving…" : "Continue to dashboard"}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
