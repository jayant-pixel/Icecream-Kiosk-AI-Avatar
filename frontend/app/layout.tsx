import { ThemeProvider } from "@/components/theme-provider";
import type { Metadata, Viewport } from "next";
import {
  Geist,
  Geist_Mono,
  Plus_Jakarta_Sans,
} from "next/font/google";

import "@livekit/components-styles";
import "@livekit/components-styles/prefabs";
// import "../styles/globals.css";
import "./globals.css"; // for tailwind

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const plusJakarta = Plus_Jakarta_Sans({
  variable: "--font-plus-jakarta",
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "LiveKit Meet Agents",
  description: "LiveKit Meet with AI Agents",
};

export const viewport: Viewport = {
  themeColor: "#070707",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${plusJakarta.variable} antialiased`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
