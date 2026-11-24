"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { PasteLine } from "../../lib/paste-lines";
import { CopyButton } from "./copy-button";

/** Send your agent: tabs (arrow keys move between them) and a copy button per line. */
export function PasteSwitcher({ lines, heading = "Send your agent." }: { lines: PasteLine[]; heading?: string | null }) {
  const [active, setActive] = useState(0);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const uid = useId();
  const pick = (i: number, focus: boolean) => {
    setActive(i);
    if (focus) refs.current[i]?.focus();
  };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = lines.length;
    if (event.key === "ArrowRight") pick((i + 1) % n, true);
    else if (event.key === "ArrowLeft") pick((i - 1 + n) % n, true);
    else if (event.key === "Home") pick(0, true);
    else if (event.key === "End") pick(n - 1, true);
    else return;
    event.preventDefault();
  };
  return (
    <div className="send">
      {heading ? <h2 id={`${uid}-h`}>{heading}</h2> : null}
      <div className="tabs" role="tablist" aria-label={heading ?? "Send your agent"}>
        {lines.map((item, i) => (
          <button
            key={item.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            className="tab"
            role="tab"
            type="button"
            id={`${uid}-tab-${item.id}`}
            aria-controls={`${uid}-panel-${item.id}`}
            aria-selected={i === active}
            tabIndex={i === active ? 0 : -1}
            onClick={() => pick(i, false)}
            onKeyDown={(event) => onKey(event, i)}
          >
            {item.tab}
          </button>
        ))}
      </div>
      {lines.map((item, i) => (
        <div className="panel" role="tabpanel" id={`${uid}-panel-${item.id}`} aria-labelledby={`${uid}-tab-${item.id}`} hidden={i !== active} key={item.id}>
          <div className="line">
            <code>
              {item.prompt ? <span className="p">$ </span> : null}
              {item.line}
            </code>
            <CopyButton text={item.line} />
          </div>
          <p className="hint">{item.hint}</p>
        </div>
      ))}
    </div>
  );
}

/** One paste line on its own, with a copy button. */
export function PasteLineSolo({ line, prompt = false }: { line: string; prompt?: boolean }) {
  return (
    <div className="panel panel--solo">
      <div className="line">
        <code>
          {prompt ? <span className="p">$ </span> : null}
          {line}
        </code>
        <CopyButton text={line} />
      </div>
    </div>
  );
}
