/** The mark: one paddle, raised. Pink head, white handle. */
export function MarkIcon({ head = "#FF6AB0", handle = "#FFFFFF" }: { head?: string; handle?: string }) {
  return (
    <svg viewBox="0 0 22 34" aria-hidden="true">
      <ellipse cx="11" cy="10" rx="10.5" ry="10" fill={head} />
      <rect x="9" y="18" width="4" height="16" rx="1.5" fill={handle} />
    </svg>
  );
}

export function Mark({ href = "/", label = "HaggleBoard, home" }: { href?: string; label?: string }) {
  return (
    <a className="mark" href={href} aria-label={label}>
      <MarkIcon />
      HaggleBoard
    </a>
  );
}
