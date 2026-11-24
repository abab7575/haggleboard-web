import { money } from "../../lib/ring/words";
import { MarkIcon } from "./mark";

/**
 * The brag card. Same layout as the downloadable image (app/ring/[id]/card): pink, the claim in
 * Ultra, "Beat that.", the prices it took to get there crossed out, the winning paddle held up.
 */
export function BragCard({
  lot,
  claim,
  store,
  finalCents,
  trail,
  foot,
  label,
}: {
  lot: number | string;
  claim: string;
  store: string;
  finalCents: number;
  trail: number[];
  foot: string[];
  /** Overrides the top-right line, for sample cards. */
  label?: string;
}) {
  return (
    <figure className="card" aria-label={`Result card: ${claim} Beat that. ${foot.join(". ")}`}>
      <div className="in" aria-hidden="true">
        <div className="meta">
          <span className="m">
            <MarkIcon head="#fff" handle="#000" />
            HaggleBoard
          </span>
          <span>{label ?? `Practice ring, lot ${lot}`}</span>
        </div>
        <p className="claim">{claim}</p>
        <div className="beatrow">
          <span className="beat">Beat that.</span>
        <div className="trail">
          {trail.map((cents) => (
            <s key={cents}>{money(cents)}</s>
          ))}
          </div>
        </div>
        <div className="cp">
          <div className="ph">
            <b>{money(finalCents)}</b>
            <span>{store}</span>
          </div>
          <svg viewBox="0 0 120 300">
            <rect x="54" y="0" width="12" height="96" rx="3" fill="#12136B" />
            <polygon points="34,150 86,150 98,300 22,300" fill="#3B3E86" />
            <rect x="32" y="138" width="56" height="20" rx="4" fill="#fff" />
            <rect x="36" y="72" width="52" height="70" rx="20" fill="#E9B896" />
            <rect x="78" y="76" width="18" height="15" rx="7.5" fill="#E9B896" />
            <rect x="78" y="92" width="17" height="15" rx="7.5" fill="#E9B896" />
            <rect x="78" y="108" width="17" height="15" rx="7.5" fill="#E9B896" />
            <rect x="76" y="124" width="15" height="13" rx="6.5" fill="#E9B896" />
            <rect x="30" y="70" width="40" height="17" rx="8.5" fill="#E9B896" transform="rotate(-18 50 78)" />
          </svg>
        </div>
        <div className="foot">
          {foot.map((line, i) => (
            <span key={i}>
              {line}
              <br />
            </span>
          ))}
        </div>
      </div>
    </figure>
  );
}
