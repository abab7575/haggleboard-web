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
          <li>If you post a need, we store its text, parsed fields and time. Don&apos;t include names, addresses or contact details. Need text is deleted after 30 days; hidden needs too.</li>
          <li>For rate limiting and abuse reports we keep a salted hash of your IP address, not the IP itself, and delete it after 30 days.</li>
          <li>Our host (Vercel) processes standard request logs for security for a short period.</li>
          <li>We don&apos;t sell or share data. Delete your need anytime with its delete token, or email {mail}.</li>
          <li>You have rights under GDPR (access, deletion, objection) and can complain to your data protection authority (in Ireland, the DPC).</li>
        </ul>
        <p>Controller: the HaggleBoard project, {mail}. Last updated: {LEGAL_UPDATED}.</p>
      </section>
    </main>
  );
}
