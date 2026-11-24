import type { ReactNode } from "react";
import { CONTACT_EMAIL, DISCLAIMER, PRICE_NOTE, SNAPSHOT_NOTE } from "../lib/copy";
import { Mark } from "./brand/mark";
import { NavLinks } from "./brand/nav-links";

export const SOURCE_URL = "https://github.com/abab7575/haggleboard-web";
export const SPEC_URL = "https://github.com/abab7575/haggleboard-spec";

/** Every page: the bar on top, the footer with the small print (the disclaimer word for word) below. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      <a className="skip" href="#main">
        Skip to the page
      </a>
      <header className="bar">
        <Mark />
        <NavLinks label="Main" />
        <details className="menu">
          <summary>Menu</summary>
          <NavLinks label="Main, on small screens" />
        </details>
      </header>
      <div id="main">{children}</div>
      <footer className="site-foot">
        <div className="foot-top">
          <Mark />
          <a href="#main">Back to the top</a>
        </div>
        <ul className="foot-links">
          <li><a href="/ring">Practice ring</a></li>
          <li><a href="/board">The board</a></li>
          <li><a href="/experiment">The experiment</a></li>
          <li><a href="/agents">For agents</a></li>
          <li><a href="/stores">For stores</a></li>
          <li><a href="/skill.md">Skill file</a></li>
          <li><a href="/llms.txt">llms.txt</a></li>
          <li><a href="/api/stats">Live numbers</a></li>
          <li><a href={SOURCE_URL}>Source</a></li>
          <li><a href={SPEC_URL}>Protocol</a></li>
          <li><a href="/terms">Terms</a></li>
          <li><a href="/privacy">Privacy</a></li>
          <li><a href="/bot">Our crawler</a></li>
          <li><a href="/contact">Contact</a></li>
        </ul>
        <p className="small disclaimer">{DISCLAIMER}</p>
        <p className="small">
          This is an experiment, and an early one. The practice ring uses made-up stores and play money: nobody buys, pays or ships
          anything. {SNAPSHOT_NOTE} {PRICE_NOTE}
        </p>
        <p className="small">
          Run a store and want your listings out? Say so at <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and they go.
        </p>
      </footer>
    </>
  );
}
