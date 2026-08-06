// "use client";

// import { useEffect } from "react";
// import { useRouter } from "next/navigation";
// import { useAuth } from "@/lib/auth-context";
// import { AppNav } from "@/components/nav/AppNav";

// export default function AppLayout({ children }: { children: React.ReactNode }) {
//   const { user, loading } = useAuth();
//   const router = useRouter();

//   useEffect(() => {
//     if (!loading && !user) router.replace("/login");
//   }, [loading, user, router]);

//   if (loading || !user) {
//     return (
//       <div className="flex min-h-screen items-center justify-center">
//         <p className="text-sm text-ink-faint">Loading…</p>
//       </div>
//     );
//   }

//   return (
//     <div className="min-h-screen">
//       <AppNav />
//       <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
//     </div>
//   );
// }




"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { AppNav } from "@/components/nav/AppNav";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <p className="text-sm text-ink-faint">Loading…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-paper">
      <AppNav />
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">{children}</main>
    </div>
  );
}
