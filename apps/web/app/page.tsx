// "use client";

// import { useEffect } from "react";
// import { useRouter } from "next/navigation";
// import { useAuth } from "@/lib/auth-context";

// export default function HomePage() {
//   const { user, loading } = useAuth();
//   const router = useRouter();

//   useEffect(() => {
//     if (loading) return;
//     router.replace(user ? "/dashboard" : "/login");
//   }, [user, loading, router]);

//   return (
//     <div className="flex min-h-screen items-center justify-center">
//       <p className="text-sm text-ink-faint">Loading WealthOS AI…</p>
//     </div>
//   );
// }




"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { Hero } from "@/components/marketing/Hero";
import { ModulesSection } from "@/components/marketing/FeatureSections";
import { HowItWorks } from "@/components/marketing/HowItWorks";
import { AISection } from "@/components/marketing/AISection";
import { TrustSection } from "@/components/marketing/TrustSection";
import { ClosingCta, Footer } from "@/components/marketing/Footer";

export default function HomePage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  // Logged-in visitors skip the marketing page entirely and land on their dashboard.
  useEffect(() => {
    if (!loading && user) {
      router.replace("/dashboard");
    }
  }, [user, loading, router]);

  if (loading || user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-ink-faint">Loading WealthOS AI…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-paper">
      <MarketingNav />
      <main>
        <Hero />
        <ModulesSection />
        <HowItWorks />
        <AISection />
        <TrustSection />
        <ClosingCta />
      </main>
      <Footer />
    </div>
  );
}
