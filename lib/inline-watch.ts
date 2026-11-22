import { after } from "next/server";
import { runWatch } from "../watcher/run.js";
import { watcherInline } from "../watcher/constants.js";
import { requestOrigin } from "./origin.js";
import type { Deps } from "./service.js";

/**
 * For app routes only. Records where the request came from and, when WATCHER_INLINE is on, runs the
 * watcher after the response is sent (next/server after()). Off by default: then the worker
 * (`npm run watch -- work`) picks the request up instead.
 */
export function withRequestHooks(deps: Deps, req: Request, env: NodeJS.ProcessEnv = process.env): Deps {
  const origin = requestOrigin(req, env);
  if (!watcherInline(env)) return { ...deps, origin };
  return {
    ...deps,
    origin,
    afterPost: (request) => {
      after(async () => {
        try {
          await runWatch(deps.store, request, deps.loadVariants);
        } catch {
          console.error("watch failed");
        }
      });
    },
  };
}
