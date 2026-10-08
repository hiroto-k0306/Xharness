/** Agent time excludes the union of overlapping operation approval waits. */
export function phaseTimer(limitMs: number, expire: () => void) {
  let remaining = limitMs;
  let resumedAt = Date.now();
  let waits = 0;
  let closed = false;
  let timer = setTimeout(expire, remaining);
  return {
    pause() {
      if (closed || waits++ > 0) return;
      clearTimeout(timer);
      remaining = Math.max(0, remaining - (Date.now() - resumedAt));
    },
    resume() {
      if (closed || waits === 0 || --waits > 0) return;
      resumedAt = Date.now();
      timer = setTimeout(expire, remaining);
    },
    close() {
      closed = true;
      clearTimeout(timer);
    },
  };
}
