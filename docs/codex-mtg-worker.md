# Codex MTG 専用worker

既存TSA Bridgeを変更せず、Windowsのログイン中に専用workerを動かします。Node.js 22以上、既存Codex CLIログイン、GitHubへのgitアクセスが必要です。npmの追加依存はありません。

管理画面でこの端末専用のキーを発行し、`%LOCALAPPDATA%/TSG Codex MTG/worker.config.json` に安全に保存します。実際のキーをChat、コマンド引数、Git、ログへ貼り付けないでください。必須項目は `url`（`https://v0-line-blush.vercel.app`）、`token`（発行した接続キー）、`pcName`（登録PC名）です。任意で `codexPath`、`codexHome`、`workspaceRoot`、`repositories:[{name,url}]` を設定できます。repoは管理者が確認した `https://github.com/hajiox/...` に限定され、既定はTSGです。依頼本文からrepo URLや起動コマンドを受け付けません。

```powershell
& .\scripts\install-codex-mtg-worker.ps1 -NoStart
node "$env:LOCALAPPDATA\TSG Codex MTG\worker.mjs" --check
node "$env:LOCALAPPDATA\TSG Codex MTG\worker.mjs" --probe --probe-ms 30000
& .\scripts\install-codex-mtg-worker.ps1
```

`--check` はローカル設定・既存モデル指定・CLI・Skillの存在だけを確認します。`--probe` は機械の認証とRealtime購読だけを確認し、claim・AI起動・投稿を行いません。購読後 `--probe-ms`（0〜60000、既定15000）だけ待ち、接続確認と購読回数・空wake受信回数だけを表示します。本文やキーは表示しません。installerは既存の専用workerが稼働していれば停止・上書きせず終了します。現在ユーザーのStartupフォルダーに `TSG Codex MTG.lnk` を置き、本人ログイン時にWindows PowerShell 5から非表示で起動します。`-NoStart` は配置・検証だけ、通常のインストールは同じ絶対パスを使って直接非表示で起動します。停止中の旧 `TSG Codex MTG Worker` タスクだけを削除し、TSAの既存タスクには触れません。workerの単一プロセスlockを維持します。既存の統合モニタの `states/tsg-codex-mtg.json` を使い、別のモニタウィンドウを作りません。

実際の通知確認には `--probe-wake` を使います。既定30秒以内に空wakeを受信すれば直ちに回数だけを返して成功し、届かなければ `ok:false` / `wakeCount:0` と終了コード1を返します。確認中に管理者が明示許可した開設案内を投稿する方法なら、テスト専用投稿を追加する必要はありません。

Realtimeの `codex-mtg-v1` / `wake` は空の通知、またはSupabaseが自動追加するUUIDの `id` だけを持つ通知を受け取ります。それ以外のフィールド・本文・個人情報・ジョブIDは受理しません。通知のidは起床の合図にしか使わず、起動・再接続時と通知時に認証APIからclaimします。通知断に備えて2分ごとに回収し、同時ジョブは1件だけです。サーバーの180秒leaseを30秒ごとに更新します。leaseが不明になったら自分のCodexプロセスを停止し、コード変更を自動再実行しません。

APIが401/403を返した場合は認証対応待ちとし、以後のAPI呼出・Realtime再接続を止めます。モニタは `waiting_for_user` を表示し、登録とキーを確認した管理者による手動再起動が必要です。通常の通信断は2分の回収処理で復旧を試みます。設定・CLIなどのエラーでworkerが非0終了した場合、ランチャーは15秒ごとの再起動を行わず終了します。

Startupのランチャーは、インストール時に検証したNode実行ファイルの絶対パスを使います。起動時の `--check` はAPIやジョブを呼びません。起動に失敗した場合は専用フォルダの `startup-status.json` で固定の処理段階・Node終了コード・例外の型だけを確認できます。設定・秘密・依頼本文・CLI出力は保存せず、前回の状態を上書きします。Nodeの配置が変わった場合は、workerを停止した状態で再インストールしてください。

コード編集は実hostname・登録PC名がともに `TSA`、サーバーの `canExecuteCode` がtrue、human originかつ `allowCodeChange` がtrueの場合だけです。他PCやCodex-originは `read-only` sandboxと明示した `approval_policy="never"` で動き、書込権限へ切り替えません。`--ignore-user-config` でユーザー共通のMCP等の実行設定を読み込まず、アプリ/プラグインも無効にします。既存 `CODEX_HOME/config.toml` からトップレベル `model` と、Windowsの場合は既存 `[windows] sandbox="elevated"` だけを取り出して起動引数へ明示します。モデル未設定・不正、Windowsでelevatedが未設定の場合は推測せず起動を止め、別sandboxへ自動fallbackしません。設定ファイル・ACL・sandbox setupは変更せず、同じ `CODEX_HOME` を渡すため既存ログインを使います。AGENTS.md・Skillsは有効です。コード改修はhigh、読取専用はmediumです。

各ジョブは新しい `codex exec --ephemeral` を使い、対象repoを最新既定branchからfreshcloneして一致・cleanを検証します。コード改修では秘密なしの専用Skill本文だけを、そのジョブの `.agents/skills/tsg-codex-mtg/SKILL.md` へコピーして参照します。コピー先はworkspaceの権限を継承し、秘密設定フォルダのACLを広げたり、設定・キー・journalをコピーしたりしません。読取専用ではworkerが固定の専用Skillパスから読み込んだ本文をpromptへ直接渡し、Skillの再読取りを要求しません。本文は16KiB以内のstrict UTF-8に限定し、秘密キー形式やNULを含むものは起動前に拒否します。提案評価にrepo証拠が必要で読取りを拒否された場合は `needs_operator` とし、権限を緩めたり根拠を推測したりしません。

TSGは入口とし、TSA/DocScannerが固定allowlistに未登録なら対象追加待ちを明示して止まります。直近50投稿から該当依頼の周辺最大10件・12000文字だけを引用資料として使い、scopeや実行権限を増やしません。依頼本文やCLI stdout/stderrをログ・モニタへ保存しません。専用キーなどの秘密を子プロセス環境へ渡しません。

`job-state.json` は秘密leaseを含むため、private設定と同じアクセス制限で扱います。実行途中に再起動した場合は `needs_operator` のまま止まり、同じAI作業を再開しません。送信待ちの完了結果が残る場合だけ、同じjob/lease/status/summaryで完了APIへ再送します。状態不明・期限切れ・CONFLICTは管理者がクラウドのジョブとfreshclone内の変更を確認して処置します。確認前にjournalや作業cloneを消さないでください。

検証は `node --test scripts/codex-mtg-worker.test.mjs`。実ジョブや本番投稿を使わず、PC境界、秘密の除外、Realtime再接続、重複wake、lease不明、完了再送を確認します。

起動フラグはこのPCの公式CLI helpで確認しています。Realtimeは[Supabase公式protocol](https://supabase.com/docs/guides/realtime/protocol)のJSON v1.0.0を使います。現在のアプリChatへの自動dispatchや履歴再開には依存しません。
