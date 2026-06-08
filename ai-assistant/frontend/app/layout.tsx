// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Assistant",
  description: "A full-stack OpenAI chatbot built with Next.js and FastAPI.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
