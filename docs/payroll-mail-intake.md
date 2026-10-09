# 給与メールの自動取込・検証

2026-10-09。DocScannerが確認した榎田社労士の給与ZIPを、TSGの給与・勤務へ取り込む。自社の計算設定は書き換えず、結果を本人だけのTSG君DMへ報告する。

## 処理と安全な再実行

1. DocScannerが送信元・メール認証・対象月・添付原本を確認する。TSGは固定送信元 `tatuya.enokida@gmail.com` の専用認証付き要求だけ受け付ける。
2. ZIPのサイズ、中央ディレクトリ、パス、CRC、展開後上限、必須Excel、未知の値入り項目、各社員シートの給与月・勤務期間・支給日を確認する。給与0円の社員も全社人数に含め、社員別の人数・支給・控除・差引合計を全社計と照合する。
3. 取込前の自社設定を選ぶ。当月の社労士Excelから学習した設定は使わない。実打刻・承認済み有給と、既存TSGの月末時点の丸め・休憩設定で試算する。税・控除は保存済み設定による試算で、法定税額の独立した再計算ではない。
4. 原本は専用の非公開My Driveフォルダへ保存する。公開・ドメイン・グループ・接続アカウント以外のユーザー共有、権限一覧の取りこぼし、書込不可は拒否する。作成したファイルも権限を再検査する。
5. `gw_receive_payroll_mail` は給与データとDM送信待ち記録を一つのDBトランザクションで保存する。給与月のロック、同じメール・SHAの重複防止、確定済み期間の保護を行う。別のZIPが同月に登録済みなら既存値を変えず要確認にする。同じSHAの完了済み手動取込はバッチ・文書参照を移動せず再利用し、今回の受信原本は別途非公開保管する。
6. DMはサーバー設定で固定した承認済み役員「佐藤 正彦」だけに送る。既存個人DM APIの2名宛先検証と決定的な投稿IDを利用する。人数・理由の概要と役員限定の検証画面へのリンクだけを送り、個人別給与額やZIPはDMに添付しない。

設定不足、打刻不足、有給と打刻の重複は一致に数えない。勤務日数・時間の差と金額の差を区別し、差があっても社労士の計算ミスと断定しない。結果は `/admin/payroll-mail` で確認できる。一般ユーザーは給与結果を閲覧できない。

DM送信が失敗しても給与取込を取り消さない。永続的な送信待ち記録を残し、`retry_report` で報告だけを再試行する。送信結果が不明な場合も同じ投稿IDを使い、二重DMを防ぐ。DocScanner側の有限再試行終了後は取込・送信状態を保ったまま運用者による確認が必要。

## 専用API

`GET /api/integrations/doc-scanner/payroll-mail` は宛先・DB・非公開Driveフォルダの実接続と書込能力を読み取りだけで確認する。`?sourceKey=...` は完了証明を返し、未到着は404。いずれも `Authorization: Bearer` または `x-tsg-payroll-mail-secret` の専用キーが必要。同時指定した値が異なる場合は401。

通常のPOSTは厳密なJSONオブジェクトで、不明な項目を拒否する。ZIP上限3MiB、JSON上限4,300,000バイト。

```
sourceKey, messageId, attachmentId, fileName, sha256,
payrollMonth (YYYY-MM), attendanceMonth (YYYY-MM),
receivedAt (実受信日時ISO), sender, zipBase64
```

ZIP取得前の要確認は同じURLへ `status: "needs_review"`, `sourceKey`, `messageId`, `receivedAt`, `sender`, 限定された `errorCode` を送る。判明済みの添付識別・ハッシュ・年月も任意で付けられる。`source_unavailable` のみ受信日時不明を許可する。任意の報告本文・宛先は受け付けない。

報告だけの再試行は `{ "action": "retry_report", "sourceKey": "..." }`。GETは送信や取込を行わない。

初期設定専用のPOST `{ "action": "initialize_storage" }` は、同じ専用キーで認証したうえで、本番の既存Google OAuthクライアントから空の給与専用フォルダをMy Drive直下に作る。同じクライアントが作成した固定用途のappProperties付き非公開フォルダが1つあれば再利用する。名前・ID・保存先を要求側から指定できず、共有設定が所有者本人のみであることを検証する。返されたフォルダIDを運用者が `GOOGLE_PAYROLL_FOLDER_ID` に設定して再配備する。通常のGETや給与取込がフォルダを作成することはない。APIが返す障害コードは接続・権限・非公開性の分類だけで、Googleの生エラーや秘密値は返さない。

完了証明は `ok`, `status` (`imported` / `duplicate` / `needs_review`), 元の `sourceKey`, `messageId`, `sha256`, 対象年月, `batchId`, `report.status` (`sent` / `pending`), `counts`。取込未完了の要確認は `batchId: null`。比較に差や未確認者があっても、原本取込そのものが完了した場合は取込済みとして区別する。

## サーバー設定・検証

- `TSG_PAYROLL_MAIL_SECRET`: DocScanner専用の連携認証。通常のTSG共有キーやユーザーCookieは代用できない。
- `PAYROLL_MAIL_RECIPIENT_NAME`: 本人の固定宛先。設定の実名が承認済み役員1名に一致することを確認する。
- `GOOGLE_PAYROLL_FOLDER_ID`: 給与原本専用の非公開My Driveフォルダ。通常の添付フォルダへのフォールバックはない。
- 既存Google Drive認証と、内部個人DM API用の既存 `TSG_INTEGRATION_SECRET` を使う。秘密値はソース・履歴・ログに記載しない。
- 手動給与ZIPアップロードも同じ専用非公開保管関数を使う。過去ファイルの共有設定を自動で変える処理は含まない。

`pnpm test:payroll-mail`、既存 `test-labor-payroll-zip.cjs`、`test-payroll-comparison.cjs`、型検査、lintで確認。`scripts/test-payroll-mail-transaction.sql` はマイグレーションと同じ明示的BEGIN/ROLLBACK内でだけ実行し、合成社員・将来月の取込、重複、競合、手動再利用、自社設定保持、途中失敗の全体rollback、公開権限禁止を検証する。本番へ合成給与や試験DMを保存しない。
