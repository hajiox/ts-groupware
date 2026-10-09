# TSG scoped business API / MCP

2026-10-07。外部CodexへアプリソースやDB・既存Bridgeの鍵を配布せず、許可した業務操作だけを提供する。

## 利用開始

役員として通常のLINE認証でログインし、管理 → 外部Codex接続を開く。本人が所属する掲示板、必要な操作、有効期間（最大90日）を選んでキーを発行する。初期版は役員本人の代理接続に限定し、役員権限・承認状態を失うとその接続も利用できない。

キーは発行時だけ表示する。DBにはSHA-256ハッシュのみ保存する。紛失したキーは再表示できないため、接続を失効して再発行する。接続は同時に20件、許可掲示板は20件、1回の一覧は最大20件。

外部へ渡す配布物は `integrations/tsg-mcp` のみ。このフォルダー内で `npm ci --omit=dev --ignore-scripts` を実行し、Node.js 20.19以上で `src/server.mjs` をSTDIO起動する。専用キーはホストの環境変数 `TSG_DATA_API_TOKEN` に渡す。付属の設定例・Skillに秘密は含めない。待受ポート、アプリソース、GitHub/Vercel権限、Supabase鍵、旧 `TSG_INTEGRATION_SECRET` は不要。

## HTTPS契約

`POST https://v0-line-blush.vercel.app/api/data/v1/execute`

専用キーを `Authorization: Bearer <専用キー>` に指定する。Cookie・旧BridgeキーはこのAPIの認証として受け付けない。JSON本文は32KiB以内、不正UTF-8と未知の項目を拒否する。

```json
{"operation":"boards.list","input":{"limit":10}}
```

成功は `{ "ok": true, "data": {}, "requestId": "UUID" }`。失敗は `{ "ok": false, "error": { "code": "FORBIDDEN", "message": "..." }, "requestId": "UUID" }`。応答はno-store。

| operation | input | 追加指定 |
| --- | --- | --- |
| boards.list | query?, limit? | なし |
| posts.search / knowledge.search / tasks.search | group_id?, query?, limit? | なし |
| posts.get / knowledge.get / tasks.get / drafts.get | id | なし |
| drafts.list | group_id?, limit? | なし |
| drafts.create | group_id, content | idempotencyKey |
| drafts.update | id, content | idempotencyKey, expectedVersion |
| tasks.complete | id | idempotencyKey, expectedVersion |
| posts.publish.prepare | id | idempotencyKey, expectedVersion |
| posts.publish.commit | id | idempotencyKey, expectedVersion, confirmationId |

`query` は256文字以内、`content` は空白のみ不可・4000文字以内、NUL不可。IDはUUID、`limit` は1〜20で接続上限以下。冪等キーは `[A-Za-z0-9:_-]` の8〜128文字。versionは読取結果の文字列をそのまま使用する。

knowledgeは独立したナレッジDBではなく、許可掲示板の固定投稿を指す。タスクは接続本人の担当だけ。下書きは同じ本人でも接続ごとに分離する。通常掲示板（フロアを含む）の本文と限定したメタデータだけを返し、DM・添付ファイル・給与・勤怠・休暇・人事・権限管理は公開しない。タスク更新は未完了タスクの完了だけで、再割当て・再開は扱わない。

## 下書きと公開

1. `drafts.create/update` で下書きを保存する。この時点で掲示板へ投稿しない。
2. 最新versionを取得し、`posts.publish.prepare` で公開内容を準備する（`requiresApproval: false`）。
3. Codex が投稿先・本文・差分を利用者の依頼と照合する。利用者への追加確認や管理画面での承認は不要。
4. 接続元が同じ下書きID・version・confirmationIdで `posts.publish.commit` を呼ぶ。

準備した内容は10分間有効。接続・掲示板・本文・versionに結び付ける。既存の未承認・承認済み準備も期限内なら確定できる。承認者の記録は捏造しない。差分変更、期限切れ、所属・権限取消、キー失効をサーバーで再検証する。MCP・外部APIに承認操作はない。公開は新規投稿のみで、Push・メンション・FAX・メールを暗黙に送信しない。画像等の添付も扱わない。

更新は同じ処理に同じ冪等キーと入力を使う。別内容でキーを再利用すると409。CAS不一致も409で、再取得して差分確認が必要。アダプターは自動再送しない。不明な応答の後に新しいキーで同じ更新を重複実行しない。

## 権限・監査

接続は操作名ごとのscopeと許可掲示板を持つ。毎回、現在の役員権限・承認状態・所属をDBトランザクション内で確認する。失効と更新を同じ接続の行ロックで直列化する。SQL、テーブル、列名、シェル、任意ファイルパスを入力として受け付けない。

管理画面と管理APIは署名付き本人セッション・保存されたexecutive role・同一Originを必須とする。接続作成、失効（旧公開承認APIは互換性のため残すが不要）はその接続の発行者本人だけが行う。監査は接続ID、本人ID、requestId、操作、時刻、変更前後の実際の対象値を保存する。秘密・トークンハッシュは履歴表示へ出さない。読取の検索文字列や本文全体を操作ログへ複製しない。DB拒否の生例外を外部へ返さない。

`gw_data_*` テーブルとRPCはservice_role専用。対象既存テーブルの匿名アクセス、および匿名公開されていた強更新RPCも閉じる。通常画面は認証APIからservice_roleで動作し、既存TSG君・DocScanner・TSA連携は既存の正当な認証経路を維持する。添付削除等の旧APIを新MCPへ追加する場合は、別途その対象所有権を検証すること。

## 導入・検証

- migrations: `supabase/migrations/202610070001_scoped_data_api.sql`, `supabase/migrations/202610090001_data_publish_no_approval.sql`
- HTTP: `pnpm test:data-api-http`
- 認証: `pnpm test:session-security`, `pnpm test:user-role-security`, `pnpm test:reaction-access`
- DB: migration適用済みDBに `scripts/test-data-api.sql` を実行（合成fixtureのみ、全てROLLBACK）
- MCP: `integrations/tsg-mcp` で `npm ci --ignore-scripts` → `npm test`
- 必須: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm build`

Vercelのproduction/previewに別々の暗号学的乱数 `SESSION_SIGNING_SECRET`（32文字以上）が必要。ローカル環境にも独立した値を設定する。署名なしの旧UUID/v2 Cookieは移行しない。反映後、利用者は通常LINEまたは正当な登録端末の認証で再ログインする。

本番確認で実際の投稿公開やタスク完了を試す場合は、その操作の明示的な承認が必要。通常の疎通は短期の検証接続と非公開下書きで行い、終了後にキーを失効する。公開成功・強更新の正系はROLLBACKする合成fixtureで確認できる。
