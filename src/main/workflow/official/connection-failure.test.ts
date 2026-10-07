import { expect, it } from "vitest";
import { connectionFailure } from "./connection-failure.js";
import { WorkflowFailure } from "./contracts.js";
import { PersonalApprovalError } from "../../connections/personal-sdk.js";
it("keeps the failing official stage and application reason without leaking raw native errors", () => {
  expect(
    connectionFailure(
      "codex",
      new WorkflowFailure("app-server-request-failed:account/read"),
    ),
  ).toContain("account/read");
  expect(
    connectionFailure("claude", new PersonalApprovalError("サブスク未確認")),
  ).toContain("サブスク未確認");
  expect(
    connectionFailure(
      "claude",
      Object.assign(new Error("secret-native-output"), { code: "EACCES" }),
    ),
  ).toContain("EACCES");
  expect(
    connectionFailure("claude", new Error("secret-native-output")),
  ).not.toContain("secret-native-output");
});
