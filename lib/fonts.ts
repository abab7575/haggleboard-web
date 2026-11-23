import localFont from "next/font/local";

/**
 * The brand's faces, self-hosted from public/fonts (the same files the brag-card image embeds).
 * Ultra: the auctioneer. Schibsted Grotesk: everything you read or press. Spline Sans Mono: only
 * things you paste or parse. Licences sit next to the files.
 */
export const ultra = localFont({
  src: "../public/fonts/Ultra-Regular.ttf",
  weight: "400",
  variable: "--font-ultra",
  display: "swap",
  fallback: ["Rockwell Extra Bold", "Georgia", "serif"],
});

export const schibsted = localFont({
  src: [
    { path: "../public/fonts/SchibstedGrotesk-Regular.ttf", weight: "400" },
    { path: "../public/fonts/SchibstedGrotesk-Medium.ttf", weight: "500" },
    { path: "../public/fonts/SchibstedGrotesk-Bold.ttf", weight: "700" },
    { path: "../public/fonts/SchibstedGrotesk-ExtraBold.ttf", weight: "800" },
  ],
  variable: "--font-schibsted",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});

export const splineMono = localFont({
  src: [
    { path: "../public/fonts/SplineSansMono-Medium.ttf", weight: "500" },
    { path: "../public/fonts/SplineSansMono-Bold.ttf", weight: "700" },
  ],
  variable: "--font-spline-mono",
  display: "swap",
  fallback: ["ui-monospace", "monospace"],
});
