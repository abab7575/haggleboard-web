import { ImageResponse } from "next/og";
import { durationWords } from "../../../lib/arena";
import { FULL_SCRIPT } from "../../../lib/arena-demo";

export const alt = "HaggleBoard demo result: made-up stores, invented numbers";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  const close = FULL_SCRIPT.events.find((e) => e.kind === "close");
  const saved = close && close.kind === "close" ? close.saved_pct : 0;
  const wonAt = close && close.kind === "close" ? close.won_at : 0;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#f3eadc",
          color: "#241910",
          padding: "64px 72px",
          fontSize: 32,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: 64,
                background: "#241910",
                color: "#f3eadc",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 28,
              }}
            >
              Hb
            </div>
            <div style={{ fontSize: 36 }}>HaggleBoard</div>
          </div>
          <div
            style={{
              display: "flex",
              border: "3px dashed #8d3222",
              color: "#8d3222",
              borderRadius: 40,
              padding: "8px 22px",
              fontSize: 26,
            }}
          >
            DEMO · made-up stores
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 28 }}>
          <div style={{ fontSize: 220, lineHeight: 0.9, color: "#1d5c45", letterSpacing: -8 }}>{`${saved}%`}</div>
          <div style={{ display: "flex", flexDirection: "column", fontSize: 40, paddingBottom: 24 }}>
            <div>under the best</div>
            <div>public price</div>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 30, color: "#6d6256" }}>
          <div>{`My agent won it in ${durationWords(wonAt)}.`}</div>
          <div>Stores compete. You buy direct.</div>
        </div>
      </div>
    ),
    size,
  );
}
