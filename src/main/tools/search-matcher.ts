import { Worker } from "node:worker_threads";
import { ToolExecutionError } from "./errors.js";

/** Isolate regex backtracking so a costly pattern cannot block stop or the UI. */
export class SearchMatcher {
  private readonly worker: Worker;
  private failed = false;
  constructor(pattern: string) {
    this.worker = new Worker(
      `const {parentPort,workerData}=require('node:worker_threads');
      const regex=new RegExp(workerData,'u');
      parentPort.on('message',({lines,limit})=>{
        const result=[];
        for(let i=0;i<lines.length;i++) if(regex.test(lines[i])) {
          result.push(i); if(result.length>=limit) break;
        }
        parentPort.postMessage(result);
      });`,
      { eval: true, workerData: pattern },
    );
    this.worker.on("error", () => {
      this.failed = true;
    });
  }
  match(
    lines: string[],
    limit: number,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<number[]> {
    signal.throwIfAborted();
    if (this.failed)
      throw new ToolExecutionError("検索処理に失敗しました。", "failed");
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.worker.off("message", done);
        this.worker.off("error", error);
      };
      const done = (indices: number[]) => {
        cleanup();
        resolve(indices);
      };
      const error = () => {
        cleanup();
        reject(new ToolExecutionError("検索処理に失敗しました。", "failed"));
      };
      const abort = () => {
        cleanup();
        reject(
          new ToolExecutionError("ユーザーの操作で中断しました。", "aborted"),
        );
      };
      const timer = setTimeout(
        () => {
          cleanup();
          reject(
            new ToolExecutionError("検索時間の上限に達しました。", "timeout"),
          );
        },
        Math.max(1, timeoutMs),
      );
      signal.addEventListener("abort", abort, { once: true });
      this.worker.once("message", done);
      this.worker.once("error", error);
      this.worker.postMessage({ lines, limit });
      if (signal.aborted) abort();
    });
  }
  async close() {
    await this.worker.terminate();
  }
}
