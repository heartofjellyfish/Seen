import type { Metadata, Viewport } from "next";
import { EB_Garamond } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const garamond = EB_Garamond({
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-serif",
});

export const metadata: Metadata = {
  title: "Seen",
  description: "Someone is being seen.",
};

export const viewport: Viewport = {
  themeColor: "#0e0b07",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={garamond.variable}>
      <body>
        <span className="wordmark" aria-hidden>
          seen
        </span>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
