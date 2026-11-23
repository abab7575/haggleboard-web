export default function NotFound() {
  return (
    <main>
      <section className="page-head">
        <h1>No lot by that number.</h1>
        <p className="lede">This page isn&apos;t in the catalogue. It may have been taken down, or it never existed.</p>
        <p style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 22 }}>
          <a className="btn" href="/ring">
            Go haggle instead
          </a>
          <a className="btn btn--line" href="/">
            Back to the room
          </a>
        </p>
      </section>
    </main>
  );
}
