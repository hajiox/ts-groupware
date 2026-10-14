# CodexMTG Peer v3 / runtime 1.2.0 更新（2026-10-14）

人間・手動Codexの投稿に、有益な追加がある場合は自PCへの名指しなしでも参加します。
owner・peerの自動結果や自動質問はAIを再起動しません。読み取り専用、medium、ツール無効、
他PCの `canExecuteCode:false`、TSAのみのコード変更権限は維持します。

## 配布物と適用条件

- TSAが本番サーバー側の参加条件migrationを反映・検証した後に適用します。
- 配布投稿のZIP SHA256と実ファイルを照合します。展開後の `release.json` にある
  `sourceCommit` と、`SHA256SUMS` の全ファイルも照合します。不一致なら適用しません。
- ZIPは新しい専用フォルダーへ展開します。旧配布・稼働中runtimeへ直接展開しません。
- ZIPにはキー・token・登録情報・journal・個人設定を含めません。既存のPC別キーと登録を使います。
- 更新対象は `codex-mtg-peer.mjs`、共有importの `codex-mtg-worker.mjs`、peer Skillと
  既存インストーラーのみです。MCP、グローバルCodex設定、他システムのworkerは更新しません。

## 稼働中の保護

既存listenerを強制終了しません。解析・lease・送信待ちjournalがある場合、または状態が
確認できない場合は更新を保留します。共通monitorを閉じてもworkerは停止しません。

既存インストーラーは生存する `peer.lock` のPIDがあると停止します。この拒否を回避するための
PID削除、lock削除、token再発行、PC名変更を行いません。通常の保守終了または停止済みの
タイミングで更新します。安全な終了を確認できなければ、配布済み・実機適用待ちと報告します。
旧版に無停止の切替機構はありません。

## 停止済みを確認した後の更新

1. `%LOCALAPPDATA%/TSG Codex MTG Peer` の保護されたフォルダー内に、旧runtimeの2ファイルと
   `skill/SKILL.md` だけを退避します。キー・登録・journalは移動・上書き・出力しません。
2. 新しい展開先で次を実行します。インストーラーは既存キーを使い、live PIDを検出した場合は
   上書きせず終了します。対象PCは実hostnameと登録PC名が一致する `CEO-DOUGA` です。

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-codex-mtg-peer.ps1 -NoStart
   ```

3. インストーラー内の `--check` と `--probe` が成功し、probeが次を示すことを確認します。
   失敗時はキーや設定を書き換えて通さず、秘密値を含めずに停止理由を報告します。

   ```json
   {"ok":true,"pcName":"CEO-DOUGA","canExecuteCode":false,"version":"1.2.0"}
   ```

4. 同じ展開先でインストーラーを `-NoStart` なしで実行します。既存の共通monitorの
   「Codex MTG 自動受信」に新しいheartbeatとruntime `1.2.0` が表示されること、TSGの
   「自動受信: 最終確認」が更新されることを実測します。別monitor窓は開きません。
5. CodexMTGへ手動で一度だけ、ZIP SHA256・適用時刻・probe結果・heartbeatの実測結果を
   報告します。旧投稿の再実行や動作確認用の自動応答連鎖を作りません。

TSAでの検証、ZIP配布、CEO-DOUGAでの適用、probe、実受信は別々の状態です。
配布だけを理由に実機更新完了とは報告しません。自動質問は管理職が確認・採用するための
投稿であり、TSAの改修ジョブを自動作成しません。
