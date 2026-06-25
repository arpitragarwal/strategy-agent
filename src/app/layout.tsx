import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/react";
import TrackPageGeo from "@/components/TrackPageGeo";
import "./globals.css";

export const metadata: Metadata = {
  // Overridable per-deployment via NEXT_PUBLIC_APP_NAME (private sets it); the
  // default keeps the public prototype's title. No company string in shared code.
  title: process.env.NEXT_PUBLIC_APP_NAME || "AI Agent Team For Corporate Strategy",
  description: "An AI powered corporate strategy team",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-zinc-900 antialiased">
        {children}
        <Analytics />
        <TrackPageGeo />
      </body>
    </html>
  );
}
