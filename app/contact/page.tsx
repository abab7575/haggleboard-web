import type { Metadata } from "next";
import { CONTACT_EMAIL } from "../../lib/copy";

export const metadata: Metadata = { title: "Contact" };

export default function ContactPage() {
  return (
    <main>
      <section className="page-head">
        <h1>Talk to the clerk.</h1>
        <p className="lede">
          Questions, corrections, a store that wants in or out, or a post that shouldn&apos;t be here: email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
        <p className="meta">There&apos;s no contact form. Email is the one way in, and a person reads it.</p>
      </section>
    </main>
  );
}
