# TSG Data MCP

TSG の限定データ API を MCP ツールとして使う、独立した STDIO アダプターです。このフォルダーだけを配布できます。TSG 本体のソース、Supabase/DB の鍵、既存 Bridge の認証情報は不要です。待受ポートは開きません。

## セットアップ

Node.js 20.19 以上を用意し、このフォルダー内で実行します。

```powershell
npm ci --omit=dev --ignore-scripts
```

TSG 管理画面で発行した、この接続専用の失効可能なキーを MCP ホストの環境変数 `TSG_DATA_API_TOKEN` に安全に設定します。キーをチャット、ツール引数、コマンドライン、設定ファイル、履歴へ貼り付けないでください。`.env` は自動読込しません。

`TSG_DATA_API_BASE_URL` の既定値は `https://v0-line-blush.vercel.app` です。この本番 HTTPS オリジンだけを許可し、別ホスト・localhost・任意パス・リダイレクトは拒否します。開発テストは HTTPS 通信をモックするため、本番キーも追加ポートも不要です。

MCP ホストから `node <インストール先>/src/server.mjs` を STDIO 起動し、上の環境変数を渡します。Codex 用の秘密なし設定例は [codex-config.example.toml](codex-config.example.toml) です。既存の設定を置き換えず、該当セクションだけを追加してパスを変更します。`env_vars` は環境変数名を指定します。[OpenAI の MCP 設定](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) に対応しています。

任意で [skills/tsg-data-mcp/SKILL.md](skills/tsg-data-mcp/SKILL.md) を利用側のスキルとして配置できます。Skill に認証情報は含めません。

## ツールと固定入力

| ツール | 操作 | 入力 |
| --- | --- | --- |
| `boards_list` | `boards.list` | `query?`, `limit?` |
| `posts_search` | `posts.search` | `group_id?`, `query?`, `limit?` |
| `posts_get` | `posts.get` | `id` |
| `knowledge_search` | `knowledge.search` | `group_id?`, `query?`, `limit?` |
| `knowledge_get` | `knowledge.get` | `id` |
| `drafts_create` | `drafts.create` | `group_id`, `content`, `idempotencyKey` |
| `drafts_update` | `drafts.update` | `id`, `content`, `idempotencyKey`, `expectedVersion` |
| `drafts_get` | `drafts.get` | `id` |
| `drafts_list` | `drafts.list` | `group_id?`, `limit?` |
| `tasks_search` | `tasks.search` | `group_id?`, `query?`, `limit?` |
| `tasks_get` | `tasks.get` | `id` |
| `tasks_complete` | `tasks.complete` | `id`, `idempotencyKey`, `expectedVersion` |
| `post_publish_prepare` | `posts.publish.prepare` | `id`, `idempotencyKey`, `expectedVersion` |
| `post_publish_commit` | `posts.publish.commit` | `id`, `confirmationId`, `idempotencyKey`, `expectedVersion` |

`knowledge_*` はピン留め投稿です。接続に許可された操作・掲示板と、TSG 側の現在の所属・権限の範囲で読み書きします。接続発行・失効は人間が TSG 管理画面で行い、MCP ツールには含めません。

`id`・`group_id`・`confirmationId` は UUID。`limit` は 1〜20、`query` は 256 文字以内で NUL 不可、`content` は空白だけでない 4000 文字以内で NUL 不可です。`idempotencyKey` は `[A-Za-z0-9:_-]` の 8〜128 文字、`expectedVersion` は空白を含まない ASCII 1〜80 文字です。更新時の version は読み取り結果の文字列をそのまま使います。未知のフィールド、任意 operation、SQL、テーブル名、列指定、シェル、ファイル操作は受け付けません。

## 公開と再試行

下書きの作成・更新では公開されません。公開は下書き取得 → `post_publish_prepare` → Codex が宛先・内容・差分を依頼と照合 → `post_publish_commit` の順です。利用者が投稿を依頼した場合、追加の承認質問や管理画面操作は不要です。commit は準備済み confirmation と同じ下書き・version を指定します。未準備・期限切れ・変更後の差分は TSG 側で拒否されます。

書き込みごとに安定した `idempotencyKey` を用意し、同じ処理を再試行する場合は同じキーと入力を使います。変更内容が異なる処理には別のキーを使います。アダプターは自動再送しません。応答が不明なときは、新しいキーで重複実行せず現在の状態を確認します。version 競合時は再取得して差分を確認します。

API は `POST /api/data/v1/execute` に固定され、認証は HTTPS の Authorization ヘッダーだけに付与されます。返却は `{ok,data,requestId}` または `{ok:false,error,requestId}`。アダプターは秘密を返却・ログから伏せ、エラーの生例外を公開しません。stdout は MCP 通信だけです。

## 検証

```powershell
npm ci --ignore-scripts
npm test
```

テストは実際の子プロセスで MCP の接続、一覧、14 ツールの呼出を確認します。HTTPS はテスト専用 preload でモックし、本番への読取・書込・公開・通知を行いません。不正スキーマ、公開確認不足、固定ホスト、秘密の伏字、JSON/サイズ/通信エラー、同一キーの保持も検証します。

2026-10-07 に公式 npm registry と [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) を確認し、公式 SDK `@modelcontextprotocol/server` / `client` 2.3.1 と Zod 4.6.5 を固定しました。利用者向け実行時依存は server と Zod のみです。
