/** Visible label on anything that renders scripted or invented data. */
export function DemoLabel({ text = "Demo · made-up stores and numbers" }: { text?: string }) {
  return (
    <span className="demo-label" data-demo-label="">
      <svg viewBox="0 0 12 12" aria-hidden="true" width="12" height="12">
        <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 1.6" />
      </svg>
      {text}
    </span>
  );
}
