import { randomUUID } from "node:crypto";

export const codexResponsesUrl =
  "https://chatgpt.com/backend-api/codex/responses";

export function codexHeaders(
  auth: { accessToken: string; accountId: string },
  id = randomUUID(),
) {
  return new Headers({
    authorization: `Bearer ${auth.accessToken}`,
    "chatgpt-account-id": auth.accountId,
    "content-type": "application/json",
    accept: "text/event-stream",
    originator: "codex_cli_rs",
    "user-agent": "codex_cli_rs/0.159.2",
    "session-id": id,
    "thread-id": id,
    "x-client-request-id": id,
  });
}
