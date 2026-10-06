import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireHomeWriter } from "../src/main/home-writer.js";
import { SessionStore, WorkspaceStore } from "../src/main/session/store.js";
import { Handoffs, HandoffFault } from "../src/main/session/handoffs.js";
import { loadProjectConfig } from "../src/main/config/project.js";
import { WorkspaceTrust } from "../src/main/config/trust.js";
import { decidePermission } from "../src/main/core/permissions.js";
import { historyText } from "../src/main/tools/project-history.js";
import { handoffReference } from "../src/shared/handoffs.js";

/** Local inbox only. No provider, authentication, tool execution or auto-resume. */
export async function handoffCli(args: string[]) {
  const get = (name: string) => args[args.indexOf(name) + 1];
  const homeArg = args.includes("--home") && get("--home"),
    sessionId = args.includes("--session") && get("--session"),
    destinationId = args.includes("--destination") && get("--destination");
  if (
    !homeArg ||
    !sessionId ||
    !/^[\w-]{1,128}$/.test(sessionId) ||
    (!args.includes("--list") &&
      (!destinationId || !/^[\w-]{1,128}$/.test(destinationId)))
  )
    throw new HandoffFault(
      "Usage: pnpm handoff --home <home> --session <source-or-inbox> (--list | --destination <session>)",
    );
  const home = resolve(homeArg),
    lock = await acquireHomeWriter(home);
  let input: ReturnType<typeof createInterface> | undefined;
  try {
    const sessions = new SessionStore(home),
      workspaces = new WorkspaceStore(home),
      trust = new WorkspaceTrust(home);
    await sessions.load();
    await workspaces.load();
    const source = sessions.get(sessionId);
    if (!source) throw new HandoffFault("会話がありません。");
    const service = new Handoffs(home),
      scope = {
        home,
        sessions,
        workspaces,
        sessionId,
        workspaceId: source.workspaceId,
        cwd: source.cwd,
        clean: (text: string) => historyText(text, (s) => s),
      };
    const writable = async (ids: string[]) => {
      for (const id of ids) {
        const session = sessions.get(id);
        if (!session) throw new HandoffFault("会話がありません。");
        const root =
          session.workspaceId && workspaces.get(session.workspaceId)?.root;
        const config = await loadProjectConfig(home, root || undefined, {
          trusted: !root || (await trust.isTrusted(root)),
        });
        if (
          (await decidePermission(
            { id: "handoff-cli", name: "ProposeProjectMemory", input: {} },
            {
              ...config.permissions,
              mode: session.permissionMode ?? config.permissions.mode,
            },
            session.cwd,
            { readOnly: session.readOnly },
          )) === "deny"
        )
          throw new HandoffFault("現在の権限では受け渡しできません。");
      }
    };
    if (args.includes("--list")) {
      console.log(
        JSON.stringify(await service.run(scope, { action: "list" }), null, 2),
      );
      return;
    }
    const preview = (
      await service.run(
        scope,
        { action: "preview", destinationId: destinationId as string },
        writable,
      )
    ).preview!;
    console.log(handoffReference(preview));
    console.log("未送信。受信は参照の保存のみであり、モデルを実行しません。");
    input = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await input.question(
      `本文と宛先を確認して送信する場合だけ SEND ${preview.id} と入力: `,
    );
    if (answer !== `SEND ${preview.id}`) {
      await service.run(scope, { action: "cancel", previewId: preview.id });
      console.log("取消。未送信。");
      return;
    }
    const result = await service.run(
      scope,
      { action: "confirm", previewId: preview.id, confirmed: true },
      writable,
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    input?.close();
    await lock.release();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  handoffCli(process.argv.slice(2)).catch(() => {
    console.error(
      "受け渡しを完了確認できません。引数・homeのwriter・権限を確認し、受信一覧を再取得してください。",
    );
    process.exitCode = 1;
  });
