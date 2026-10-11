# OEM相談受付のフロア通知

2026-10-10。初回のOEM見積もり相談受付だけを `NEWブランド館（フロア）` へ一報する専用API。受注確定、既存相談の一括投稿、見積更新・注文通知には使用しない。

- `POST https://v0-line-blush.vercel.app/api/integrations/oem/consultation-received`
- `Authorization: Bearer <OEM専用サービスsecret>`。TSG本番の `OEM_CONSULTATION_INTEGRATION_SECRET` とOEM本番の `OEM_TSG_NOTIFICATION_SECRET` に同じ専用値を安全に設定する。PCキー、データMCPキー、共有TSGキーは転用しない。値を掲示板・ログ・ソース・配布ZIPへ記載しない。
- JSON UTF-8、最大4,096バイト。不明なフィールドは拒否。ブラウザやクライアント公開環境へsecretを出さない。

```json
{
  "schemaVersion": 1,
  "event": "consultation_received",
  "sourceKey": "oem:consultation:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:received:v1",
  "leadId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "receivedAt": "2026-10-10T06:45:00.000Z",
  "companyName": "サンプル株式会社",
  "productName": "サンプルソース",
  "quantityLabel": "400個",
  "estimatedTotalPrice": 140000
}
```

`leadId` はUUID、sourceKeyは小文字のleadIdから上記形式で厳密に作る。受付日時は40文字以内で秒・任意小数秒・`Z`または`±HH:mm`を持つISO形式、`Date.parse`で解釈可能な値。会社・商品・数量は空白のみを除く1〜200 Unicode codepointsの表示用ラベルで、C0/C1制御文字（改行を含む）は不可。個人氏名・電話・メールなどの連絡先や相談の自由記載を送信するフィールドは設けない。概算合計は税別・試作費別の非負safe integer（円）。

2026-10-11追加：見積未算定の直接相談は `schemaVersion: 2`、`estimatedTotalPrice: null` を送る。同じ9項目で、v2の金額行は「見積：未算定（相談のみ）」。商品未定は `productName: "商品未定"`、数量未定は `quantityLabel: "未定（相談のみ）"` をOEM側で固定して送る。v1の数値・既存本文は変更せず、v1のnullとv2の数値は拒否する。

v2でもsourceKey末尾は **`:received:v1` を維持**する。これは通知識別子であり、payloadのschemaVersionとは独立する。同一受付をv1/v2へ変更して再送すると本文相違の409となる。OEM側は受付時点のversion・payloadを永続outboxへ固定し、後からversionや別キーへ変更して重複投稿しない。

投稿先UUID `d6453519-ab54-4946-9762-ed266f59cb1e` と投稿者TSG君、管理画面リンク `https://oem.aizubrandhall.com/admin/dashboard` をサーバーが固定する。本文は「相談受付」「受注確定ではありません」、日本時間の受付日時、会社・商品・数量を含む。v1は税別・試作費別の概算合計、v2は見積未算定を表示する。呼出し元による本文・URL・投稿先・投稿者指定は受け付けない。

成功は新規 `201 {"success":true,"postId":"UUID","duplicate":false}`、同一sourceKey・同一保存本文の再送は `200` と `duplicate:true`。同じキーで本文・投稿先・投稿者が相違する場合は `409`。専用namespaceの決定的UUIDとDB主キー、23505の再読込で同時再送も1投稿にする。通知は新規作成時のみ既存Pushを試行し、Push失敗でも保存済み投稿を成功として返す。端末でのPush受信を保証するものではない。

入力不正400、キー不正401、サイズ超過413、ストレージ失敗500、secret未設定503。呼出し元の永続outboxは受付時の入力・日時・sourceKeyを固定して保持し、応答不明時も同じ内容で再送する。409は自動的にキーを変えて再送しない。

同じURLの認証付き `GET` は無投稿の接続確認。クエリは不可。成功200 `{success:true,group:{id,name},poster:{id,displayName:"TSG君"}}`、宛先/送信者不備503、全応答 `Cache-Control:no-store`。本番検証に試験投稿を作らずGETを使う。

検証: `pnpm test:oem-consultation-notification` はモックDBで専用認証・厳密入力・JST本文・固定宛先/投稿者・新規/重複/競合・並行再送・Push失敗・無投稿GET・ログの非漏洩を確認する。DB migrationは不要。OEM側の永続outbox・送信・再送の導入と接続確認は別システム側で行う。
