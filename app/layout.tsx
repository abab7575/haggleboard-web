import { Fraunces, Outfit } from "next/font/google";
import { Shell } from "../components/shell";
import { rootMetadata } from "../lib/indexing";
import "./globals.css";

const display = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const sans = Outfit({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata = rootMetadata();

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${sans.variable}`}>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
