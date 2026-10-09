# XHarness 文書索引

## 文書の役割と正本

| 探す内容                                 | 正本・入口                                                     |
| ---------------------------------------- | -------------------------------------------------------------- |
| Why：背景・目的・利用者の意図            | [Requirements.md](Requirements.md)                             |
| What：検証可能な要件、振る舞い、受入条件 | [Spec.md](Spec.md) と各機能Spec                                |
| How：構造・責務・設計判断                | [全体設計](design/Architecture.md) と各機能design              |
| 実装/検証/バグの時点記録                 | [report索引](report/README.md) と各機能report                  |
| 原則・スコープ・変更ガバナンス           | [AGENTS.md](../AGENTS.md)                                      |
| 操作・開発・配布手順                     | [開発案内](development.md)、[配布README](../release/README.md) |
| 過去の仕様/設計・退役実装                | [Old索引](../Old/README.md)                                    |

ファイル名は `Requirements.md` と `Spec.md` です。root `SPEC.md`・`DESIGN.md`・`FEATURES.md` は互換移転案内で、別の正本ではありません。

## 機能別

| 機能       | 要求                            | 要件・仕様・受入条件     | 設計                                   | 記録                                |
| ---------- | ------------------------------- | ------------------------ | -------------------------------------- | ----------------------------------- |
| 作業実行   | [Why](workflow/Requirements.md) | [What](workflow/Spec.md) | [How](workflow/design/Architecture.md) | [report](workflow/report/README.md) |
| 会話・保存 | [Why](sessions/Requirements.md) | [What](sessions/Spec.md) | [How](sessions/design/Architecture.md) | [report](sessions/report/README.md) |
| スキル     | [Why](skills/Requirements.md)   | [What](skills/Spec.md)   | [How](skills/design/Architecture.md)   | [report](skills/report/README.md)   |

システム⊃サブシステム⊃機能の階層を認めますが、現規模ではサブシステムの独立文書層を増やしません。共通runtime・配布・横断非機能は全体Spec/designへ、個別状態/APIは機能Specへ集約します。

## 実装と検証の読み方

実装済み、限定検証済み、未実装、対象環境で未検証を分けます。報告は対象revision・環境・実行範囲を持ち、過去の実機成功を現在の成功と扱いません。未来の計画は現行の要件/仕様へ自動昇格しません。

## 配置を維持する資料

- [examples](examples) は既存テストが読むfixture/例。文書整理で移動しません。
- [紹介資料](presentations/20261008/README.md) は生成物・表示用資料で、仕様の正本ではありません。
- [検証ログ](verification-20261009) は時点の証拠資産。対応するreportから参照し、再実行とは扱いません。

## 今回の再構成

[整理・整合性報告](report/documentation-layout-20261009.md)、[移動対応](report/documentation-layout-20261009/moves.tsv)、[変更一覧](report/documentation-layout-20261009/changes.tsv)を参照してください。
