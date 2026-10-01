import { sendProbe } from "../lib/probe.js";
import { maskSecrets } from "../lib/mask.js";
import { codexHeaders, codexResponsesUrl } from "./request.js";
import { summarizeCodexText } from "./text.js";

export const spikeModels = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"];
export const spikeEfforts = ["low", "medium", "xhigh", "max"];

export async function probeEffort(
  auth: { accessToken: string; accountId: string },
  model: string,
  effort: string,
  options: { root?: string; fetcher?: typeof fetch } = {},
) {
  if (!spikeModels.includes(model) || !spikeEfforts.includes(effort))
    throw new Error("Unsupported effort probe");
  const secrets = [auth.accessToken, auth.accountId];
  const result = await sendProbe({
    provider: "codex",
    name: `x4-${model.replaceAll(".", "-")}-${effort}`,
    url: codexResponsesUrl,
    headers: codexHeaders(auth),
    body: {
      model,
      instructions: "You are a helpful assistant.",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Reply with the single word: pong" },
          ],
        },
      ],
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort },
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
    },
    secrets,
    ...options,
  });
  const summary = summarizeCodexText(result.events);
  const success =
    result.ok &&
    summary.completed &&
    !summary.failed &&
    summary.text.trim() === "pong";
  return {
    success,
    report: maskSecrets(
      {
        model,
        effort,
        status: result.status,
        requestNumber: result.requestNumber,
        success,
        ...summary,
        paths: result.paths,
        errorBody: result.body,
      },
      secrets,
    ),
  };
}
