export type PoliteScheduler = {
  setHostInterval: (host: string, ms: number) => void;
  wait: (host: string) => Promise<number>;
};

export function createPoliteScheduler(opts: {
  perHostMs: number;
  globalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): PoliteScheduler {
  const nowFn = opts.now ?? Date.now;
  const sleepFn = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const lastHost = new Map<string, number>();
  const hostInterval = new Map<string, number>();
  let nextGlobal = Number.NEGATIVE_INFINITY;

  return {
    setHostInterval(host: string, ms: number) {
      hostInterval.set(host, ms);
    },
    async wait(host: string) {
      const now = nowFn();
      const interval = hostInterval.get(host) ?? opts.perHostMs;
      const hostEarliest = lastHost.has(host) ? (lastHost.get(host) as number) + interval : now;
      const globalEarliest = nextGlobal === Number.NEGATIVE_INFINITY ? now : nextGlobal;
      const earliest = Math.max(now, hostEarliest, globalEarliest);
      const waited = earliest - now;
      lastHost.set(host, earliest);
      nextGlobal = earliest + opts.globalMs;
      if (waited > 0) await sleepFn(waited);
      return waited;
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
