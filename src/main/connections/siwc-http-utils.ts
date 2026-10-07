import { BoundaryError } from "./contracts.js";
export type Http = typeof fetch;
export const SIWC_RESOURCE = "https://api.openai.com/v1";
export const SIWC_ISSUER = "https://auth.openai.com";
export async function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new BoundaryError("cancelled");
  let abort!: () => void;
  const stop = new Promise<never>((_, reject) => {
    abort = () => reject(new BoundaryError("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, stop]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
/** Bounded bodies; exception text from HTTP/native errors never escapes. */
export async function boundedJson(response: Response, signal: AbortSignal) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new BoundaryError("transport");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new BoundaryError("transport");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if ((bytes += value.byteLength) > 1_048_576)
        throw new BoundaryError("malformed");
      chunks.push(value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new BoundaryError(signal.aborted ? "cancelled" : "malformed");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
