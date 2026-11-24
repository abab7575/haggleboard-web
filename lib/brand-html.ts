import { DISCLAIMER } from "./copy.js";

/**
 * The brand, as one plain HTML response with no scripts: for pages agents open with a bare web
 * fetch (/find, /ring?q=). Same tokens as app/brand.css, fonts from /fonts.
 */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLE = `
@font-face{font-family:Ultra;src:url(/fonts/Ultra-Regular.ttf) format("truetype");font-display:swap}
@font-face{font-family:"Schibsted Grotesk";font-weight:500;src:url(/fonts/SchibstedGrotesk-Medium.ttf) format("truetype");font-display:swap}
@font-face{font-family:"Schibsted Grotesk";font-weight:800;src:url(/fonts/SchibstedGrotesk-ExtraBold.ttf) format("truetype");font-display:swap}
@font-face{font-family:"Spline Sans Mono";font-weight:500;src:url(/fonts/SplineSansMono-Medium.ttf) format("truetype");font-display:swap}
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#2A2BE0;color:#fff;font:500 1.0625rem/1.5 "Schibsted Grotesk",system-ui,sans-serif}
main{max-width:46rem;margin:0 auto;padding:18px 16px 56px}
a{color:#fff;text-decoration-thickness:2px;text-underline-offset:.22em;font-weight:800}
a:focus-visible{outline:3px solid #FF6AB0;outline-offset:3px}
.mark{display:inline-flex;align-items:center;gap:10px;font:400 1.3rem/1 Ultra,serif;text-decoration:none}
h1{font:400 clamp(2.2rem,8vw,3.6rem)/.92 Ultra,serif;letter-spacing:-.02em;margin:28px 0 14px}
h2{font:400 1.5rem/1 Ultra,serif;margin:30px 0 10px}
.tag{display:inline-block;background:#fff;color:#000;font-weight:800;font-size:.86rem;padding:4px 9px 5px;border-radius:3px;transform:rotate(-1.5deg)}
code,pre{font:500 .88rem/1.45 "Spline Sans Mono",ui-monospace,monospace}
code{background:#12136B;padding:2px 6px;border-radius:4px;overflow-wrap:anywhere}
.sheet{background:#12136B;border-radius:12px;padding:10px 14px;list-style:none;margin:0}
.sheet li{display:grid;grid-template-columns:3.4em minmax(0,1fr) auto;gap:2px 10px;padding:6px 0;border-bottom:1px solid rgba(214,216,255,.18)}
.sheet li:last-child{border-bottom:0}
.sheet time,.sheet .w{font:500 .8rem/1.4 "Spline Sans Mono",monospace;color:#C3C5FF}
.sheet .w b{color:#fff}
.sheet .q{grid-column:2/4}
.lead{background:#FF6AB0;color:#000;border-radius:3px;padding:0 5px;font-weight:800}
.paddles{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:10px;padding:0;list-style:none}
.paddles li{background:#fff;color:#000;border-radius:48% 48% 44% 44%/42% 42% 36% 36%;padding:18px 10px;text-align:center}
.paddles li.on{background:#FF6AB0}
.paddles li.out{background:#5C5FE8;color:#fff}
.paddles b{display:block;font:400 2rem/1 Ultra,serif}
.paddles small{font-weight:800}
.next{background:#fff;color:#000;border-radius:10px;padding:12px 14px}
.next a{color:#000}
.next code{background:#E3E4FF;color:#000}
.pale{color:#D6D8FF}
footer{margin-top:48px;color:#D6D8FF;font-size:.84rem}
`;

const MARK = `<svg width="22" height="34" viewBox="0 0 22 34" aria-hidden="true"><ellipse cx="11" cy="10" rx="10.5" ry="10" fill="#FF6AB0"/><rect x="9" y="18" width="4" height="16" rx="1.5" fill="#fff"/></svg>`;

export function brandPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)} · HaggleBoard</title><style>${STYLE}</style></head><body><main><a class="mark" href="/">${MARK}HaggleBoard</a>${body}<footer><p>${esc(DISCLAIMER)}</p></footer></main></body></html>`;
}
