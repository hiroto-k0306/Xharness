import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type LoginResult } from "./cli-login.js";
import {
  type AuthenticationView,
  type ProviderName,
} from "../../shared/ipc.js";

export async function credentialStatus(
  provider: ProviderName,
  directory = provider === "claude"
    ? process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
    : process.env.CODEX_HOME || join(homedir(), ".codex"),
  now = Date.now(),
): Promise<AuthenticationView> {
  try {
    const data = JSON.parse(
      await readFile(
        join(
          directory,
          provider === "claude" ? ".credentials.json" : "auth.json",
        ),
        "utf8",
      ),
    );
    const auth = provider === "claude" ? data.claudeAiOauth : data.tokens;
    const token =
      provider === "claude" ? auth?.accessToken : auth?.access_token;
    if (
      typeof token !== "string" ||
      !token ||
      (provider === "codex" &&
        (typeof auth?.account_id !== "string" || !auth.account_id))
    )
      return { provider, status: "missing" };
    let expiry = provider === "claude" ? auth.expiresAt : undefined;
    if (provider === "codex") {
      try {
        const payload = JSON.parse(
          Buffer.from(token.split(".")[1]!, "base64url").toString(),
        );
        if (typeof payload.exp === "number") expiry = payload.exp * 1000;
      } catch {
        /* Opaque token: validity is checked when the provider is called. */
      }
    }
    return {
      provider,
      status:
        typeof expiry === "number" && expiry <= now ? "expired" : "available",
    };
  } catch {
    return { provider, status: "missing" };
  }
}

export interface AuthenticationOptions {
  read?(provider: ProviderName): Promise<AuthenticationView>;
  confirm(provider: ProviderName): Promise<boolean>;
  launch(provider: ProviderName): Promise<LoginResult>;
  refreshSecrets(): Promise<void>;
  changed(): void;
}

/** Only the official CLI writes credentials. No CLI output or tokens reach the UI. */
export class Authentication {
  private views: AuthenticationView[] = [];
  private busy = false;
  private refreshing?: Promise<void>;
  constructor(private readonly options: AuthenticationOptions) {}
  snapshot() {
    return this.views.map((v) => ({ ...v }));
  }
  isBusy() {
    return this.busy;
  }
  async refresh() {
    if (this.busy) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.readStatuses().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  private async readStatuses() {
    this.views = await Promise.all(
      (["claude", "codex"] as const).map((provider) =>
        (this.options.read ?? credentialStatus)(provider),
      ),
    );
    await this.options.refreshSecrets();
    this.options.changed();
  }
  reject(provider: ProviderName) {
    this.update({
      provider,
      status: "rejected",
      message: "提供元に認証を拒否されました。公式CLIで再認証してください。",
    });
  }
  private update(view: AuthenticationView) {
    this.views = this.views.some((v) => v.provider === view.provider)
      ? this.views.map((v) => (v.provider === view.provider ? view : v))
      : this.views.concat(view);
    this.options.changed();
  }
  async authenticate(provider: ProviderName) {
    if (this.busy) return;
    this.busy = true;
    let original = this.views.find((v) => v.provider === provider) ?? {
      provider,
      status: "missing" as const,
    };
    try {
      await this.refreshing;
      original = this.views.find((v) => v.provider === provider) ?? original;
      this.update({
        provider,
        status: "authenticating",
        message: "認証の許可を確認しています。",
      });
      if (!(await this.options.confirm(provider))) {
        this.update(original);
        return;
      }
      this.update({
        provider,
        status: "authenticating",
        message:
          "公式CLIの画面で認証してください。完了したらこの画面に戻ってください。",
      });
      const success = await this.options.launch(provider);
      const view = await (this.options.read ?? credentialStatus)(provider);
      await this.options.refreshSecrets();
      this.update(
        success === true && view.status === "available"
          ? view
          : {
              provider,
              status: "error",
              message:
                success === "shell_missing"
                  ? "PowerShell 7（pwsh）が見つかりません。インストールしてXHarnessを再起動してください。"
                  : success === "cli_missing"
                    ? `${provider === "claude" ? "Claude" : "Codex"}の公式CLIが見つかりません。インストールしてXHarnessを再起動してください。`
                    : success === "launch_failed"
                      ? "公式CLIの操作画面を開けませんでした。PowerShell 7の起動を確認してください。"
                      : success === true
                        ? "公式CLIは終了しましたが、有効な資格情報を確認できませんでした。ログイン結果を確認してください。"
                        : "公式CLIのログインが完了しませんでした。CLI画面の案内を確認して再試行してください。",
            },
      );
    } catch {
      this.update({
        provider,
        status: "error",
        message:
          "公式CLIで認証を開始できませんでした。claude / codex と PowerShell 7 が必要です。",
      });
    } finally {
      this.busy = false;
      this.options.changed();
    }
  }
}
