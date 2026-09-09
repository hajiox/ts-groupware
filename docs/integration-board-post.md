# TSG君 汎用掲示板投稿API

2026-09-09追加。既存の任意の掲示板へ、TSG君名義で本文を投稿するサーバー連携用API。

- URL: `https://v0-line-blush.vercel.app/api/integrations/board-post`
- 認証: `Authorization: Bearer <TSG_INTEGRATION_SECRET>` または `x-tsg-integration-secret`。
- 既存の共有連携キーを使用する。ブラウザ・公開コードへキーを置かない。MeetingTranscriber専用キーは使用不可。
- このキーを持つ信頼済み連携元は全ての既存 `type=board` 掲示板に投稿できる。社員個人のログイン権限を代行するAPIではない。DM・Chat・掲示板新設は対象外。
- 呼出し元はユーザーが指示した投稿先・本文だけを送信する。APIの利用可能性自体は投稿指示ではない。

## POST

`Content-Type: application/json; charset=utf-8`

```json
{
  "sourceKey": "codex:job-123:report:v1",
  "boardName": "TS（管理職）",
  "content": "ユーザーが送信を指示した本文"
}
```

- `boardName` または `boardId`（UUID）のどちらか一つを必須とする。名前は200文字以内の完全一致。0件は404、同名複数件は409。曖昧な名前を推測せず、掲示板IDを確認して指定する。
- `sourceKey`: 1〜200文字、英数字・`:`・`_`・`-`のみ。送信元名＋元レコードID＋用途＋版など、論理メッセージごとに安定したキーを使う。異なる掲示板への別投稿は別キーにする。
- `content`: 空白だけを除き1〜10,000 UTF-16コード単位。改行と前後の空白は変更せず保存。NUL不可。JSON全体は64KiB以下、正しいUTF-8。
- 不明なフィールドは400。投稿者変更、添付、返信、投稿編集・削除には対応しない。
- 同じキー・投稿先・本文の再試行は200と `duplicate: true`。初回は201と `duplicate: false`。同じキーで投稿先または本文が違う場合は409。掲示板IDと名前の指定を切り替えても同じ掲示板なら同一投稿として扱う。
- 決定的投稿IDと主キーの一意制約により同時送信も重複作成しない。通知は初回作成時だけ試行し、再送しない。投稿成功と端末のプッシュ受信は別で、通知の確実な配信は保証しない。
- 成功応答: `{ ok: true, duplicate, group: { id, name }, poster: { id, displayName: "TSG君" }, post: { id, group_id, user_id, content, created_at }, url }`。
- `url` は `/board/<掲示板ID>#post-<投稿ID>`。呼出し元は `ok`、投稿先、TSG君、保存本文、重複状態を確認する。
- 401: キー不正、400: 入力不正、404: 掲示板なし、409: 宛先曖昧・同一キー競合、413: 本文サイズ超過、500: サーバー設定・保存エラー。通信結果が不明な場合も同じキー・同じ本文で再試行する。

## GET（投稿しない接続確認）

同じ認証で `?boardName=<URLエンコードした完全一致名>` または `?boardId=<UUID>` を指定。
成功は200、`{ ok: true, group: { id, name }, poster: { displayName: "TSG君" } }`、`Cache-Control: no-store`。
認証401、入力400、対象なし404、同名複数409、接続・送信者不備503。投稿も通知も発生しない。

## 既存APIと検証

通常の `/api/posts` はTSG君用ではない。既存の個人DM・議事録・配送通知・FAX等の専用APIは維持し、用途別連携を汎用APIへ勝手に切り替えない。直接DB書込みによる代用はしない。

`node scripts/test-integration-board-post.cjs` はモックDBで認証、Cookie不要の経路、掲示板限定、入力、保存内容、重複・競合・同時送信、接続確認と障害を検証する。本番への試験投稿は行わない。
