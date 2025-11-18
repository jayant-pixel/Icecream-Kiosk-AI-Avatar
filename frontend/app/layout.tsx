import { ThemeProvider } from "@/components/theme-provider";
import type { Metadata, Viewport } from "next";

import "@livekit/components-styles";
import "@livekit/components-styles/prefabs";
// import "../styles/globals.css";
import "./globals.css"; // for tailwind

export const metadata: Metadata = {
  title: "AI Avatar Agent",
  description: "Immersive LiveKit kiosk powered by the Scoop AI avatar.",
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
      <body className="antialiased" suppressHydrationWarning>
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
