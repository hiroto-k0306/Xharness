import { useState } from "react";
import {
  validCases,
  type ImprovementAction,
  type ImprovementSource,
} from "../../shared/improvements.js";
export function ImprovementBaseline({
  busy,
  command,
  setError,
}: {
  busy: boolean;
  command(request: ImprovementAction): Promise<void>;
  setError(error: string): void;
}) {
  const [name, setName] = useState(""),
    [body, setBody] = useState(""),
    [source, setSource] = useState(""),
    [hash, setHash] = useState(""),
    [memoryId, setMemory] = useState(""),
    [memoryRevision, setMemoryRevision] = useState(1);
  const [cases, setCases] = useState(
    JSON.stringify(
      [
        {
          id: "ping",
          prompt: "Reply pong",
          taskType: "text",
          difficulty: "small",
          criteria: "v1: reply pong; user checks saved output",
          environment: "local-fixed",
        },
      ],
      null,
      2,
    ),
  );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const fixed: unknown = JSON.parse(cases);
          if (!validCases(fixed))
            throw new Error(
              "固定課題は1〜3件、id・prompt・taskType・difficulty・criteria・environmentが必要です。",
            );
          const refs: ImprovementSource = {};
          if (source || hash) refs.skill = { source, hash };
          if (memoryId)
            refs.memory = { id: memoryId, revision: memoryRevision };
          void command({
            action: "create",
            name,
            body,
            cases: fixed,
            source: refs,
          });
        } catch (err) {
          setError(String(err));
        }
      }}
    >
      <h3>固定課題と基準版を保存</h3>
      <label>
        比較名
        <input
          aria-label="比較名"
          required
          maxLength={200}
          value={name}
          onChange={(x) => setName(x.target.value)}
        />
      </label>
      <label>
        基準本文
        <textarea
          aria-label="基準本文"
          required
          maxLength={8000}
          value={body}
          onChange={(x) => setBody(x.target.value)}
        />
      </label>
      <label>
        固定課題（JSON・1〜3件）
        <textarea
          aria-label="固定課題"
          value={cases}
          onChange={(x) => setCases(x.target.value)}
        />
      </label>
      <label>
        スキル出典（任意・相対source）
        <input
          aria-label="スキル出典"
          value={source}
          onChange={(x) => setSource(x.target.value)}
        />
      </label>
      <label>
        出典SHA-256
        <input
          aria-label="出典SHA-256"
          value={hash}
          onChange={(x) => setHash(x.target.value)}
        />
      </label>
      <label>
        採用済みメモリID（任意）
        <input
          aria-label="メモリID"
          value={memoryId}
          onChange={(x) => setMemory(x.target.value)}
        />
      </label>
      <label>
        メモリ版
        <input
          aria-label="メモリ版"
          type="number"
          min={1}
          value={memoryRevision}
          onChange={(x) => setMemoryRevision(Number(x.target.value))}
        />
      </label>
      <button disabled={busy}>基準版を保存</button>
    </form>
  );
}
