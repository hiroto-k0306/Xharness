import { describe, expect, it } from "vitest";
import {
  type SessionSummary,
  type WorkspaceSummary,
} from "../../shared/ipc.js";
import { ago, groupSessions } from "./groups.js";

const ws = (id: string, name: string, lastOpenedAt = 0): WorkspaceSummary => ({
  id,
  root: `/w/${name}`,
  name,
  kind: "git",
  lastOpenedAt,
});
const se = (
  id: string,
  workspaceId: string | null,
  over: Partial<SessionSummary> = {},
): SessionSummary => ({
  id,
  title: `t-${id}`,
  workspaceId,
  cwd: "/",
  readOnly: false,
  createdAt: 0,
  updatedAt: 0,
  status: "idle",
  providers: [],
  ...over,
});

describe("groupSessions (§16.6)", () => {
  const workspaces = [
    ws("a", "alpha", 10),
    ws("b", "beta", 20),
    ws("c", "gamma", 5),
  ];
  it("groups by workspace, newest sessions first, 'その他' last", () => {
    const groups = groupSessions(
      {
        workspaces,
        sessions: [
          se("1", "a", { updatedAt: 1 }),
          se("2", "a", { updatedAt: 9 }),
          se("3", null),
          se("4", "b", { updatedAt: 3 }),
        ],
      },
      { search: "", sort: "recent" },
    );
    expect(groups.map((g) => g.name)).toEqual([
      "beta",
      "alpha",
      "gamma",
      "その他",
    ]);
    expect(groups[1]!.sessions.map((s) => s.id)).toEqual(["2", "1"]);
    expect(groups.at(-1)).toMatchObject({ isOther: true, id: "other" });
  });
  it("puts groups with running or asking sessions on top", () => {
    const groups = groupSessions(
      {
        workspaces,
        sessions: [
          se("1", "c", { status: "ask" }),
          se("2", "b", { updatedAt: 99 }),
        ],
      },
      { search: "", sort: "recent" },
    );
    expect(groups[0]).toMatchObject({
      name: "gamma",
      running: true,
      ask: true,
    });
  });
  it("sorts by name when asked", () => {
    const groups = groupSessions(
      { workspaces, sessions: [] },
      { search: "", sort: "name" },
    );
    expect(groups.map((g) => g.name)).toEqual(["alpha", "beta", "gamma"]);
  });
  it("filters by title and hides groups with no match while searching", () => {
    const groups = groupSessions(
      {
        workspaces,
        sessions: [
          se("1", "a", { title: "Login form" }),
          se("2", "b", { title: "README" }),
          se("3", null, { title: "login question" }),
        ],
      },
      { search: "LOGIN", sort: "recent" },
    );
    expect(groups.map((g) => g.name)).toEqual(["alpha", "その他"]);
  });
  it("keeps sessions of a forgotten workspace under 'その他' instead of losing them", () => {
    const groups = groupSessions(
      { workspaces: [], sessions: [se("1", "gone")] },
      { search: "", sort: "recent" },
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ isOther: true });
    expect(groups[0]!.sessions).toHaveLength(1);
  });
  it("formats relative times", () => {
    const now = 10_000_000_000;
    expect(ago(now - 5_000, now)).toBe("now");
    expect(ago(now - 12 * 60_000, now)).toBe("12m ago");
    expect(ago(now - 2 * 3_600_000, now)).toBe("2h ago");
    expect(ago(now - 3 * 86_400_000, now)).toBe("3d ago");
  });
});
