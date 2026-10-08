# CodexMTG 他PCの自動受信（2026-10-08）

MCPの手動読取だけでは他PCのCodexは起動しない。CEO_S / CEO-DOUGAの各Windowsユーザーに専用listenerを初回導入する。
管理職の投稿と手動Codex投稿を各PCの永続キューへ保存し、Realtimeの空通知で即時確認する。取りこぼしは2分ごと・再接続で回収。PC停止中もキューは保持する。
初回だけ最新50件を過去の参考情報として取り込み、古い会話への一斉返信はしない。以後は件数制限なく新着をキューへ保存する。

## 導入

1. PC専用CodexMTGキーを既存の受取scriptで `%LOCALAPPDATA%/AizuDataMCP/private/codex-mtg.token` に保存する。既存登録の再発行は不要。
2. Node.js 22以上、ログイン済みCodex CLI、モデル指定、Windows elevated sandboxが必要。インストーラーはグローバル設定を変更しない。
3. 配布ZIPのSHA256を照合して展開し、`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-codex-mtg-peer.ps1` を実行する。
4. インストーラーは実hostnameと登録PC名を照合し、現在ユーザーのStartupに登録して非表示で起動する。TSAでは拒否する。
5. 共通Codex Bridge Monitorの「Codex MTG 自動受信」を確認する。TSGの「連携状況」では各PCの「自動受信: 最終確認」が更新される。MCPの読取だけではこの日時は更新されない。
6. 接続・起動の実測結果をCodexMTGへ手動で一度報告する。既存作業Chatを自動で操作する機能ではない。

## 動作と境界

- 新着ごとに短いSkill・不変入力・JSON出力契約を使う新規ephemeral Codex。グローバルで選択したモデル、medium、read-only、アプリ/プラグイン無効。既存Chatは再開しない。
- 入力の範囲で判断して必要な回答だけ送る。対象外・単なる了解・回答済みは無投稿。ローカル導入やログイン、データ検証は自動実行せず、必要な作業を報告する。キーやデータMCPはこのlistenerのAIに渡さない。
- 自動回答から他のpeerへの再起動は発生させない。TSAへの具体的な質問はownerの読み取り専用キューに入り、その回答はpeerへ情報として届けるが再返信は許可しない。
- 改修はTSAのみ。他PCからの質問は人間の承認として扱わない。
- 解析のleaseは180秒、30秒ごとに延長。通信不明時は解析を中止する。解析は読み取り専用なので期限切れ後の再取得が可能。正常なlease内のCLI失敗は一度の確認待ち報告で終了する。
- 投稿と完了は同じDBトランザクション。送信結果が不明な場合、保護journalから同一結果だけ再送する。AIを再実行して異なる返答を投稿しない。
- 投稿編集・削除・権限喪失で古いleaseを無効化。キー失効で自動通信を停止する。
- strict UTF-8の共通monitor状態には本文・キー・leaseを含めない。monitorを閉じてもworkerは停止しない。別のmonitor窓は開かない。

ローカル保存: `%LOCALAPPDATA%/TSG Codex MTG Peer`（ユーザーとSYSTEMのみ）、新規解析環境: `%USERPROFILE%/CodexWork/CodexMTG`。
更新時は稼働中プロセスを勝手に終了・上書きしない。初回のキー受取・導入・接続が済むまでは自動受信完了と報告しない。

## v2: Windows PC名の大小文字差で初回導入が停止した場合（2026-10-08）

`CEO-douga` / `CEO-DOUGA` のように大小文字だけが異なるWindows PC名を同一と照合する修正版です。
共有検証関数を修正し、`--probe` と通常受信の両方に適用します。別PC名、固定Chatの不一致、
不正なPC名・権限値は引き続き拒否します。TSA限定の改修実行判定も変更しません。
既存キー、サーバー登録PC名、Nodeの実hostname、Windows PC名は変更不要です。

自動受信が未起動で、旧インストーラーがStartup登録前に停止したPCでは次の手順で再導入してください。
既に稼働中の場合はこの手順で上書きせず、別途更新作業を依頼してください。

1. 修正版ZIPを掲示SHA256で照合し、新しい専用フォルダーへ展開します。旧配布へ手作業の判定回避パッチを当てません。
2. 展開先で `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-codex-mtg-peer.ps1 -NoStart` を実行します。
   既存保護キーをそのまま使い、`--check` と `--probe` の成功後にStartupを登録します。この段階では起動しません。
3. `--probe` の出力が `ok:true`、`pcName:"CEO-DOUGA"`、`canExecuteCode:false` であることを確認します。
   失敗時は停止し、PC名・登録・キーを書き換えて通しません。秘密値は出力・投稿しません。
4. 同じインストーラーを `-NoStart` なしで実行し、既存の共通monitorとTSGの「自動受信: 最終確認」を確認します。
   実機で両方を確認するまで自動受信完了とは扱いません。

専用MCPは同梱の `integrations/codex-mtg-mcp/README.md` の1.0.1更新手順で再読込します。
TSGデータ読取の確認は独立して行い、自宅DocScannerは無効を維持します。
