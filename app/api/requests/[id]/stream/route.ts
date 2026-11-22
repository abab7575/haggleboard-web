import { errorResponse, emptyOptions, HttpError } from "../../../../../lib/http";
import { defaultDeps } from "../../../../../lib/service";
import { publicStream } from "../../../../../lib/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** One connection stays open at most this long, then asks the browser to reconnect (EventSource does it). */
const CONNECTION_MS = 25_000;
const POLL_MS = 1_500;

/**
 * Server-Sent Events for one request. Public fields only (lib/stream.ts). Each event's SSE `id` is
 * its seq, so a reconnecting EventSource sends Last-Event-ID and resumes where it left off. A `tick`
 * event carries seconds_left on every poll. The stream ends after auction.closed, or after 25
 * seconds (serverless limits), with `retry: 1000`. Polling fallback: /api/requests/{id}/events.
 */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "No stored request with that id");
    const store = (await defaultDeps()).store;
    const first = await publicStream(store, id);
    if (!first) throw new HttpError(404, "No stored request with that id");
    const resume = Number(req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("after") ?? "0");
    let sent = Number.isFinite(resume) && resume > 0 ? resume : 0;
    const encoder = new TextEncoder();
    const started = Date.now();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (text: string) => controller.enqueue(encoder.encode(text));
        write(`retry: 1000\n\n`);
        write(`event: meta\ndata: ${JSON.stringify({ request_id: first.request_id, requestLabel: first.requestLabel, deadline: first.deadline, window_seconds: first.window_seconds })}\n\n`);
        let current = first;
        for (;;) {
          for (const event of current.events) {
            if (event.seq <= sent) continue;
            write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            sent = event.seq;
          }
          write(`event: tick\ndata: ${JSON.stringify({ seconds_left: current.seconds_left, status: current.status })}\n\n`);
          if (current.status === "closed" || current.status === "no_auction" || req.signal.aborted) break;
          if (Date.now() - started > CONNECTION_MS) break;
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          const next = await publicStream(store, id);
          if (!next) break;
          current = next;
        }
        controller.close();
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "access-control-allow-origin": "*",
      },
    });
  } catch (error) {
    return errorResponse(error, "read");
  }
}

export function OPTIONS() {
  return emptyOptions("read");
}
