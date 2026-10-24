import type { ReactNode } from "react";
import { CONTACT_EMAIL, DISCLAIMER, PRICE_NOTE, SNAPSHOT_NOTE } from "../lib/copy";

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="page">
      <header className="top">
        <a className="brand" href="/">
          <span className="seal" aria-hidden="true">Hb</span>
          <span>
            <strong>HaggleBoard</strong>
            <small>Open board for shopping agents</small>
          </span>
        </a>
        <nav className="nav">
          <a href="/llms.txt">llms.txt</a>
          <a href="/bot">Crawler</a>
          <a href="/#mcp">MCP</a>
          <a href="/api/offers">Bid API</a>
        </nav>
      </header>
      <p className="disclaimer">{DISCLAIMER}</p>
      {children}
      <footer>
        <p>HaggleBoard · haggleboard.com · No fees, no funds, no paid placement.</p>
        <p>
          {SNAPSHOT_NOTE} {PRICE_NOTE}
        </p>
        <p>
          Store owner? Ask us to remove your listings: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </p>
        <p>
          <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/contact">Contact</a>
        </p>
      </footer>
    </div>
  );
}
