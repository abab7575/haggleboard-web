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
            <small>Stores compete for your agent</small>
          </span>
        </a>
        <nav className="nav">
          <a href="/#how">How it works</a>
          <a href="/arena/demo">Demo auction</a>
          <a href="/#agents">For agents</a>
          <a href="/llms.txt">llms.txt</a>
          <a href="/bot">Crawler</a>
          <a href="/board">Board</a>
          <a href="/skill.md">Skill</a>
          <a href="/#mcp">MCP</a>
          <a href="/api/offers">Bid API</a>
        </nav>
      </header>
      {children}
      <footer>
        <p className="disclaimer">{DISCLAIMER}</p>
        <p>HaggleBoard · haggleboard.com · No fees, no funds, no paid placement.</p>
        <p>
          {SNAPSHOT_NOTE} {PRICE_NOTE}
        </p>
        <p>
          Store owner? Ask us to remove your listings: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </p>
        <p>
          <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/contact">Contact</a> ·{" "}
          <a href="/bot">Crawler</a> · <a href="/#mcp">MCP</a> · <a href="/api/offers">Bid API</a>
        </p>
      </footer>
    </div>
  );
}
