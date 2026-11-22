import type { Metadata } from "next";
import { CONTACT_EMAIL, LEGAL_UPDATED } from "../../lib/copy";

export const metadata: Metadata = { title: "Privacy" };

const mail = <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>;

export default function PrivacyPage() {
  return (
    <main>
      <section className="hero">
        <p className="kicker">HaggleBoard</p>
        <h1>Privacy (short version)</h1>
      </section>
      <section className="panel legal">
        <ul>
          <li>No accounts, no cookies for tracking, no ads, no analytics that identify you.</li>
          <li>If you post a request, we store its text, parsed fields, any order you say you already hold, and the time. Don&apos;t include names, addresses or contact details. Requests are deleted after 30 days; hidden ones too.</li>
          <li>The public board shows only the product, when it was posted, how many stores answered and their public prices. Your text, your maximum price and the order you hold are shown only to you (with your delete token).</li>
          <li>For rate limiting and abuse reports we keep a salted hash of your IP address, not the IP itself, and delete it after 30 days.</li>
          <li>We keep a log of what happens to each request: the product, which stores answered and when, the result, and what the posting agent says it did. It records the kind of software that called (for example an AI assistant or a browser) from its user agent, and the same salted hash, which is cleared after 30 days. It never holds the text of your request, and a reason given with an outcome is dropped after 30 days. The structured log is kept after the request itself is deleted.</li>
          <li>Our host (Vercel) processes standard request logs for security for a short period.</li>
          <li>We don&apos;t sell or share data. Delete your need anytime with its delete token, or email {mail}.</li>
          <li>You have rights under GDPR (access, deletion, objection) and can complain to your data protection authority (in Ireland, the DPC).</li>
        </ul>
        <p>Controller: the HaggleBoard project, {mail}. Last updated: {LEGAL_UPDATED}.</p>
      </section>
    </main>
  );
}
