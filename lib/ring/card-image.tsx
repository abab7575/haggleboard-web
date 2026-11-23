import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { money } from "./words.js";

/**
 * The brag card as a real 1200x630 PNG, with the brand faces embedded (public/fonts, TTF). The
 * same layout as components/brand/brag-card.tsx.
 */

export type CardInput = {
  lot: number | string;
  label?: string;
  claim: string;
  store: string;
  finalCents: number;
  trail: number[];
  foot: string[];
};

let fonts: Promise<Array<{ name: string; data: Buffer; weight: 400 | 500 | 800; style: "normal" }>> | null = null;

function loadFonts() {
  if (!fonts) {
    const dir = path.join(process.cwd(), "public", "fonts");
    fonts = Promise.all([
      readFile(path.join(dir, "Ultra-Regular.ttf")).then((data) => ({ name: "Ultra", data, weight: 400 as const, style: "normal" as const })),
      readFile(path.join(dir, "SchibstedGrotesk-ExtraBold.ttf")).then((data) => ({ name: "Schibsted", data, weight: 800 as const, style: "normal" as const })),
      readFile(path.join(dir, "SplineSansMono-Bold.ttf")).then((data) => ({ name: "Spline", data, weight: 500 as const, style: "normal" as const })),
    ]);
  }
  return fonts;
}

const PINK = "#FF6AB0";
const NAVY = "#12136B";

export async function cardImage(input: CardInput, opts: { download?: string } = {}): Promise<Response> {
  const image = new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: PINK, color: "#000", position: "relative", fontFamily: "Schibsted" }}>
        <div style={{ position: "absolute", left: 66, top: 56, right: 66, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div style={{ width: 26, height: 25, borderRadius: 13, background: "#fff" }} />
              <div style={{ width: 5, height: 18, background: "#000", borderRadius: 2 }} />
            </div>
            <div style={{ fontFamily: "Ultra", fontSize: 30 }}>HaggleBoard</div>
          </div>
          <div style={{ fontSize: 23, fontWeight: 800 }}>{input.label ?? `Practice ring, lot ${input.lot}`}</div>
        </div>

        <div style={{ position: "absolute", left: 66, top: 196, width: 760, display: "flex", fontFamily: "Ultra", fontSize: 74, lineHeight: 0.98, letterSpacing: -1.5 }}>
          {input.claim}
        </div>

        <div style={{ position: "absolute", left: 66, top: 448, display: "flex", background: "#000", color: "#fff", fontFamily: "Ultra", fontSize: 42, padding: "10px 24px 16px", borderRadius: 12, transform: "rotate(-2deg)" }}>
          Beat that.
        </div>

        <div style={{ position: "absolute", left: 420, top: 458, display: "flex", gap: 30, fontFamily: "Ultra", fontSize: 48, color: "rgba(0,0,0,.55)" }}>
          {input.trail.map((cents) => (
            <div key={cents} style={{ display: "flex", position: "relative" }}>
              {money(cents)}
              <div style={{ position: "absolute", left: -6, right: -6, top: 30, height: 8, background: "#000", borderRadius: 4, transform: "rotate(-8deg)" }} />
            </div>
          ))}
        </div>

        <div style={{ position: "absolute", left: 66, top: 548, display: "flex", flexDirection: "column", fontFamily: "Spline", fontSize: 21, lineHeight: 1.3 }}>
          {input.foot.map((line, i) => (
            <div key={i} style={{ display: "flex" }}>
              {line}
            </div>
          ))}
        </div>

        <div style={{ position: "absolute", right: 70, top: 96, width: 264, display: "flex", flexDirection: "column", alignItems: "center", transform: "rotate(5deg)" }}>
          <div style={{ width: 264, height: 288, background: "#fff", borderRadius: 124, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", boxShadow: "0 24px 36px rgba(80,0,40,.25)" }}>
            <div style={{ fontFamily: "Ultra", fontSize: input.finalCents % 100 ? 84 : 108, letterSpacing: -3, display: "flex" }}>{money(input.finalCents)}</div>
            <div style={{ fontSize: 22, fontWeight: 800, display: "flex" }}>{input.store}</div>
          </div>
          <div style={{ width: 14, height: 110, background: NAVY, marginTop: -8 }} />
          <div style={{ width: 70, height: 90, background: "#E9B896", borderRadius: 24, marginTop: -40, display: "flex" }} />
          <div style={{ width: 70, height: 26, background: "#fff", borderRadius: 5, marginTop: -6, display: "flex" }} />
          <div style={{ width: 96, height: 80, background: "#3B3E86", display: "flex" }} />
        </div>
      </div>
    ),
    { width: 1200, height: 630, fonts: await loadFonts() },
  );
  if (!opts.download) return image;
  const headers = new Headers(image.headers);
  headers.set("content-disposition", `attachment; filename="${opts.download}"`);
  return new Response(image.body, { status: 200, headers });
}
