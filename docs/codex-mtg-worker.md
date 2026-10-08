# Codex MTG 専用worker

既存TSA Bridgeを変更せず、Windowsのログイン中に専用workerを動かします。Node.js 22以上、既存Codex CLIログイン、GitHubへのgitアクセスが必要です。npmの追加依存はありません。

管理画面でこの端末専用のキーを発行し、`%LOCALAPPDATA%/TSG Codex MTG/worker.config.json` に安全に保存します。実際のキーをChat、コマンド引数、Git、ログへ貼り付けないでください。必須項目は `url`（`https://v0-line-blush.vercel.app`）、`token`（発行した接続キー）、`pcName`（登録PC名）です。任意で `codexPath`、`codexHome`、`workspaceRoot`、`repositories:[{name,url}]` を設定できます。repoは管理者が確認した `https://github.com/hajiox/...` に限定され、既定はTSGです。依頼本文からrepo URLや起動コマンドを受け付けません。

```powershell
& .\scripts\install-codex-mtg-worker.ps1 -NoStart
node "$env:LOCALAPPDATA\TSG Codex MTG\worker.mjs" --check
node "$env:LOCALAPPDATA\TSG Codex MTG\worker.mjs" --probe --probe-ms 30000
Start-ScheduledTask -TaskName 'TSG Codex MTG Worker'
```

`--check` はローカル設定・既存モデル指定・CLI・Skillの存在だけを確認します。`--probe` は機械の認証とRealtime購読だけを確認し、claim・AI起動・投稿を行いません。購読後 `--probe-ms`（0〜60000、既定15000）だけ待ち、接続確認と購読回数・空wake受信回数だけを表示します。本文やキーは表示しません。installerは既存の専用workerが稼働していれば停止・上書きせず終了します。Scheduled Taskは本人ログイン時に非表示で起動します。既存の統合モニタの `states/tsg-codex-mtg.json` を使い、別のモニタウィンドウを作りません。

実際の通知確認には `--probe-wake` を使います。既定30秒以内に空wakeを受信すれば直ちに回数だけを返して成功し、届かなければ `ok:false` / `wakeCount:0` と終了コード1を返します。確認中に管理者が明示許可した開設案内を投稿する方法なら、テスト専用投稿を追加する必要はありません。

Realtimeの `codex-mtg-v1` / `wake` は空の通知だけを受け取ります。通知には本文・個人情報・ジョブIDを含めず、起動・再接続時と通知時に認証APIからclaimします。通知断に備えて2分ごとに回収し、同時ジョブは1件だけです。サーバーの180秒leaseを30秒ごとに更新します。leaseが不明になったら自分のCodexプロセスを停止し、コード変更を自動再実行しません。

コード編集は実hostname・登録PC名がともに `TSA`、サーバーの `canExecuteCode` がtrue、human originかつ `allowCodeChange` がtrueの場合だけです。他PCやCodex-originは `read-only` sandboxです。`--ignore-user-config` でユーザー共通のMCP等の実行設定を読み込まず、アプリ/プラグインも無効にします。既存 `CODEX_HOME/config.toml` のトップレベル `model` だけを取り出し、その値を `--model` で明示して選択を保持します。モデル未設定・不正時は推測せず起動を止めます。設定ファイルは変更せず、同じ `CODEX_HOME` を渡すため既存ログインを使います。AGENTS.md・Skillsは有効です。コード改修はhigh、読取専用はmediumです。各ジョブは専用Skillと新しい `codex exec --ephemeral` を使い、対象repoを最新既定branchからfreshcloneして一致・cleanを検証します。TSGは入口とし、TSA/DocScannerが固定allowlistに未登録なら対象追加待ちを明示して止まります。直近50投稿から該当依頼の周辺最大10件・12000文字だけを引用資料として使い、scopeや実行権限を増やしません。依頼本文やCLI stdout/stderrをログ・モニタへ保存しません。専用キーなどの秘密を子プロセス環境へ渡しません。

`job-state.json` は秘密leaseを含むため、private設定と同じアクセス制限で扱います。実行途中に再起動した場合は `needs_operator` のまま止まり、同じAI作業を再開しません。送信待ちの完了結果が残る場合だけ、同じjob/lease/status/summaryで完了APIへ再送します。状態不明・期限切れ・CONFLICTは管理者がクラウドのジョブとfreshclone内の変更を確認して処置します。確認前にjournalや作業cloneを消さないでください。

検証は `node --test scripts/codex-mtg-worker.test.mjs`。実ジョブや本番投稿を使わず、PC境界、秘密の除外、Realtime再接続、重複wake、lease不明、完了再送を確認します。

起動フラグはこのPCの公式CLI helpで確認しています。Realtimeは[Supabase公式protocol](https://supabase.com/docs/guides/realtime/protocol)のJSON v1.0.0を使います。現在のアプリChatへの自動dispatchや履歴再開には依存しません。
