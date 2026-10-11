# TSG 業務MCPの対象と契約

2026-10-11。既存の掲示板用14操作に加え、通常画面が使う認証済み業務APIを固定カタログで公開する。アプリに存在しない業務機能は追加しない。操作前の別承認フローは設けず、発行済み接続の権限と、各業務APIの現在の本人権限・所属・担当制限を毎回適用する。

## 照合結果

対象ソースは `app/api/**/route.ts`。90経路・155 HTTPメソッドのうち、通常の本人認証を使う業務54経路・98操作を登録した。登録場所は `lib/business-api/catalog.ts`、固定ハンドラーの実行は `lib/business-api/dispatch.ts`。

| 領域 | 操作数 | 主な対象 |
| --- | ---: | --- |
| users | 3 | スタッフ一覧・承認・権限・所属・削除 |
| groups | 8 | 掲示板/Chatの作成・削除・メンバー管理 |
| hr | 7 | 人事・退職・履歴書保存/読取/OCR再処理/削除 |
| attendance | 8 | 打刻修正・日次修正・個人全体メモ・確認・出力・労務士提出 |
| payroll | 12 | 社員対応・重複統合・差異/安定性/労務費・ZIP取込/解析 |
| leave | 7 | 有給・勤怠回答・付与/消化調整・忌引き申請/承認 |
| appraisals | 2 | 査定閲覧・担当割当・査定日/評価/備考/説明チェック保存 |
| pledges | 7 | テンプレート・発送/返信状況・送信・紙交付・本人誓約/PDF |
| shifts | 9 | 期間・希望・割当・確定・パターン・会社休・出力・確認通知 |
| calendar | 5 | 予定の読取/作成/更新/削除・Googleカレンダー取込 |
| posts | 5 | 投稿/返信/タスク作成・更新/固定/添付・削除・リアクション |
| chat | 7 | Chat/DM読取・送信・編集・削除・相手一覧・DM作成・未読 |
| tasks | 2 | タスク一覧/集計・完了 |
| company-messages | 4 | 全社員メッセージ・新人自動送信設定・本人非表示 |
| sales | 1 | ホームに表示するEC売上概要 |
| notifications | 8 | 通知履歴・既読・投稿/グループ通知設定・未読 |
| sos | 2 | SOS履歴/通知結果/登録件数・対応開始/完了 |
| files | 1 | 既存Drive添付アップロード |

残る36経路は認証、Cron、既存システム別integration、デバイス認証/打刻、接続キー管理、CodexMTG worker管理、Push購読/試験/端末状態、画像プロキシ、OGP等の実行基盤。専用契約を維持し、業務カタログからは呼べない。SOS receiptトークン、機器キー、Push endpoint/keys、接続キーの発行・閲覧も公開しない。

## カタログと入力

カタログに `id`、`area`、`description`、`method`、`path`、`readOnly`、`params`、`queryFields`、`bodyFields`、`actions`、`bodyMode`、`formFields`、`fileFields` を返す。`bodyFields` は現行APIの入力案内であり、項目ごとの型・必須条件・状態遷移は同じAPIハンドラーで検証する。`actions` がある操作では列挙外のactionを拒否する。actionなしで通常保存するAPI（例: 査定保存、投稿本文変更、人事更新）は省略する。

実行の入力は以下の組合せ。operation ID、path、method、moduleはサーバー固定で、任意URL/SQL/テーブル/コード/ファイルパスを受け付けない。

```json
{
  "query": { "month": "2026-10" },
  "params": {},
  "body": { "employeeId": "対象UUID", "month": "2026-10" }
}
```

これは構造例であり、実際には対象操作の契約に必要な区分だけを指定する。GETにbody/form/filesは指定できない。queryはカタログにある名前だけを受け付け、公開HTTP/MCPでは文字列で指定する。パスパラメーターは `groups.members.list` の `id` と `payroll.imports.analyze` の `batchId` のみで、どちらもUUID必須。

通常更新は `body` にJSONオブジェクトを渡す。multipart操作は `body` を使わず `form` と `files` を使う。

```json
{
  "form": { "employee_id": "対象従業員UUID" },
  "files": [{
    "field": "file",
    "name": "resume.pdf",
    "type": "application/pdf",
    "base64": "JVBERi0xLjQK"
  }]
}
```

ファイル内容は標準base64。data URL、ローカルパス、任意のダウンロードURLは不可。MCPの転送上限はファイル合計2MiB、最大5添付、JSON本文/応答3MiB。通常画面の4MB等の上限とは別の転送制約で、履歴書/ZIPの形式検証と業務上限は既存ハンドラーも適用する。大きな書類は通常画面の既存アップロードを使う。

JSON応答は `{status,body}`、PDF/Excel等は `{status,file:{name,type,base64}}`。ダウンロードも2MiB以内。Cookieや任意応答ヘッダーは返さない。大きい検索/出力は範囲や所属を絞る。

## 業務上の制約と副作用

認証済み接続の本人を同じリクエスト内コンテキストで既存ハンドラーへ渡す。ブラウザーのCookieを作らず、署名秘密や別ユーザーのセッションを要求しない。本人が担当していない査定対象、承認担当外の休暇、本人用の誓約・希望提出などは、通常画面と同じ制約を保持する。管理者の名を名乗る入力や任意user IDで本人権限を置き換えることはできない。

次のGETは既存画面の振る舞いとして副作用を持つため `readOnly:false` として説明を返す。その他の読取も通常のアクセス監査は記録する。

- `posts.list`: 掲示板の既読更新。
- `chat.messages.list`: Chatの既読更新、CodexMTG管理職メンバー同期。
- `company-messages.list`: `view:history` 以外では期限を迎えた新人配信を実行。
- `shifts.admin.list`: 選択シフトのフロア売上カレンダーを同期する場合がある。
- `calendar.events.list`: 有効なGoogle自動取込設定に基づき予定を同期する場合がある。
- `tasks.list`: 詳細表示では本人の期限切れメンション履歴を整理する。

`attendance.submission.send` は設定された労務士へ実際のメールを送る。誓約send/send_test、投稿・DM、シフト希望収集/確定等も既存の通知動作を持つ。依頼に含まれない送信/全員配信を疎通試験として実行しない。SOSはacknowledge/resolveのみ更新でき、heartbeatによる一斉再通知はカタログで拒否する。

退職は `hr.employees.update` の `action:"retire"` と `resigned_date` を使い、ユーザー削除とは区別する。新規スタッフのDocScannerからの取込は既存DocScanner integrationを保持する。TSA/DocScanner側の機能やキー管理は、このTSG業務APIで代行しない。

査定保存は `employeeId`、`month`、`assessedOn`、`status`、`version`、10項目の `ratings` と5項目の `talkChecklist` を使う。各ratingは `{score:1〜5またはnull,comment:文字列}`、完了時は全項目評価済みが必要。担当割当は `action:"assign"/"unassign"` と `reviewerId` を指定する。項目IDと版は既存査定契約をそのまま使い、更新競合時に古いversionで再送しない。

新規添付は同じ接続でアップロードしたDriveファイルのみ許可する。MCPの投稿削除は参照だけを削除し、共有される可能性があるDrive実体は保持する。カタログを追加しても既存の添付削除境界を緩めない。外部サービス側の認証・設定不足はAPIエラーとして返し、秘密情報の入力・抽出や別PCのなりすましで回避しない。

## 検証

カタログID重複、固定module対応、認証付き業務routeの対象/除外、query/UUID/action検証、multipart上限、出力形式を確認する。書込の正系は合成fixtureまたはmockで行い、実在スタッフの人事・給与・打刻・誓約・シフト・投稿を検証目的で変更しない。型検査・lint・build、接続権限/失効/冪等性・既存14操作の回帰と実MCPクライアントの一覧/読取を併せて確認する。

給与メール取込・検証履歴は payroll.mail-jobs.list で直近24件を取得する。pledges.own は古いprocessing状態の回復、leave.own/leave.admin.list/shifts.requests.list は有給付与・残高同期を伴うため、これらもreadOnly:false（副作用GET合計10件）。CodexMTG投稿は専用codex_mtg_report/requestを使い、汎用Chat経由は副作用前に403で案内する。
