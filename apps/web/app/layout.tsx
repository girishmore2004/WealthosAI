import type { Metadata } from "next";
import { AuthProvider } from "@/lib/auth-context";
import "./globals.css";

export const metadata: Metadata = {
  title: "WealthOS AI — Understand, grow, and protect your money",
  description:
    "A personal wealth operating system for India: daily spending, investments, loans, tax, insurance, goals, and family finance in one place.",
};

// Runs before first paint so the saved (or system) theme and sidebar state apply without a flash.
// Storage access is wrapped in try/catch because it can throw in private windows.
const THEME_INIT_SCRIPT = `(function(){try{var d=document.documentElement;var t=localStorage.getItem('wealthos-theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}d.setAttribute('data-theme',t);if(localStorage.getItem('wealthos-sidebar')==='collapsed'){d.setAttribute('data-sidebar','collapsed');}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-paper font-sans text-ink antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
