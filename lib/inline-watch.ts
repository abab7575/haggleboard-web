import { after } from "next/server";
import { runWatch } from "../watcher/run.js";
import { watcherInline } from "../watcher/constants.js";
import { scheduleTestStores, testStoresEnabled } from "../watcher/test-stores.js";
import { windowFromEvents } from "./auction.js";
import { eventContext, requestEvents, type Channel } from "./events.js";
import { indexNowEnabled, submitIndexNow } from "./indexnow.js";
import { requestOrigin } from "./origin.js";
import type { Deps } from "./service.js";

/**
 * For app routes only. Records where the request came from and who sent it (for the event log).
 * After the response is sent (next/server after()):
 *  - when WATCHER_INLINE is on, runs the watcher (off by default; the worker picks it up instead);
 *  - when INDEXNOW_ENABLED is on and the request is from outside, submits its public page to IndexNow.
 */
export function withRequestHooks(
  deps: Deps,
  req: Request,
  channel: Channel = "api",
  env: NodeJS.ProcessEnv = process.env,
): Deps {
  const origin = requestOrigin(req, env);
  const context = eventContext(req, channel, env);
  const watch = watcherInline(env);
  const announce = indexNowEnabled(env) && !context.internal && origin === "outside";
  const testStores = testStoresEnabled(env);
  if (!watch && !announce && !testStores) return { ...deps, origin, context };
  return {
    ...deps,
    origin,
    context,
    afterPost: (request) => {
      if (testStores) {
        // TEST_STORES=1 (local only): made-up .example stores answer through the real rules engine.
        void (async () => {
          const window = windowFromEvents(await requestEvents(deps.store, request.id));
          if (window) scheduleTestStores(deps.store, { id: request.id, need: request.need }, window);
        })().catch(() => console.error("test stores failed to start"));
      }
      after(async () => {
        if (announce) {
          try {
            await submitIndexNow([`/r/${request.id}`], env);
          } catch {
            console.error("indexnow failed");
          }
        }
        if (watch) {
          try {
            await runWatch(deps.store, request, deps.loadVariants);
          } catch {
            console.error("watch failed");
          }
        }
      });
    },
  };
}
