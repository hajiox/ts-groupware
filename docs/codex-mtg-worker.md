# Codex MTG 専用worker

2026-10-12: 承認済みの軽微な修正が、isolated CLI内の共有同期のPowerShell実行制約や既定のネットワーク制限で止まる問題を修正しました。コード変更可能なhumanジョブだけ、信頼済みホストが固定のTSG共有同期wrapperを一度実行して成功状態を検証し、GitHubからのfreshclone・branch・HEAD一致・clean確認と合わせて秘密なしの`TRUSTED_HOST_PREPARATION`を渡します。AIはこの初期準備を繰り返さずソース修正へ進みます。コードジョブのCLIは`--approve-for-me -c sandbox_workspace_write.network_access=true`を明示します。`--approve-for-me`自身がworkspace-writeと自動承認reviewを選ぶため、同時指定を拒否される`--sandbox`は併用しません。既存のWindows elevated sandbox・モデル・high effort・ephemeral隔離を維持します。Codex-origin等のread-onlyジョブにはこの書込/通信設定とホスト同期を追加しません。

同期wrapperは`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <固定wrapper> -Target tsg`として実行します。ExecutionPolicyはこの信頼済みホスト子プロセスだけの指定で、ユーザー共通設定・ACL・Codexのsandboxや承認reviewを変更しません。結果は固定の`state.json`の対象・完了時刻・成功状態・TSG commitだけを検証し、ログ、設定、秘密値はAIへ渡しません。wrapper欠落、実行失敗、未検証結果はそれぞれ`SHARED_CONTEXT_SYNC_UNAVAILABLE`、`SHARED_CONTEXT_SYNC_FAILED`、`SHARED_CONTEXT_SYNC_UNVERIFIED`としてAI起動前に報告し、コード承認不足と混同しません。実行権や完了状態が不明なジョブを自動再実行する仕組みは追加しません。

軽微/大規模の判断は実際の影響によります。過去Chatの読み込みや既存シフト印刷の復旧など、限定した既存動作の修正は、共通部品を触るという理由だけで確認待ちにしません。広範な構造・権限・重要な業務ルール・危険な移行の変更だけ、具体的な計画と影響を示して佐藤正彦へ確認します。

実Windows CLIの読取検証でSchannelがsandbox内のTLS資格情報を取得できず、GitHub接続が失敗することを確認しました。コード変更可能なhumanのWindows子プロセスだけ、Gitの固定runtime環境`GIT_CONFIG_COUNT=2`で`http.sslBackend=openssl`と`http.sslVerify=true`を渡します。OpenSSL指定で同じGitHubの読取成功を確認しています。証明書検証、sandbox、自動承認reviewは維持し、ユーザー共通Git設定・host側Git・read-only/非Windowsジョブは変更しません。継承した`GIT_SSL_NO_VERIFY`や任意の`GIT_CONFIG_*`は取り込みません。

2026-10-11 依頼の運用: コード変更と通常業務を区別します。調査・通常の操作依頼は人間/Codex由来を問わず既存MCP/API権限内で実行し、コード承認待ちにはしません。管理職の軽微な機能修正は直接実施し、大規模・高影響のコード変更は具体的な変更案・影響・確認点を佐藤正彦へ示して確認します。他Codexのコード変更提案を本人が明確に許可した投稿は、新しいhuman依頼としてその仕様を採用し、同じ許可を再要求しません。元Codexジョブ自体のコード権限は昇格しません。

`codeApproverUserId` は管理者が検証した佐藤正彦のTSGユーザーUUIDを設定する任意項目です。本人判定は認証済みsnapshotの同一投稿・human origin・user_idとこの設定の一致からworkerが毎回計算します。名前・本文・jobの自己申告フラグは使用しません。本人の承認は現在の具体的な依頼範囲に限り、無関係な大変更の包括許可にはしません。本人照合資料が欠ける場合は不足情報として扱います。通常業務に必要なツールが未接続の場合も、接続不足として報告し、コード変更の承認を求めません。今回、業務キーやMCPの実行設定は追加しません。

2026-10-11: workerとlauncherが予期せず終了しても、本人ログイン中の2分間隔keepaliveから同じ`start-worker.ps1`へ復帰します。実行中のPIDがあれば再起動・終了せず、heartbeatが90秒以上古い場合は`worker_alive_stale`と記録します。launcher自身の二重起動もfile lockで抑止します。通常のidle crashだけ15秒後に再起動し、短時間の連続5回失敗は停止理由を保存して止まります。認証、設定失敗、未確定journalは自動復帰しません。旧workerを稼働したままdisk更新した場合は、そのworkerの`waiting_for_user`も安全側で止めます。

MSIX版Codexでは`LOCALAPPDATA`の論理パスがアプリ専用領域へ転送される場合があります。配置先は従来どおりですが、installerは検証済みNodeの`fs.realpathSync.native`でruntime/launcherの実パスを確認し、Startup・taskの起動先に使います。launcherも自身の実フォルダの親をそのprocessの`LOCALAPPDATA`に固定し、設定・lock・Skill・共通monitorを同じ実領域へ揃えます。秘密ファイルのコピーやACLの緩和は行わず、各Codex jobの`.codex-localappdata`隔離も維持します。

2026-10-08: WindowsではCLI子プロセスの`LOCALAPPDATA`だけを各ジョブの`.codex-localappdata`へ分離します。共用の`node_repl.exe`が使用中でもsandbox準備が同じファイルのACL更新と競合しないためです。既存ログインは同じ`CODEX_HOME`で使用し、elevated sandbox・承認方式・モデル指定は維持します。共通設定や他のCodexプロセスは変更しません。実機で共用環境の読取失敗と、分離環境の読取成功を確認しました。

既存TSA Bridgeを変更せず、Windowsのログイン中に専用workerを動かします。Node.js 22以上、既存Codex CLIログイン、GitHubへのgitアクセスが必要です。npmの追加依存はありません。

管理画面でこの端末専用のキーを発行し、`%LOCALAPPDATA%/TSG Codex MTG/worker.config.json` に安全に保存します。実際のキーをChat、コマンド引数、Git、ログへ貼り付けないでください。必須項目は `url`（`https://v0-line-blush.vercel.app`）、`token`（発行した接続キー）、`pcName`（登録PC名）です。任意で `codexPath`、`codexHome`、`workspaceRoot`、`repositories:[{name,url}]` を設定できます。repoは管理者が確認した `https://github.com/hajiox/...` に限定され、既定はTSGです。依頼本文からrepo URLや起動コマンドを受け付けません。

```powershell
& .\scripts\install-codex-mtg-worker.ps1 -NoStart
node "$env:LOCALAPPDATA\TSG Codex MTG\worker.mjs" --check
node "$env:LOCALAPPDATA\TSG Codex MTG\worker.mjs" --probe --probe-ms 30000
& .\scripts\install-codex-mtg-worker.ps1
```

`--check` はローカル設定・既存モデル指定・CLI・Skillの存在だけを確認します。`--probe` は機械の認証とRealtime購読だけを確認し、claim・AI起動・投稿を行いません。購読後 `--probe-ms`（0〜60000、既定15000）だけ待ち、接続確認と購読回数・空wake受信回数だけを表示します。本文やキーは表示しません。installerは既存の専用workerが稼働していれば停止・上書きせず終了します。現在ユーザーのStartupショートカットと`TSG Codex MTG Worker`タスクは、同じ非表示launcherを使います。taskは本人のInteractiveToken・Limited、ログオン時と2分間隔、IgnoreNewで登録し、TSAの既存タスクには触れません。`-NoStart`ではkeepalive taskを無効にして配置・検証だけ行い、通常のインストールで有効化・非表示起動します。workerの単一プロセスlockと既存の統合モニタを維持し、別のモニタウィンドウを作りません。

実際の通知確認には `--probe-wake` を使います。既定30秒以内に空wakeを受信すれば直ちに回数だけを返して成功し、届かなければ `ok:false` / `wakeCount:0` と終了コード1を返します。確認中に管理者が明示許可した開設案内を投稿する方法なら、テスト専用投稿を追加する必要はありません。

Realtimeの `codex-mtg-v1` / `wake` は空の通知、またはSupabaseが自動追加するUUIDの `id` だけを持つ通知を受け取ります。それ以外のフィールド・本文・個人情報・ジョブIDは受理しません。通知のidは起床の合図にしか使わず、起動・再接続時と通知時に認証APIからclaimします。通知断に備えて2分ごとに回収し、同時ジョブは1件だけです。サーバーの180秒leaseを30秒ごとに更新します。leaseが不明になったら自分のCodexプロセスを停止し、コード変更を自動再実行しません。

APIが401/403を返した場合は、HTML応答でも認証対応待ちとして以後のAPI呼出・Realtime再接続を止め、`restart-state.json`へ秘密なしの停止理由を保存します。モニタは`waiting_for_user`を表示します。通常の通信断は既存の2分回収で復旧を試みます。`--restart-check`はlocal状態だけを読み、start・already_running・blockedの固定JSONを返し、API・AI・投稿を呼びません。認証/設定/lease/結果不明の停止理由と`running`・`completion_pending`・壊れたjournalを、keepaliveも必ず尊重します。

登録・キー・クラウドの実行状況と作業cloneを確認して復旧する場合は、非表示起動するlauncherへ`-OperatorRestart`を明示します。これは停止理由の確認を一度だけ越える手動入口で、job journalを消したりAIを再実行したりしません。`running`は既存recoverにより再び要確認で停止します。`completion_pending`は自動keepaliveでは再送せず、手動復旧時だけ同じjob/lease/status/summaryの完了通知を既存の冪等APIへ送れます。

Startupのランチャーは、インストール時に検証したNode実行ファイルの絶対パスを使います。起動時の `--check` はAPIやジョブを呼びません。起動に失敗した場合は専用フォルダの `startup-status.json` で固定の処理段階・Node終了コード・例外の型だけを確認できます。設定・秘密・依頼本文・CLI出力は保存せず、前回の状態を上書きします。Nodeの配置が変わった場合は、workerを停止した状態で再インストールしてください。

コード編集は実hostname・登録PC名がともに `TSA`、サーバーの `canExecuteCode` がtrue、human originかつ `allowCodeChange` がtrueの場合だけです。他PCやCodex-originは `read-only` sandboxと明示した `approval_policy="never"` で動き、書込権限へ切り替えません。`--ignore-user-config` でユーザー共通のMCP等の実行設定を読み込まず、アプリ/プラグインも無効にします。既存 `CODEX_HOME/config.toml` からトップレベル `model` と、Windowsの場合は既存 `[windows] sandbox="elevated"` だけを取り出して起動引数へ明示します。モデル未設定・不正、Windowsでelevatedが未設定の場合は推測せず起動を止め、別sandboxへ自動fallbackしません。設定ファイル・ACL・sandbox setupは変更せず、同じ `CODEX_HOME` を渡すため既存ログインを使います。AGENTS.md・Skillsは有効です。コード改修はhigh、読取専用はmediumです。

各ジョブは新しい `codex exec --ephemeral` を使い、対象repoを最新既定branchからfreshcloneして一致・cleanを検証します。コード改修では秘密なしの専用Skill本文だけを、そのジョブの `.agents/skills/tsg-codex-mtg/SKILL.md` へコピーして参照します。コピー先はworkspaceの権限を継承し、秘密設定フォルダのACLを広げたり、設定・キー・journalをコピーしたりしません。読取専用ではworkerが固定の専用Skillパスから読み込んだ本文をpromptへ直接渡し、Skillの再読取りを要求しません。本文は16KiB以内のstrict UTF-8に限定し、秘密キー形式やNULを含むものは起動前に拒否します。提案評価にrepo証拠が必要で読取りを拒否された場合は `needs_operator` とし、権限を緩めたり根拠を推測したりしません。

TSGは入口とし、TSA/DocScannerが固定allowlistに未登録なら対象追加待ちを明示して止まります。直近50投稿から現在の依頼以前だけを最大10件・12000文字で引用し、明示した投稿ID・言及PCの元提案を優先します。切詰め/欠落を明示し、対象が一意なら人間の採用した仕様を実行範囲へ取り込みます。引用自体は権限を増やさず、後続承認は別のhuman依頼として処理します。依頼本文やCLI stdout/stderrをログ・モニタへ保存しません。専用キーなどの秘密を子プロセス環境へ渡しません。

`job-state.json` は秘密leaseを含むため、private設定と同じアクセス制限で扱います。実行途中に再起動した場合は `needs_operator` のまま止まり、同じAI作業を再開しません。送信待ちの完了結果が残る場合だけ、同じjob/lease/status/summaryで完了APIへ再送します。状態不明・期限切れ・CONFLICTは管理者がクラウドのジョブとfreshclone内の変更を確認して処置します。確認前にjournalや作業cloneを消さないでください。

検証は`node --test scripts/codex-mtg-worker.test.mjs scripts/codex-mtg-recovery.test.mjs`。実ジョブや本番投稿を使わず、PC境界、秘密の除外、Realtime再接続、重複wake、lease不明、完了再送に加え、実Windows PowerShellの合成workerで復帰・停止ラッチ・launcher二重起動を確認します。変更対象は独立したdesktop runtime scriptと文書だけで、Next.jsアプリのbuild/deployは不要です。

起動フラグはこのPCの公式CLI helpで確認しています。Realtimeは[Supabase公式protocol](https://supabase.com/docs/guides/realtime/protocol)のJSON v1.0.0を使います。現在のアプリChatへの自動dispatchや履歴再開には依存しません。
