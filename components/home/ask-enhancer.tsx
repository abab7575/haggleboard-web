"use client";

import { useEffect, useState } from "react";

/**
 * Turns the homepage form into a real post. Without JavaScript the form opens /find?q=..., which
 * posts the request and shows the token once. With JavaScript it posts to /api/requests, keeps the
 * delete token in this browser only (localStorage, keyed by request id; never in a URL), and opens
 * the request's live arena, where the poster sees the amounts.
 */
export function AskEnhancer({ formId }: { formId: string }) {
  const [state, setState] = useState<{ kind: "idle" | "sending" | "error" | "unstored"; message?: string }>({ kind: "idle" });

  useEffect(() => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;
    const onSubmit = async (event: SubmitEvent) => {
      event.preventDefault();
      const input = form.querySelector<HTMLInputElement>("input[name=q]");
      const text = input?.value.trim() ?? "";
      if (!text) return;
      setState({ kind: "sending" });
      const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
      if (button) button.disabled = true;
      try {
        const res = await fetch("/api/requests", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          id?: string;
          persisted?: boolean;
          delete_token?: string | null;
          error?: string;
        };
        if (!res.ok) {
          setState({
            kind: "error",
            message:
              res.status === 429
                ? "Too many posts from here in a short time. Try again in a minute."
                : (body.error ?? "That did not post. Try different words."),
          });
          return;
        }
        if (!body.persisted || !body.id || !body.delete_token) {
          setState({ kind: "unstored", message: text });
          return;
        }
        try {
          window.localStorage.setItem(`hb:token:${body.id}`, body.delete_token);
        } catch {
          // Storage blocked: the arena opens in the public view.
        }
        window.location.assign(`/r/${body.id}`);
      } catch {
        setState({ kind: "error", message: "Could not reach HaggleBoard. Check your connection and try again." });
      } finally {
        if (button) button.disabled = false;
      }
    };
    const listener = (event: Event) => void onSubmit(event as SubmitEvent);
    form.addEventListener("submit", listener);
    return () => form.removeEventListener("submit", listener);
  }, [formId]);

  if (state.kind === "idle") return null;
  return (
    <p className={`ask-status ask-status--${state.kind}`} role="status">
      {state.kind === "sending" ? "Posting it and starting the clock..." : null}
      {state.kind === "error" ? state.message : null}
      {state.kind === "unstored" ? (
        <>
          This server keeps no database, so there is no live auction here.{" "}
          <a href={`/results?text=${encodeURIComponent(state.message ?? "")}`}>Compare public prices instead</a>.
        </>
      ) : null}
    </p>
  );
}
