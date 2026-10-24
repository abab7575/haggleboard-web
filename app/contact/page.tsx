import type { Metadata } from "next";
import { CONTACT_EMAIL } from "../../lib/copy";

export const metadata: Metadata = { title: "Contact" };

export default function ContactPage() {
  return (
    <main>
      <section className="hero">
        <p className="kicker">HaggleBoard</p>
        <h1>Contact</h1>
        <p className="lede">
          Questions, corrections, removal requests from stores, or reports about a post: email{" "}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
      </section>
      <section className="panel">
        <h2>Contact form coming soon</h2>
        <p className="meta">This form is switched off. It does not store or send anything. Please use email for now.</p>
        <form aria-disabled="true" onSubmit={undefined}>
          <fieldset disabled>
            <label>Your email<input type="email" name="email" /></label>
            <label>Message<textarea name="message" rows={4} /></label>
            <button type="button">Send (coming soon)</button>
          </fieldset>
        </form>
      </section>
    </main>
  );
}
