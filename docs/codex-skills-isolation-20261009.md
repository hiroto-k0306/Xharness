# Codex 選択公式スキルの discovery 隔離調査（2026-10-09）

初回実装基準 HEAD: `bcca482`。追加ソース調査基準 HEAD: `bf26cb9`（2026-10-09）。Linux 保存環境で現行 AGENTS.md、SPEC §9、Codex adapter と現 CLI の生成 schema を照合した。Windows、実モデル通信、App Server 起動、skill 実行、認証、インストール、永続設定変更は行っていない。

## 結論と変更

Codex の選択公式 skill の native 実行は引き続き未対応。明示 skill 入力を渡せることと、選択外の skill discovery を隔離できることは別の契約である。対象 CLI の schema と公式資料から、project・祖先・user・admin・system を一時的な selected-only allowlist で除外する保証を確認できなかった。未知の config キーを受け付けたこと、skills/list の結果、モデルへの指示だけから保証を推定しない。他の CLI 版にも契約がないと断定する調査ではない。

[Codex adapter](../src/main/workflow/official/codex.ts) の停止診断に固定コード `official-skills-codex-discovery-boundary-unverified` と未確認の探索範囲を追加した。選択付き request は App Server 起動前に停止し、`dispatched:false`、要求メタデータだけの `officialSkillsEvidence.requested`、空の dispatched/observed を返す。取消済み request は cancelled とし、本文を記録しない。skill 未選択経路を維持する。

[既存の公式スキル backend](../src/main/session/official-skills.ts) による固定 provider root の列挙・プレビュー・本文/付属テキストの制限・source/hash/bundleHash 再確認、保存選択と [service](../src/main/workflow/official/service.ts) の source 検証後・分類通信前の Codex 停止は既に実装されている。重複する staging/helper、仮の native 対応、参考資料送信への置換を追加していない。

## CLI と schema の根拠

クラウド CLI は `/opt/codex/bin/codex`、`codex-cli 0.159.0-alpha.3`。SHA-256 は `981ade7b03926534c654fd718ced3a9f378b7b2841271e29156f939462d176e9`。

非モデルの生成コマンド `codex app-server generate-json-schema --experimental --out /tmp/xh-codex-skills-schema` が成功した。生成物は公開 protocol の型であり、ユーザーの skill 本文や資格情報ではない。CLI の PATH alias 作成警告は read-only filesystem のためで、schema 生成自体は exit 0。この環境の生成成功を Windows 実機の能力確認と扱わない。

| 生成 schema                         | 確認した契約                                                                      | 隔離を証明しない点                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `v2/TurnStartParams.json`           | UserInput の skill variant は必須 `type:"skill"`、name、path                      | 明示入力の追加であり、選択外 discovery の一時禁止契約ではない            |
| `v2/ThreadStartParams.json`         | config は汎用 JSON map。skill discovery の専用 selected-only field は確認できない | 汎用 config の存在・未知キー受理を隔離保証にしない                       |
| `v2/SkillsListParams.json`          | cwds、forceReload                                                                 | list/reload は既定の探索範囲を排他的に置換する契約ではない               |
| `v2/SkillsListResponse.json`        | SkillScope は user/repo/system/admin。技能メタデータには enabled/path/scope       | 一覧がその時点で限定的でも、後の新規発見や追加範囲を拒否する保証ではない |
| `v2/SkillsExtraRootsSetParams.json` | extraRoots 配列                                                                   | extra roots の指定だけでは既定 root の無効化を保証しない                 |
| `v2/SkillsConfigWriteParams.json`   | enabled 必須、name/path selector                                                  | write API。永続設定の変更を一時隔離の代用品にしない                      |

上表は生成 schema の事実と安全性の判断を分けたもの。SDK/App Server への実 request は送っていない。

生成ファイルの SHA-256:

| ファイル                  | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| ThreadStartParams         | `80a40a7fac15b4bf70efb7f893fb353acc0a0d30c68f54aee4f01923deca85de` |
| TurnStartParams           | `07771223642e1b61bd9aac0069fc0f98143a1c047724ca02c7ceb13653442738` |
| SkillsListParams          | `1d245374e64c5acc9739dfc68a4fe5114c6c9147af04c480886f1846d2ca6239` |
| SkillsListResponse        | `230f125d6c36ec1b1514018a0bb6d0627f7308ea82f1ef04cad85490de482bae` |
| SkillsExtraRootsSetParams | `bb60389a0c7d4b73f625b9a40965e5e67b56b6503989f2d732cae12e9ca9698a` |
| SkillsConfigWriteParams   | `6e7dea83b649bfd118828b60446eb2eab2f5ce3cafe287c933b830c9cae9b170` |

## 非モデル feature 一覧で見つかった候補

同じ CLI の `codex features list` に `skip_host_skill_discovery` が `under development`、false として存在した。今回有効化していない。初回の実施範囲は schema/feature の生成・読取で、追加調査では公式ソースも読んだ。ユーザーの許可を schema 生成だけに限定する記述ではない。実 App Server の discovery request は送っていない。

### 対象リリースと現在 main のソース照合

[公式リリース 0.159.0-alpha.3](https://github.com/openai/codex/releases/tag/rust-v0.159.0-alpha.3) と read-only `git ls-remote` を照合した。tag object は `5b839b81dcc56a486845485ca8e3495ccb65041e`、peeled commit は `3b01b36fa5eb96ba82a776bd3c2fc57f8969181f`。2026-10-09 の取得時点の main は `2351d9e1b608e6f9d9a3699b71d7eb39ee41cfa4`。以下はこの2つの commit を固定して取得した一次ソースの事実であり、バイナリとのビルド再現性や Windows の実効性を検証したものではない。

- [対象版の turn_context](https://github.com/openai/codex/blob/3b01b36fa5eb96ba82a776bd3c2fc57f8969181f/codex-rs/core/src/session/turn_context.rs#L1205) は、flag が有効かつ登録済み拡張が host discovery を要求しない場合に限り host snapshot を空にする。[Registry](https://github.com/openai/codex/blob/3b01b36fa5eb96ba82a776bd3c2fc57f8969181f/codex-rs/ext/extension-api/src/registry.rs) は contributor が無い場合も従来探索を維持し、1件でも要求すれば探索を維持する。全探索を強制停止するスイッチではない。
- [対象版 App Server の extensions](https://github.com/openai/codex/blob/3b01b36fa5eb96ba82a776bd3c2fc57f8969181f/codex-rs/app-server/src/extensions.rs#L104) は executor provider と HostSkillProvider を登録する。[SkillsExtension](https://github.com/openai/codex/blob/3b01b36fa5eb96ba82a776bd3c2fc57f8969181f/codex-rs/ext/skills/src/extension.rs) の要求判定は host provider の有無による。従って、通常 App Server で flag だけを一時指定しても、この条件は探索停止側にならない。
- [対象版 host_roots](https://github.com/openai/codex/blob/3b01b36fa5eb96ba82a776bd3c2fc57f8969181f/codex-rs/ext/skills/src/host_roots.rs) の host は project 設定層の skills、cwdからproject rootまでの祖先 `.agents/skills`、旧 user `$CODEX_HOME/skills`、home `.agents/skills`、system cache、admin 設定層の skills を含む。plugin roots と extra roots も合成する。host は user だけの意味ではなく、各 root の一時 allowlist を指定する引数もこの関数にはない。bundled system の無効化は host 全体の無効化と異なる。
- [対象版 selection](https://github.com/openai/codex/blob/3b01b36fa5eb96ba82a776bd3c2fc57f8969181f/codex-rs/ext/skills/src/selection.rs) は UserInput の skill を既存カタログの enabled entry の path と照合する。name は通常テキストの同名選択を抑制するためにも使う。任意の明示 path を独立して読み込む機構ではない。host catalog を空にするだけでは、選択した host skill の読み込みも成立しない。
- [対象版 CLI override](https://github.com/openai/codex/blob/3b01b36fa5eb96ba82a776bd3c2fc57f8969181f/codex-rs/utils/cli/src/config_override.rs) に `-c key=value` は存在し、App Server もこれを解析する。一時 `-c features.skip_host_skill_discovery=true` は指定可能な設定候補だが、前述の provider 登録条件を変更しない。[skills_config](https://github.com/openai/codex/blob/3b01b36fa5eb96ba82a776bd3c2fc57f8969181f/codex-rs/config/src/skills_config.rs) の規則は個別 name/path の enable/disable で、名前の比較は完全一致。列挙済みの未選択項目を disable しても、後から発見した別項目を既定で拒否する排他契約にならない。include_instructions=false は自動説明の抑制であり discovery の拒否と読み替えない。

現在 main の固定 commit でも、[App Server の host provider 登録](https://github.com/openai/codex/blob/2351d9e1b608e6f9d9a3699b71d7eb39ee41cfa4/codex-rs/app-server/src/extensions.rs#L104)、[条件付き snapshot 省略](https://github.com/openai/codex/blob/2351d9e1b608e6f9d9a3699b71d7eb39ee41cfa4/codex-rs/core/src/session/turn_context.rs#L1301)、[カタログ内の明示選択](https://github.com/openai/codex/blob/2351d9e1b608e6f9d9a3699b71d7eb39ee41cfa4/codex-rs/ext/skills/src/selection.rs) を確認した。executor 側の selected capability root や拡張 contributor の差替えは Rust の内部構成として存在するが、生成した通常 App Server protocol の skill 入力・一時 config が、この内部構成を selected-only に置換できるという契約は確認できなかった。

取得したソースの SHA-256（一時診断ファイルのみ。raw 本文をリポジトリへ保存していない）:

| commit    | ファイル                         | SHA-256                                                            |
| --------- | -------------------------------- | ------------------------------------------------------------------ |
| `3b01b36` | app-server/src/extensions.rs     | `e097740f3c33cf84456283ea59a4409e48e10c00d61937604e9fe6474e3ef518` |
| `3b01b36` | ext/skills/src/host_roots.rs     | `d4290ba4d783110e7533586ad19719536aa9b23f517b43e3147d3afb40c91d56` |
| `3b01b36` | ext/skills/src/selection.rs      | `383245c7d4eec13fb696e137e3aaa83287fa7a86cbfa1ed0cd12eb749e05936e` |
| `2351d9e` | app-server/src/extensions.rs     | `e097740f3c33cf84456283ea59a4409e48e10c00d61937604e9fe6474e3ef518` |
| `2351d9e` | core/src/session/turn_context.rs | `5ce135ccff57da72561deac0f6b65cc196917b50df78eebf6bfb5c1408a3b803` |
| `2351d9e` | ext/skills/src/extension.rs      | `9b1a0fdbe7e8ec6e34ea58060517675925b1976e6660478a1fefb66168c05a2c` |

追加調査の判断: この flag を製品へ有効化するだけでは selected-only 契約は成立しない。既存 STOP を維持し、未使用 helper や不完全な native 実行を追加しない。必要な次の根拠は、標準 App Server が host/extra/plugin/bundled discovery を排他的に制限しつつ選択分だけ供給する公開契約、または当該 provider 構成を公式に差し替える契約である。その契約と対象版を確定した後で、モデルなしの合成 root を使った失敗側の discovery 検証と対象 Windows 検証が必要となる。今回のコード推論をその実試験の成功と扱わない。

## 公式一次資料

[公式 skills 資料](https://learn.chatgpt.com/docs/build-skills) の「Where Codex loads local skills」は repository の cwd から repository root までの祖先、user、admin、system の探索を説明している。同名 skill の選択だけを排他制御と読み替えない。

同資料の「Enable or disable local Codex skills」と [公式 Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference) は `skills.config` を config.toml に保存する per-skill enablement と説明する。今回これを変更せず、skills/config/write、設定ファイル編集、HOME/CODEX_HOME の差し替えを行っていない。

## 検証と残課題

[直接関連テスト](../src/main/workflow/official/codex.test.ts) で plan/implement/fix/review の選択付き request が固定診断、App Server 起動 0、RPC 0、モデル dispatch 0 となり、要求メタデータだけを保持することを確認する。取消済み選択にも同じ境界を追加検証する。空の選択は通常 text 入力で実行する既存 mock テストを維持する。直接関連 84 件が成功した。型・lint・format・差分と内部リンクの確認も成功した。追加ソース調査では製品コードとテストを変更せず、実モデル・実 App Server・Windows を実行していない。

実装を進めるための残条件は、対象 CLI で全探索元を排他的に制限する公式の一時契約と、その実効性・変更/再読込時の挙動の確認である。明示 SkillUserInput の存在、skill name/path の一致、利用量や初期化成功だけでは足りない。対象 Windows と実モデルの skill 使用・完了は未確認のまま。
