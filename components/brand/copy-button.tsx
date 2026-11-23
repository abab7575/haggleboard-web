"use client";

import { useEffect, useRef, useState } from "react";

/** Copies text, says "Copied" for a moment, and tells screen readers. Works without the clipboard API too. */
export function CopyButton({ text, label = "Copy", done = "Copied", className = "btn copy" }: { text: string; label?: string; done?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const ok = () => {
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  };
  const fallback = () => {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
    } catch {
      // nothing more we can do; the text is on screen to copy by hand
    }
    document.body.removeChild(area);
    ok();
  };
  const onClick = () => {
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
  };
  return (
    <>
      <button className={className} type="button" onClick={onClick} {...(copied ? { "data-done": "" } : {})}>
        {copied ? done : label}
      </button>
      <span className="sr" aria-live="polite">
        {copied ? done : ""}
      </span>
    </>
  );
}
