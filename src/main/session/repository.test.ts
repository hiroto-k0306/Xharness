import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  Repository,
  repositoryUrl,
  runGit,
  type GitRunner,
} from "./repository.js";
const signal = () => new AbortController().signal;
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "xh-repo-"));
  const root = await mkdtemp(join(tmpdir(), "xh-original-"));
  await runGit(["init", "-b", "main"], root, signal());
  await runGit(["config", "user.name", "XHarness test"], root, signal());
  await runGit(["config", "user.email", "test@invalid.local"], root, signal());
  await writeFile(join(root, "file.txt"), "original");
  await runGit(["add", "file.txt"], root, signal());
  await runGit(["commit", "-m", "initial"], root, signal());
  return { home, root, repo: new Repository(home) };
}
describe("repository / worktree isolation", () => {
  it("runs actual clone and fetch against a local fixture and switches only a clean checkout", async () => {
    const { home, root } = await fixture();
    await runGit(["branch", "other"], root, signal());
    const remote = "https://example.com/owner/repo.git";
    const localGit: GitRunner = async (args, cwd, abort, progress) => {
      if (args[0] === "config" && args.at(-1) === "remote.origin.url")
        return remote;
      return runGit(
        args.map((arg) => (arg === remote ? root : arg)),
        cwd,
        abort,
        progress,
      );
    };
    const repo = new Repository(home, localGit);
    const opened = await repo.open({ url: remote }, signal());
    expect(await readFile(join(opened.root, "file.txt"), "utf8")).toBe(
      "original",
    );
    await repo.open({ url: remote, branch: "other" }, signal());
    expect(
      await runGit(["branch", "--show-current"], opened.root, signal()),
    ).toBe("other");
    await writeFile(join(opened.root, "file.txt"), "dirty");
    await expect(
      repo.open({ url: remote, branch: "main" }, signal()),
    ).rejects.toThrow("uncommitted");
  });
  it("restores a missing managed worktree from its retained branch only after confirmation", async () => {
    const { root, home, repo } = await fixture();
    const tree = await repo.createWorktree(
      root,
      "workspace",
      "restore",
      signal(),
    );
    expect(tree.path).toBe(join(home, "worktrees", "workspace", "restore"));
    await rm(tree.path, { recursive: true }); // Own temporary fixture, verified above.
    await expect(repo.restore(root, tree, false, signal())).rejects.toThrow(
      "confirmation",
    );
    await repo.restore(root, tree, true, signal());
    expect(await readFile(join(tree.path, "file.txt"), "utf8")).toBe(
      "original",
    );
    await expect(repo.restore(root, tree, true, signal())).rejects.toThrow(
      "exists",
    );
  });
  it.each([
    "file:///C:/secret",
    "https://user:secret@example.com/a/b.git",
    "https://example.com/a/b.git?token=secret",
    "--upload-pack=evil",
    "ssh://git:secret@example.com/a.git",
    "git@example.com:a.git\ncommand",
  ])("rejects unsafe URL %s", (url) =>
    expect(() => repositoryUrl(url)).toThrow(),
  );
  it("accepts credential-manager HTTPS and SSH URLs", () => {
    expect(repositoryUrl("https://github.com/a/b.git")).toBe(
      "https://github.com/a/b.git",
    );
    expect(repositoryUrl("git@github.com:a/b.git")).toBe(
      "git@github.com:a/b.git",
    );
  });
  it("creates an isolated branch, retains by default, merges committed work and preserves dirty work without confirmation", async () => {
    const { root, repo } = await fixture();
    const tree = await repo.createWorktree(
      root,
      "workspace",
      "session",
      signal(),
    );
    expect(tree.branch).toBe("xh/session");
    await writeFile(join(tree.path, "file.txt"), "changed");
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("original");
    await repo.finish(root, tree, "keep", false, signal());
    await expect(
      repo.finish(root, tree, "remove", false, signal()),
    ).rejects.toThrow("uncommitted");
    await expect(
      repo.finish(root, tree, "merge", true, signal()),
    ).rejects.toThrow("uncommitted");
    await runGit(["add", "file.txt"], tree.path, signal());
    await runGit(["commit", "-m", "isolated"], tree.path, signal());
    await repo.finish(root, tree, "merge", true, signal());
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("changed");
    await repo.finish(root, tree, "remove", true, signal());
    await expect(stat(tree.path)).rejects.toThrow();
    expect(
      await runGit(["branch", "--list", tree.branch], root, signal()),
    ).toContain(tree.branch);
  });
  it("removes only a confirmed managed worktree and explicitly removes its branch", async () => {
    const { root, repo } = await fixture();
    const tree = await repo.createWorktree(
      root,
      "workspace",
      "second",
      signal(),
    );
    await writeFile(join(tree.path, "untracked.txt"), "dirty");
    await expect(
      repo.finish(
        root,
        { ...tree, path: root },
        "remove_branch",
        true,
        signal(),
      ),
    ).rejects.toThrow("Unmanaged");
    await repo.finish(root, tree, "remove_branch", true, signal());
    expect(
      await runGit(["branch", "--list", tree.branch], root, signal()),
    ).toBe("");
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("original");
  });
  it("clones with shell-free arguments then fetches the same repository instead of cloning again", async () => {
    const home = await mkdtemp(join(tmpdir(), "xh-clone-"));
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      return args[0] === "config" ? "https://example.com/owner/repo.git" : "";
    };
    const repo = new Repository(home, git);
    const opened = await repo.open(
      {
        url: "https://example.com/owner/repo.git",
        shallow: true,
        branch: "main",
      },
      signal(),
    );
    expect(calls[0]).toEqual([
      "clone",
      "--progress",
      "--depth",
      "1",
      "--branch",
      "main",
      "--",
      "https://example.com/owner/repo.git",
      opened.root,
    ]);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(opened.root);
    await repo.open({ url: "https://example.com/owner/repo.git" }, signal());
    expect(calls.at(-1)).toEqual(["fetch", "--progress", "origin"]);
    expect(calls.filter((c) => c[0] === "clone")).toHaveLength(1);
  });
  it("handles missing git and abort without exposing raw stderr", async () => {
    const git = vi.fn<GitRunner>().mockRejectedValue(new Error("missing"));
    expect(await new Repository("unused", git).available()).toBe(false);
    const controller = new AbortController();
    controller.abort();
    await expect(
      runGit(["--version"], undefined, controller.signal),
    ).rejects.toThrow("aborted");
  });
});
