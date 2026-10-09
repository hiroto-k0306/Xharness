# XHarness

Windows向けのコーディング支援アプリです。公式Claude Agent SDK / Codex App Serverを使い、チャットから質問・探索・計画・実装・テスト報告・レビューを進めます。desktopとheadlessは同じサービスを使用します。

## 文書を読む

- [文書索引](docs/README.md)：全体と機能別の入口。
- [Requirements](docs/Requirements.md)：背景・目的・利用者の意図。
- [Spec](docs/Spec.md)：検証可能な要件、振る舞い、受入条件。
- [設計](docs/design/Architecture.md)：責務・構造とruntime/配布。
- [AGENTS](AGENTS.md)：原則・スコープ・変更ガバナンス。
- [開発・検証・配布手順](docs/development.md)、[配布物のREADME](release/README.md)。

## 機能の入口

| 機能       | 要求                                 | 要件・仕様                    | 設計・記録                                                                           |
| ---------- | ------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------ |
| 作業実行   | [Why](docs/workflow/Requirements.md) | [What](docs/workflow/Spec.md) | [設計](docs/workflow/design/Architecture.md)・[記録](docs/workflow/report/README.md) |
| 会話・保存 | [Why](docs/sessions/Requirements.md) | [What](docs/sessions/Spec.md) | [設計](docs/sessions/design/Architecture.md)・[記録](docs/sessions/report/README.md) |
| スキル     | [Why](docs/skills/Requirements.md)   | [What](docs/skills/Spec.md)   | [設計](docs/skills/design/Architecture.md)・[記録](docs/skills/report/README.md)     |

## 現在の確認範囲

実装済みと対象環境で検証済みを区別します。限定DAGのWindows実CLI隔離、実モデル通信、実LLMの担当選択改善、最新ソースの配布・インストールは今回のクラウド作業では未検証です。Codex選択skillは安全な探索隔離契約が成立せずnative実行を停止します。詳細は各Specとreportを参照してください。

旧版・退役資料は [Old索引](Old/README.md) に保存します。過去の試験記録や旧操作を、現行機能・新たな実行許可として扱いません。
