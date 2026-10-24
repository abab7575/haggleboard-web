import type { ReactNode } from "react";
import { DISCLAIMER, PRICE_NOTE, REMOVAL_EMAIL, REMOVAL_LINE, SNAPSHOT_NOTE } from "../lib/copy";

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
          {REMOVAL_LINE.split(REMOVAL_EMAIL)[0]}
          <a href={`mailto:${REMOVAL_EMAIL}`}>{REMOVAL_EMAIL}</a>
        </p>
      </footer>
    </div>
  );
}
