# TS Groupware (TSG) 開発経過

## 最終更新: 2026-06-01

---

### 2026-05-14 通知・未読バッジ・PWA App Badgeの安定化
- **対象**: 掲示板投稿、グループチャット、DM、Web Push通知、未読赤丸、ホーム画面追加アイコンのApp Badge
- **問題**:
  - 掲示板/グループチャット投稿で送信者本人にもPush通知が飛ぶ場合があった
  - グループ一覧、DM一覧、下部ナビ、PWA App Badgeで未読数の計算ルールが揃っていなかった
  - Service Workerが通知クリック時にApp Badgeを無条件クリアし、他の未読が残っていても赤丸が消えることがあった
  - Push通知アイコンが存在しない `/icon-192x192.png` を参照していた
  - VAPID公開鍵のハードコードフォールバックにより、環境変数不備を見逃す可能性があった
  - Push送信失敗が成功ログとして扱われ、原因調査しづらかった
- **修正内容**:
  - `lib/unread.ts` を新設し、未読数を「自分以外の親投稿/メッセージ、last_read_at以降」で共通計算
  - `/api/unread` と `/api/groups` の未読計算を共通ロジックへ統一
  - `sendPushNotificationToGroup` で送信者本人を通知対象から除外
  - Push payloadにユーザー別の `badgeCount` を付与し、Service Worker側はその数値でApp Badgeを更新
  - 通知クリック時の無条件 `clearAppBadge()` を削除
  - 通知アイコン参照を `/icon-192.png` に統一
  - Push送信エラーを失敗としてログ出力するよう修正
  - `NEXT_PUBLIC_VAPID_PUBLIC_KEY` 未設定時は通知非対応扱いにし、誤った購読を防止
- **確認**:
  - `npm.cmd run build` 成功
- **関連ファイル**:
  - `lib/unread.ts`
  - `lib/web-push.ts`
  - `public/sw.js`
  - `app/api/unread/route.ts`
  - `app/api/groups/route.ts`
  - `app/settings/page.tsx`

## 1. プロジェクト概要

- **プロジェクト名:** ts-groupware (TSG)
- **リポジトリ:** https://github.com/hajiox/ts-groupware
- **本番環境:** https://v0-line-blush.vercel.app （Vercel。GitHub mainブランチへのpushで自動デプロイ）
- **DB:** Supabase（プロジェクト: oem-btob / zfhswguzqyagmhhlpksq）
- **技術スタック:** Next.js 16 (App Router), Supabase, Vanilla CSS (Dark Theme), Google Drive API
- **ワークスペース:** `C:\作業用\ts-groupware`
- **認証:** LINEログイン（OAuth 2.0）
- **ファイルストレージ:** Google Drive（サービスアカウント: tsai-doc-scanner@tsai-460605.iam.gserviceaccount.com）

> **⚠️ デプロイ注意:** 本番はVercel。コード変更を反映するにはGitHubへpushすること。環境変数の変更後は再デプロイが必要。

---

## 2. システム構成

### 2-1. DBテーブル構成（Supabase）

| テーブル名 | 用途 |
|-----------|------|
| `gw_users` | ユーザー管理（LINE連携、role: admin/member） |
| `gw_groups` | グループ（掲示板/チャット） |
| `gw_group_members` | グループメンバーシップ（どのユーザーがどのグループを見れるか） |
| `gw_posts` | 投稿（掲示板投稿、コメント、添付ファイル） |
| `gw_reactions` | リアクション（絵文字） |
| `gw_read_status` | 既読管理 |
| `gw_push_subscriptions` | Web Push通知購読 |

### 2-2. API構成

| パス | メソッド | 用途 |
|------|---------|------|
| `/api/auth/line` | GET | LINEログイン開始（302リダイレクト） |
| `/api/auth/line/callback` | GET | LINEコールバック処理・セッション発行 |
| `/api/auth/me` | GET | ログインユーザー情報取得 |
| `/api/auth/logout` | POST | ログアウト |
| `/api/groups` | GET/POST | グループ一覧取得 / 新規作成（管理者のみ） |
| `/api/posts` | GET/POST | 投稿一覧 / 新規投稿 |
| `/api/reactions` | POST | リアクション追加/削除 |
| `/api/upload` | POST | ファイルアップロード（Google Drive） |
| `/api/push/subscribe` | POST | Push通知購読登録 |
| `/api/admin/users` | GET/PUT/DELETE | ユーザー管理（管理者専用） |
| `/api/admin/groups` | DELETE | グループ削除（管理者専用） |
| `/api/admin/members` | GET/POST/DELETE | グループメンバー管理（管理者専用） |

### 2-3. ページ構成

| パス | 用途 |
|------|------|
| `/login` | LINEログイン画面 |
| `/groups` | グループ一覧（ホーム） |
| `/board/[id]` | 掲示板ページ（投稿・コメント・リアクション・ファイル添付） |
| `/chat/[id]` | チャットページ |
| `/admin` | 管理画面（ユーザー管理・グループ管理・メンバー管理） |
| `/settings` | 設定・Push通知登録 |

### 2-4. 環境変数（Vercel）

| 変数名 | 用途 |
|--------|------|
| `NEXT_PUBLIC_SITE_URL` | サイトURL（コールバック等に使用） |
| `LINE_CHANNEL_ID` | LINEログインチャネルID |
| `LINE_CHANNEL_SECRET` | LINEログインチャネルシークレット |
| `SUPABASE_URL` | Supabase URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase サービスロールキー |
| `VAPID_PRIVATE_KEY` | Web Push VAPID秘密鍵 |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Web Push VAPID公開鍵 |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Google Drive サービスアカウントJSON（1行） |
| `GOOGLE_DRIVE_FOLDER_ID` | （オプション）Google Drive アップロード先フォルダID |

---

## 3. 初期構築 (2026-04-28 〜 05-08)

### 3-1. LINEログイン認証システムの構築
- **LINE Developers設定**: 内職管理システム（naishoku-app）と同じLINEログインチャネル（ID: 2009558059）を使用
- **OAuth 2.0フロー**: `/api/auth/line` でstate生成→302リダイレクト→LINEで認証→`/api/auth/line/callback` でトークン交換→プロフィール取得→セッションCookie発行
- **セッション管理**: `gw_user_session` Cookie（HttpOnly, Secure, 30日有効）
- **Middleware**: `/login`, `/api/auth`, 静的ファイル以外の全パスでセッションチェック

### 3-2. グループ（掲示板/チャット）システム
- **掲示板**: 投稿・コメント（`parent_id`でスレッド管理）・リアクション（6種絵文字）
- **チャット**: リアルタイムメッセージ（ポーリング）
- **未読管理**: `gw_read_status` テーブルで最終既読時刻を管理、グループ一覧にバッジ表示
- **ファイル添付**: 画像・ファイルのアップロード対応

### 3-3. Web Push通知
- VAPID鍵方式でブラウザPush通知を実装
- 投稿時に同グループの他メンバーに自動通知
- Service Worker (`/sw.js`) でバックグラウンド受信

### 3-4. UI/デザイン
- **ダークテーマ**: Vanilla CSSでモバイルファーストの暗色UI
- **ボトムナビ**: 固定フッターナビゲーション（ホーム・管理・設定）
- **レスポンシブ**: 640px以上でセンター寄せ（max-width: 600px）

---

## 4. LINEログイン認証の修正 (2026-05-08 〜 05-09)

### 4-1. セッションCookieが保持されない問題
- **症状**: LINEでログイン後、`/groups` にリダイレクトされるが、ページリロードするとログイン画面に戻される
- **原因**: callback APIで `NextResponse.redirect()` を返す際、その前に設定した `cookies().set()` がブラウザに保存されずに破棄されていた。Next.js App Router特有の挙動
- **修正**: `NextResponse.redirect()` オブジェクトを先に作成し、そのオブジェクトに対して直接 `.cookies.set()` を呼び出す方式に変更
- **関連ファイル**: `app/api/auth/line/callback/route.ts`

### 4-2. LINE 403 Forbiddenエラー（PC/スマホ共通）
- **症状**: 「LINEでログイン」ボタン押下後、LINE認証画面で `403 Forbidden` エラー
- **原因**: `bot_prompt: 'normal'` パラメータ。LINE公式アカウント（Bot）がチャネルに連携されていない場合、LINEがこのパラメータを拒否する
- **修正**: `bot_prompt` パラメータを削除。`scope` を `profile openid` に戻す（内職管理と同じ設定）
- **関連ファイル**: `app/api/auth/line/route.ts`

### 4-3. クライアント側URL生成の撤回
- **経緯**: スマホでLINEアプリが直接起動しない問題への対策として、認証URLをクライアント側のJavaScriptで直接生成する方式を試みた
- **問題**: channel IDのハードコード、`window.location.origin` の信頼性の低さ、結局App-to-App遷移の改善効果なし
- **修正**: サーバーサイドリダイレクト方式（`/api/auth/line`）に戻し、ログインページのエラー表示機能のみ残した
- **関連ファイル**: `app/login/page.tsx`

---

## 5. 管理機能の実装 (2026-05-09)

### 5-1. ユーザー管理（`/api/admin/users`）
- **一覧表示**: 全ユーザーの名前・アバター・ロール・登録日を表示
- **ロール変更**: ドロップダウンで「管理者」⇔「スタッフ」を即時変更
- **ユーザー削除**: 確認ダイアログ後、関連データ（メンバーシップ・リアクション・既読・Push購読）を全削除してからユーザーを削除。自分自身の削除は不可
- **権限チェック**: 全APIで `requireAdmin()` による管理者チェックを実施

### 5-2. グループ管理（`/api/admin/groups`, `/api/groups` POST）
- **グループ作成**: 管理者のみ。管理画面の「グループ」タブから名前・種類（掲示板/チャット）・アイコンを指定して作成
- **グループ削除**: 確認ダイアログ後、投稿・リアクション・既読・メンバーシップを全削除してからグループを削除
- **一般ユーザーのFABボタン削除**: グループ一覧の `+` ボタン（FAB）を削除し、グループ作成は管理画面に集約

### 5-3. メンバー管理（`/api/admin/members`）
- **メンバー一覧**: グループごとに「参加中」メンバーと「未参加」ユーザーを一覧表示
- **メンバー追加**: 個別追加 + 「全員追加」ボタン
- **メンバー除外**: 個別除外
- **アクセス制御**: `gw_group_members` テーブルにレコードがないユーザーはそのグループを見れない（`/api/groups` GETで自動フィルタ）

### 5-4. ナビゲーション更新
- **管理タブ**: 管理者（`role === 'admin'`）のみ、ボトムナビに「🛡️ 管理」タブを表示
- **不要リンクの整理**: 重複していた「グループ」「通知」タブを削除し、「ホーム」「管理」「設定」の3タブに整理

### 5-5. 管理者の初期設定
- Supabase SQL Editorで最初のユーザー（佐藤正彦）の `role` を `admin` に手動設定
- `UPDATE gw_users SET role = 'admin' WHERE display_name = '佐藤正彦';`

---

## 6. ファイルアップロード Google Drive対応 (2026-05-09)

### 6-1. 概要
- ファイルアップロード先をGoogle Driveに設定
- TSAプロジェクトと同じサービスアカウント（`tsai-doc-scanner@tsai-460605.iam.gserviceaccount.com`）を使用
- アップロード後、「リンクを知っている全員が閲覧可」の権限を自動付与

### 6-2. 環境変数の設定
- `GOOGLE_SERVICE_ACCOUNT_KEY`: サービスアカウントのJSON（1行に圧縮）をVercel CLIで設定
  - **注意**: ブラウザUIでの貼り付けは `private_key` 内の `\n` が実際の改行に展開されてJSONが壊れる。必ず **Vercel CLI** (`npx vercel env add`) でパイプ入力すること
  - PowerShellで改行を除去して1行にする: `-replace "\`r\`n", "" -replace "\`n", ""`
- `GOOGLE_DRIVE_FOLDER_ID`: オプション。未設定ならサービスアカウントのルートにアップロード

### 6-3. Drive APIの仕様
- **ライブラリ**: `googleapis` (npm)
- **スコープ**: `https://www.googleapis.com/auth/drive.file`
- **アップロード**: `drive.files.create` + `Readable` ストリーム
- **公開設定**: `drive.permissions.create` で `role: 'reader', type: 'anyone'`
- **公開URL**: `https://drive.google.com/uc?id={fileId}`

### 6-4. トラブルシューティング
- **`invalid_grant: account not found`**: 環境変数のJSONが壊れている。Vercel CLIで再設定
- **Google Drive APIが有効か確認**: Google Cloud Console → APIとサービス → Google Drive API が有効であることを確認

---

## 7. 掲示板ページの修正 (2026-05-09)

### 7-1. ページがクラッシュする問題
- **症状**: グループ作成後、掲示板ページ (`/board/[id]`) で「This page couldn't load」エラー
- **原因**: ファイルアップロード機能追加時に `text`, `loading`, `textareaRef` の3つのstate/ref宣言が消失していた
- **修正**: `useState('text')`, `useState(true)`, `useRef<HTMLTextAreaElement>` を復元
- **関連ファイル**: `app/board/[id]/page.tsx`

### 7-2. 投稿入力バーの位置ズレ
- **症状**: PC画面（640px以上）で投稿入力バーが左下に小さく表示される
- **原因**: 外側の `<div style="position:fixed">` と内側の `<form class="post-input-bar">` の両方に `position:fixed` が設定されており、レスポンシブCSS（`left:50%; transform:translateX(-50%)`）が内側のformにだけ効いてバラバラに
- **修正**: 外側のラッパーに `post-input-bar` クラスを付与し、内側のformからはクラス・fixed positionを削除。テキストエリアのスタイルはインラインに移行
- **関連ファイル**: `app/board/[id]/page.tsx`, `app/globals.css`

---

## 8. 既知の課題・今後の対応

### 2026-05-09 本番環境 画像アップロード失敗の修正

- **症状**: 本番環境の掲示板で画像ファイルを添付して投稿すると「ファイルのアップロードに失敗しました」と表示される。
- **原因**: Vercel本番環境の `GOOGLE_SERVICE_ACCOUNT_KEY` が、サービスアカウントJSONの `private_key` 内に実改行を含む形式で保存されており、`JSON.parse()` が失敗していた。
- **修正**:
  - `lib/drive.ts` にサービスアカウントJSONの正規化処理を追加。
  - 通常のJSONとして読めない場合、`private_key` 内の実改行を `\n` に変換して再パースする。
  - 掲示板画面側でアップロードAPIのエラーメッセージを表示するようにし、今後の原因調査をしやすくした。
- **関連ファイル**:
  - `lib/drive.ts`
  - `app/board/[id]/page.tsx`
- **確認**: `npm.cmd run build` 成功。

### 2026-05-09 Google Driveアップロード先を共有ドライブ前提に修正

- **症状**: JSON正規化後、本番環境で `Service Accounts do not have storage quota` エラーが表示された。
- **原因**: サービスアカウントは自身のマイドライブ容量を持たないため、`GOOGLE_DRIVE_FOLDER_ID` 未設定のままサービスアカウントのルートへアップロードできない。
- **方針**: Supabase Storageは使わず、Google Driveの共有ドライブ配下フォルダへアップロードする。
- **修正**:
  - `lib/drive.ts` で `GOOGLE_DRIVE_FOLDER_ID` を必須化。
  - Vercel CLI入力時に末尾空白が混入しても動くよう、`GOOGLE_DRIVE_FOLDER_ID` は `.trim()` して使用。
  - Drive APIの `files.create` / `permissions.create` に `supportsAllDrives: true` を追加。
- **本番設定が必要な項目**:
  - Google共有ドライブにTSG用アップロードフォルダを作成
  - サービスアカウント `tsai-doc-scanner@tsai-460605.iam.gserviceaccount.com` を共有ドライブまたはフォルダに追加
  - Vercel Production環境変数 `GOOGLE_DRIVE_FOLDER_ID` にそのフォルダIDを設定
  - 環境変数追加後に再デプロイ
- **関連ファイル**:
  - `lib/drive.ts`

### 2026-05-09 Google DriveアップロードをOAuth方式へ変更

- **背景**: Google Driveの「共有アイテム」やマイドライブ内共有フォルダは、サービスアカウント方式では `Service Accounts do not have storage quota` でアップロードできない。
- **方針**: Supabase Storageは使わず、Google OAuthで `aizubrandhall@gmail.com` など実ユーザーのDrive権限を使ってアップロードする。
- **実装**:
  - `lib/drive.ts` をOAuth優先に変更。
  - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_DRIVE_REFRESH_TOKEN` が揃っている場合はOAuth方式でDrive APIを実行。
  - OAuth環境変数が無い場合のみ、従来のサービスアカウント方式にフォールバック。
  - `scripts/google-drive-oauth-token.mjs` を追加し、Drive用refresh tokenを取得できるようにした。
- **必要なVercel環境変数**:
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_CLIENT_SECRET`
  - `GOOGLE_DRIVE_REFRESH_TOKEN`
  - `GOOGLE_DRIVE_FOLDER_ID`
- **追加確認**:
  - OAuthクライアントが属するGoogle Cloudプロジェクトで Google Drive API を有効化する必要がある。
  - 今回使用したOAuthクライアントのプロジェクト `314370661071` では未有効だったため、`https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=314370661071` で有効化が必要。
- **関連ファイル**:
  - `lib/drive.ts`
  - `scripts/google-drive-oauth-token.mjs`
  - `.env.local.example`

### 2026-05-09 Google Drive画像添付のサムネイル表示修正

- **症状**: 掲示板の画像添付は投稿できるが、本文内でサムネイル表示されず、ファイル名だけが壊れた画像として表示される。
- **原因**: 投稿に保存していた `https://drive.google.com/uc?id=...` 形式のURLが、ブラウザの`<img>`直埋め表示で安定しない。
- **修正**:
  - `/api/upload` の画像レスポンスで `viewUrl` として `https://drive.google.com/thumbnail?id={fileId}&sz=w1200` を返すように変更。
  - 掲示板画面側で既存投稿の `drive.google.com/uc?id=...` や `/file/d/...` URLも表示時にthumbnail URLへ変換するようにした。
- **影響**:
  - 新規投稿画像だけでなく、既存投稿の壊れた画像も再読み込み後に表示改善される。
- **関連ファイル**:
  - `app/api/upload/route.ts`
  - `app/board/[id]/page.tsx`

### 2026-05-09 画像添付の全体表示・クリック拡大対応

- **症状**: 掲示板カード内の添付画像が `object-fit: cover` と16:9固定表示により、ラベル画像などが勝手にトリミングされる。
- **修正**:
  - カード内画像を `object-fit: contain` に変更し、画像全体が見えるようにした。
  - 画像をクリックすると全画面オーバーレイで拡大表示するプレビューを追加。
  - 拡大表示は背景クリックまたは右上の閉じるボタンで閉じられる。
- **関連ファイル**:
  - `app/board/[id]/page.tsx`
  - `app/globals.css`

### 8-1. LINEアプリ直接起動
- スマホブラウザからLINE認証URLにアクセスした際、LINEアプリが直接起動せずWebブラウザ内でログイン画面が開く場合がある
- Vercelの共有ドメイン（`*.vercel.app`）ではOS側のUniversal Linksが信頼度が低い可能性
- 本番運用時にカスタムドメインを設定すれば改善する可能性あり

### 8-2. Google Driveフォルダの整理
- 現在は `GOOGLE_DRIVE_FOLDER_ID` 未設定のため、サービスアカウントのルートにアップロードされる
- 運用が進んだらグループウェア専用フォルダを作成し、フォルダIDを設定することを推奨

### 8-3. チャット機能のリアルタイム性
- 現在はポーリング方式（定期的にAPIを叩いて新着メッセージを取得）
- 将来的にSupabase Realtimeやサーバーサイドイベント（SSE）への移行を検討

### 2026-05-09 投稿窓幅・レスポンス・画像縮小アップロード対応
- **症状**: PC表示で投稿カードの外枠と下部投稿窓の幅が揃わず、投稿窓だけ横に広く見える。
- **修正**:
  - 投稿窓の固定バー幅を投稿カード実幅に合わせ、左右12pxの余白込みで外枠が揃うようにした。
  - 投稿後は一覧全体を再取得せず、APIから返った投稿1件を先頭へ即時追加するようにした。
  - リアクションはクリック直後に画面を楽観更新し、失敗時のみ再取得するようにした。
  - 投稿一覧APIのユーザー・リアクション・コメント数取得を並列化し、既読更新をレスポンス待ちから外した。
  - 画像アップロードは通常1600px上限・JPEG品質0.82で縮小してからGoogle Driveへ送信し、添付中のボタンで「元画像のままアップロード」に切り替えられるようにした。
- **関連ファイル**:
  - `app/board/[id]/page.tsx`
  - `app/globals.css`
  - `app/api/posts/route.ts`

### 2026-05-09 投稿編集・削除権限と下部UI調整
- **要望**: 掲示板記事に編集・削除を追加。基本は自身の投稿のみ操作可能、管理者は全投稿を削除可能にする。
- **実装**:
  - `/api/posts` に `PATCH` と `DELETE` を追加。
  - 編集は投稿者本人のみ許可。
  - 削除は投稿者本人、または `gw_users.role = admin` のユーザーのみ許可。
  - 親投稿削除時は紐づくコメント投稿とリアクションも削除。
  - 掲示板カード右上に控えめな編集・削除ボタンを追加し、編集はカード内インライン編集で保存/キャンセルできるようにした。
  - 投稿窓と下部ナビが接触して見えないよう、下部ナビを浮かせて角丸・境界・余白を調整。PC表示では投稿カード幅に揃えた。
- **関連ファイル**:
  - `app/api/posts/route.ts`
  - `app/board/[id]/page.tsx`
  - `app/globals.css`

### 2026-05-09 Next.js 16 Proxy移行
- **症状**: `npm run build` は成功するが、Next.js 16で `middleware.ts` のファイル規約が非推奨という警告が出ていた。
- **原因**: Next.js 16から Middleware は Proxy に名称変更され、ルートの `middleware.ts` ではなく `proxy.ts` が推奨になった。
- **修正**:
  - 既存の認証チェック処理を `middleware.ts` から `proxy.ts` へ移行。
  - exported function名を `middleware` から `proxy` に変更。
  - 認証不要パス、セッションCookie確認、リダイレクト条件、matcherは変更なし。
- **確認**:
  - `npm.cmd run build` 成功。
  - 開発サーバー再起動後、`/login` が 200、未ログインの `/groups` が `/login` へ 307 リダイレクトすることを確認。
- **関連ファイル**:
  - `proxy.ts`
  - `middleware.ts`（削除）

### 2026-05-09 ユーザー承認制・ログイン保持改善
- **問題**:
  - LINE認証に成功した新規ユーザーが即時ログインでき、管理者の承認を挟めなかった。
  - 既にセッションCookieがある状態でも `/login` を開くとログインボタンが表示され、毎回ログインが必要に見えていた。
- **修正**:
  - `gw_users.status` を追加し、`pending` / `approved` / `suspended` で承認状態を管理。
  - 新規LINEログインユーザーは `pending` で登録し、セッションCookieは発行しない。
  - `approved` のユーザーだけセッションを有効扱いにする。
  - 管理画面のユーザー管理に「承認」「停止」「再開」を追加。
  - 未承認・停止中ユーザーはグループメンバー追加候補から除外し、API側でも追加を拒否。
  - `/login` 表示時に既存セッションを確認し、ログイン済みなら `/groups` へ自動遷移。
- **DB反映**:
  - 共用Supabase DB（oem-btob / zfhswguzqyagmhhlpksq）に `sql/002_user_approval_status.sql` を適用済み。
  - 既存ユーザーは `approved` として移行される。
  - 適用後確認: `gw_users.status` カラムあり、既存ユーザー1件は `approved`。
- **確認**:
  - `npm.cmd run build` 成功。
  - 掲示板関連ファイルは未変更。
- **関連ファイル**:
  - `sql/002_user_approval_status.sql`
  - `app/api/auth/line/callback/route.ts`
  - `lib/session.ts`
  - `app/api/admin/users/route.ts`
  - `app/api/admin/members/route.ts`
  - `app/admin/page.tsx`
  - `app/login/page.tsx`
  - `app/globals.css`

### 2026-05-09 グループ一覧ヘッダーからログアウト対応
- **要望**: グループ一覧右上のユーザー名・写真からログアウトできるようにする。
- **修正**:
  - グループ一覧ヘッダーのユーザー領域をクリック可能に変更。
  - クリック時にユーザーメニューを表示し、「ログアウト」から既存の `/api/auth/logout` に遷移するようにした。
- **影響範囲**:
  - グループ一覧ヘッダーのみ。
  - 掲示板関連ファイルは未変更。
- **関連ファイル**:
  - `app/groups/page.tsx`
  - `app/globals.css`

### 2026-05-10 掲示板コメント機能の実装
- **担当**: 掲示板
- **要件**:
  - 掲示板投稿の「コメント」ボタンが表示だけで実動作していなかったため、`gw_posts.parent_id` を使ったコメント展開・投稿を実装する。
  - ログイン担当・Chat担当の作業と衝突しないよう、変更対象は掲示板ページ、投稿APIの互換拡張、掲示板用CSSに限定する。
- **実装内容**:
  - `/board/[id]` にコメント展開、コメント一覧読み込み、コメント投稿フォーム、コメント件数の即時更新を追加。
  - 投稿画面の文字化けしていた表示文言を掲示板ページ内で整理。
  - 添付ファイル表示を `viewUrl` / `driveId` / `webViewLink` に対応させ、画像プレビューと通常ファイルリンクを安定化。
  - `/api/posts` GET に `parent_id` クエリを追加し、特定投稿のコメントだけ取得できるようにした。既存の `group_id` 一覧取得と `parent_only` の挙動は維持。
  - コメントUI用に `.post-comments`, `.post-comment`, `.post-comment-form`, `.post-card__attachments`, `.post-card__file` などのCSSを追加。
- **確認**:
  - `npm.cmd run build` 成功。
  - ローカル `http://localhost:3000/board/test-board` は未ログイン状態で `/login` にリダイレクトされることをブラウザで確認。
  - 実ログイン済みセッションでのコメント投稿・展開は、ログイン担当の作業完了後に実機確認が必要。
- **関連ファイル**:
  - `app/board/[id]/page.tsx`
  - `app/api/posts/route.ts`
  - `app/globals.css`

### 2026-05-09 TOPページにLINEログインQRを追加
- **要望**: TOPページに、スマホで読み取るとLINEログインへ遷移するQRを表示する。
- **修正**:
  - `/` の即時 `/login` リダイレクトをやめ、TS GroupwareのTOPページを表示。
  - TOPページにLINEログインURL（`/api/auth/line`）へ進むQRコードを追加。
  - 同じ画面に通常の「LINEでログイン」ボタンも配置。
- **影響範囲**:
  - TOPページ表示のみ。
  - 掲示板関連ファイルは未変更。
- **関連ファイル**:
  - `app/page.tsx`
  - `app/globals.css`

### 2026-05-09 iPhone SafariのLINEログイン失敗対策
- **症状**: iPhone SE + Safari環境でLINEログインに進めない/承認待ち登録まで到達しないケースが発生。
- **原因候補**:
  - Vercel Productionの `NEXT_PUBLIC_SITE_URL` が空文字になっていた。
  - 認証APIが空文字の環境変数をフォールバック処理し、LINE OAuthの `redirect_uri` に `http://localhost:3000` を使う可能性があった。
  - スマホSafariからLINEアプリへ遷移するOAuthでは、callback URLの不一致がログイン失敗に直結する。
- **修正**:
  - `/api/auth/line` で `request.nextUrl.origin` を使い、実際にアクセスされた本番ドメインから `redirect_uri` を生成。
  - `/api/auth/line/callback` のトークン交換時も同じoriginから `redirect_uri` を生成。
  - `/api/auth/logout` のリダイレクト先もアクセス元originを使用。
  - `NEXT_PUBLIC_SITE_URL` は `.trim()` して使用し、Vercel CLI入力時の末尾空白・改行混入に備える。
  - Vercel Productionの `NEXT_PUBLIC_SITE_URL` を `https://v0-line-blush.vercel.app` に再設定済み。
  - 内職管理システムのLINE関連実装を確認し、LINEアプリ内から開くURLで使っていた `openExternalBrowser=1` をTSGのTOP QRとログインボタンにも追加。
  - iOS Safari/LINEアプリ往復で一時Cookieが失われてもstate検証できるよう、署名付きstateを追加。
- **影響範囲**:
  - LINE認証開始、LINE callback、ログアウトのみ。
  - 掲示板関連ファイルは未変更。
- **関連ファイル**:
  - `app/api/auth/line/route.ts`
  - `app/api/auth/line/callback/route.ts`
  - `app/api/auth/logout/route.ts`
  - `lib/line-oauth-state.ts`
  - `app/page.tsx`
  - `app/login/page.tsx`

### 2026-05-09 ログインページにもLINEログインQRを追加
- **要望**: `/login` にもTOPページと同じ、LINEログインへ進むQRを表示する。
- **修正**:
  - `/login` に `openExternalBrowser=1` 付きLINEログインURLのQRコードを追加。
  - ログインボタンも同じ絶対URLを使うように統一。
- **関連ファイル**:
  - `app/login/page.tsx`
  - `app/globals.css`

### 2026-05-09 LINEログイン診断ログ追加
- **背景**:
  - 管理者はLINEログイン済みだが、未登録ユーザー2名でLINE画面から戻ったあと承認待ち登録まで到達しない。
  - `gw_users` を確認したところ、管理者1件のみで `pending` ユーザーは未作成。
  - 承認判定ではなく、LINE callback前後の `state` / token交換 / profile取得 / DB登録のどこかで止まっている可能性が高い。
- **修正**:
  - `gw_auth_logs` テーブルを追加し、LINE OAuthの到達段階を記録。
  - `/api/auth/line` 開始時と `/api/auth/line/callback` の主要段階を記録。
  - LINEユーザーID、表示名などの個人識別子は保存しない。
- **DB反映**:
  - `sql/003_auth_logs.sql` を共用Supabase DBへ適用済み。
- **関連ファイル**:
  - `sql/003_auth_logs.sql`
  - `lib/auth-log.ts`
  - `app/api/auth/line/route.ts`
  - `app/api/auth/line/callback/route.ts`

### 2026-05-09 LINEログイン失敗ログ確認
- **確認結果**:
  - 管理者アカウントは `line_callback_received` → `line_callback_state_ok` → `line_callback_token_ok` → `line_callback_profile_ok` → `line_callback_existing_user` → `line_callback_approved_redirect` まで完走。
  - 未登録ユーザーのiPhoneでは `line_start_redirect` のみ記録され、`line_callback_received` が一度も記録されていない。
  - `gw_users` は管理者1件のみで、未登録ユーザーの `pending` レコードは未作成。
- **判断**:
  - 承認判定で弾かれているのではなく、LINEからTSGのcallback URLへ戻る前に止まっている。
  - LINE Developers側でチャネルが「開発中」の場合、Admin/Tester以外はLINEログインを利用できないため、この挙動と一致する可能性が高い。
- **次の確認**:
  - LINE Developers Consoleで対象LINE Loginチャネルのステータスが「公開済み」か確認。
  - 公開前に試す場合は、テストするLINEアカウントをチャネルのTesterに追加する。
  - callback URLに `https://v0-line-blush.vercel.app/api/auth/line/callback` が登録されていることも確認。

### 2026-05-09 LINE Developersチャネル共用の確認
- **確認結果**:
  - LINE Developers Console上にはプロバイダー「内職管理システム」のみ存在。
  - TSGは内職管理システムと同じLINE Loginチャネル（`LINE_CHANNEL_ID=2009558059`）を共用している。
- **判断**:
  - 管理者本人がログインできるのは、対象プロバイダー/チャネルのAdmin権限を持つLINEアカウントだからと考えられる。
  - 他ユーザーがcallbackへ戻らず失敗する場合、チャネルが「開発中」でAdmin/Tester以外が利用できない状態の可能性が高い。
- **対応方針**:
  - LINE Developers Consoleで「内職管理システム」プロバイダー配下のLINE Loginチャネルを開く。
  - チャネルを公開する、またはテストユーザー2名をTesterとして追加する。
  - Callback URLにTSG本番URL `https://v0-line-blush.vercel.app/api/auth/line/callback` を追加する。

### 2026-05-09 TSG用LINEチャネル未作成の確認
- **確認結果**:
  - LINE Developers Console上にTSG専用チャネルは存在しない。
  - 既存チャネルは「会津ブランド館内職管理」（Messaging API）と「会津ブランド館内職ログイン」（LINEログイン）。
  - 「会津ブランド館内職ログイン」はステータスが「開発中」。
- **判断**:
  - TSGは現状、内職管理のLINEログインチャネルを共用している。
  - 管理者本人がログインできるのは、そのLINEログインチャネルのAdmin権限を持っているため。
  - 内職管理システムでユーザー追加できている事象は、Messaging APIの友だち追加/作業者番号連携やAdmin/Tester利用であり、LINEログインチャネルが一般ユーザーに公開されていることとは別。
- **推奨対応**:
  - 運用を分けるため、TSG専用のLINEログインチャネルを新規作成する。
  - TSG専用チャネルのCallback URLに `https://v0-line-blush.vercel.app/api/auth/line/callback` を登録する。
  - TSGのVercel環境変数 `LINE_CHANNEL_ID` / `LINE_CHANNEL_SECRET` をTSG専用チャネルの値へ差し替える。
  - テスト中はテストユーザーをTesterに追加し、本運用時はチャネルを公開する。

### 2026-05-09 添付ファイル上限を100MBへ変更
- **要望**: 動画なども想定し、アップロード可能なファイルサイズ上限を一旦100MBまで広げる。
- **修正**:
  - `/api/upload` のアプリ側ファイルサイズ制限を10MBから100MBへ変更。
  - エラーメッセージも100MB表記に更新。
- **注意**:
  - 100MBはアプリ側の制限値。Google Drive自体の容量制限ではない。
  - 現在の実装は一度Vercel側でファイルを受けてからDriveへ送るため、大きい動画では通信時間やServerless実行時間の影響を受ける可能性がある。
- **関連ファイル**:
  - `app/api/upload/route.ts`

### 2026-05-09 投稿削除時のGoogle Drive添付ファイル連動削除
- **要望**: 掲示板の投稿を削除した場合、投稿に添付された画像・動画・PDF・ExcelなどのGoogle Drive上の実ファイルも削除する。
- **修正**:
  - `lib/drive.ts` にGoogle Driveファイル削除処理を追加。
  - `/api/posts` の `DELETE` で、削除対象の親投稿とコメント投稿に含まれる添付ファイルを集め、DB削除と合わせてDriveファイル削除も実行。
  - 今後の投稿では添付情報に `driveId` と `webViewLink` も保存するようにした。
  - 既存投稿についても `drive.google.com/thumbnail?id=...` や `uc?...id=...` のURLからDrive IDを抽出して削除対象にできるようにした。
- **注意**:
  - Driveファイル削除に失敗した場合はサーバーログとAPIレスポンスの `attachmentDeleteErrors` に残す。
  - Google Drive API権限上、アプリ/OAuthユーザーが削除可能なファイルが対象。
- **関連ファイル**:
  - `lib/drive.ts`
  - `app/api/posts/route.ts`
  - `app/board/[id]/page.tsx`

### 2026-05-09 掲示板アクション通知システム
- **要望**: 通知を受け取る設定をしたユーザーに、掲示板上の投稿などのアクションをPC/Android/iPhoneへWeb Push通知する。内職管理システムの実装を参考にする。
- **実装**:
  - 既存の `gw_push_subscriptions` と `web-push` を利用し、購読済み端末にのみ通知する。
  - `/api/push/status` を追加し、現在端末の購読状態をDBと照合できるようにした。
  - `/api/push/test` を追加し、設定画面からテスト通知を送信できるようにした。
  - `public/sw.js` を内職管理システム寄りに調整し、通知クリック時は既存タブへ遷移/フォーカス、なければ新規で開くようにした。
  - 設定画面に通知ON/OFF、テスト通知、iPhone/Android/PC別の設定ガイドを追加。
  - 新規投稿は既存のグループ通知を継続利用。
  - 投稿編集・投稿削除時にグループメンバーへ通知する。
  - リアクション追加時は投稿者本人へ通知する。自分の投稿への自分のリアクションは通知しない。
- **iPhone注意**:
  - iPhoneはSafariでホーム画面に追加したPWAから開いた場合のみWeb Push通知を有効化できる。
- **関連ファイル**:
  - `app/settings/page.tsx`
  - `app/api/push/status/route.ts`
  - `app/api/push/test/route.ts`
  - `app/api/posts/route.ts`
  - `app/api/reactions/route.ts`
  - `lib/web-push.ts`
  - `public/sw.js`

### 2026-05-09 グループChat機能のDB/API連携
- **要望**: FacebookメッセージのようなグループChat機能を実装する。Chatの作成とメンバー追加は管理者が行う。
- **実装**:
  - 既存の `gw_groups.type = chat` と `gw_group_members` を利用し、管理者が作成・メンバー追加したチャットだけを利用可能にした。
  - `/api/chat` を追加し、チャットグループの取得、メンバー一覧、メッセージ一覧、メッセージ送信を提供。
  - チャットAPIではログイン済みかつ対象チャットのメンバーであることを確認し、掲示板APIには影響しないよう分離。
  - `/chat/[id]` をモックデータから実データ連携へ変更。
  - 4秒ポーリングで新着メッセージを取得し、送信後は即時画面反映。
  - 画像・ファイル添付に対応し、画像はチャット内表示とクリック拡大、その他ファイルはDriveリンクで開けるようにした。
  - メッセージ送信時にグループメンバーへWeb Push通知を送信し、通知クリック先は `/chat/{group_id}` にした。
- **影響範囲**:
  - ログイン周り、掲示板画面、掲示板APIは変更なし。
  - 管理画面の既存グループ作成・メンバー管理機能をそのまま利用。
- **確認**:
  - `npm.cmd run build` 成功。
  - `npx.cmd tsc --noEmit` は既存の管理/掲示板/Supabase型エラーで停止（今回追加したチャットファイル起因のエラーは表示なし）。
  - `npm.cmd run lint` はローカルで `eslint` コマンドが見つからず未実行。
- **関連ファイル**:
  - `app/api/chat/route.ts`
  - `app/chat/[id]/page.tsx`
  - `app/globals.css`

### 2026-05-09 管理画面に新規Chat作成ボタンを明示
- **問題**: Chat作成は管理画面の「＋ グループを作成」内で種類をチャットに切り替える必要があり、入口が分かりにくかった。
- **修正**:
  - 管理画面のグループタブに「＋ 掲示板を作成」と「＋ Chatを作成」を分けて表示。
  - 「＋ Chatを作成」押下時は作成フォームをChatモードで開き、初期アイコンもChat用にした。
- **影響範囲**:
  - 管理画面のグループ作成UIのみ。
  - ログイン、掲示板、Chat APIは変更なし。
- **関連ファイル**:
  - `app/admin/page.tsx`
  - `app/globals.css`

### 2026-05-09 個人Chatとチャット吹き出し横アバター対応
- **要望**: Chatを個人間でも使えるようにする。吹き出しの脇にユーザー写真を表示し、写真ホバーで登録名を確認できるようにする。
- **実装**:
  - 個人Chatは `gw_groups.type = chat` の2人専用Chatとして扱う。
  - `/api/chat/direct` を追加し、承認済みユーザー一覧取得と、相手を指定した個人Chat作成/既存Chat再利用に対応。
  - 個人Chatの識別には `gw_groups.description` に `direct:{userId}:{userId}` を保存し、同じ2人のChat重複作成を避ける。
  - グループ一覧に「＋ 個人Chat」ボタンを追加し、相手選択後に対象Chatへ遷移。
  - 個人Chatは一覧上で相手の登録名を表示し、種別タグは「個人Chat」と表示。
  - `/chat/[id]` の全メッセージで吹き出し脇に投稿者アバターを表示。
  - アバター画像/プレースホルダーに `title` を付与し、ホバーで登録名を表示。
- **確認**:
  - `npm.cmd run build` 成功。
- **関連ファイル**:
  - `app/api/chat/direct/route.ts`
  - `app/api/groups/route.ts`
  - `app/groups/page.tsx`
  - `app/chat/[id]/page.tsx`
  - `app/globals.css`

### 2026-05-09 管理者の全グループ自動参加対応
- **問題**: 管理画面のメンバー管理で、管理者が未参加候補に表示され、追加しても参加中表示として分かりにくかった。
- **方針**: 管理者は個別メンバー設定なしで、全てのChat・掲示板に参加している扱いにする。
- **修正**:
  - `/api/admin/members` のメンバー一覧で、承認済み管理者を常に参加中として返す。
  - 管理者は未参加候補から除外。
  - 管理画面では管理者に「全グループ参加」を表示し、除外操作を出さない。
  - `/api/groups` で管理者には全グループを返す。
  - `/api/chat` で管理者はメンバー登録がなくても全Chatを開けるようにした。
- **確認**:
  - `npm.cmd run build` 成功。
- **関連ファイル**:
  - `app/api/admin/members/route.ts`
  - `app/api/groups/route.ts`
  - `app/api/chat/route.ts`
  - `app/admin/page.tsx`
  - `app/globals.css`

### 2026-05-09 メンバー一覧から個人Chat開始・個人Chat秘匿
- **要望**: 「＋個人Chat」ボタンは不要。登録済みメンバーリストを全員が見られ、そこから自由に個人Chatできるようにする。ただし個人Chatは検閲されないようセキュアにする。
- **修正**:
  - グループ一覧画面の「＋個人Chat」ボタンを廃止。
  - グループ一覧上部に承認済みメンバー一覧を常時表示。
  - メンバーを押すと、その相手との個人Chatを作成または既存Chatを再利用して遷移。
  - 管理者の「全グループ参加」対象から `description` が `direct:` で始まる個人Chatを除外。
  - `/api/chat` で個人Chatは当事者2名以外アクセス不可にし、管理者であっても未参加なら403にする。
- **確認**:
  - `npm.cmd run build` 成功。
- **関連ファイル**:
  - `app/groups/page.tsx`
  - `app/api/groups/route.ts`
  - `app/api/chat/route.ts`
  - `app/globals.css`

### 2026-05-09 ホームとメンバー画面の分離
- **要望**: ホーム画面には個人Chatを表示しない。ホームには掲示板とグループChatだけを更新順で表示し、個人Chatは下部ナビの「メンバー」から実行する。
- **修正**:
  - `/api/groups` で個人Chat（`description` が `direct:` で始まるChat）を返さないようにした。
  - `/groups` からメンバー一覧表示を削除し、掲示板/グループChat一覧専用に戻した。
  - `/members` ページを追加し、承認済みメンバー一覧と個人Chat開始を配置。
  - 下部ナビに「メンバー」を追加。
- **確認**:
  - `npm.cmd run build` 成功。
- **関連ファイル**:
  - `app/members/page.tsx`
  - `app/layout.tsx`
  - `app/groups/page.tsx`
  - `app/api/groups/route.ts`
  - `app/globals.css`

### 2026-05-09 iPhone通知設定の判定順修正
- **症状**: iPhone Safariで設定画面を開くと「この環境はWeb Push通知に対応していません」と表示され、通知ONの導線が分かりにくかった。
- **原因**: iPhone Safari通常表示では、ホーム画面追加前に `PushManager` が利用できないため、iPhone向けのホーム画面追加案内より先に非対応判定へ入っていた。
- **修正**:
  - iPhone/iPad判定を先に行い、ホーム画面追加前は「ホーム画面に追加したTSGアプリから通知を有効にしてください」と案内するように変更。
  - iPhoneで通知トグルを押した場合、設定ガイドを自動表示し、ホーム画面追加手順を案内。
  - iPadOSのMac風User-AgentもiPhone/iPad扱いにするよう補強。
- **確認**:
  - `npm.cmd run build` 成功。
- **関連ファイル**:
  - `app/settings/page.tsx`

### 2026-05-10 自分用メモChat対応
- **要望**: Chatを自分自身とも開始できるようにし、メモ代わりに使えるようにする。
- **修正**:
  - `/api/chat/direct` の自分自身への個人Chat作成禁止を撤廃。
  - メンバー一覧APIで自分自身も返し、一覧の先頭に表示。
  - 自分自身を選んだ場合は1人だけがメンバーの `direct:{userId}:{userId}` Chatを作成/再利用。
  - `/members` では自分自身を「自分用メモ」と表示し、ボタン文言も「メモ」にした。
- **確認**:
  - `npm.cmd run build` 成功。
- **関連ファイル**:
  - `app/api/chat/direct/route.ts`
  - `app/members/page.tsx`

### 2026-05-10 ChatのEnter送信停止
- **要望**: PCでEnterキーにより誤送信される可能性があるため、Chat投稿は↑ボタン押下のみにする。
- **修正**:
  - `/chat/[id]` の入力欄からEnter送信処理を削除。
  - フォームsubmitでは送信せず、↑ボタンのクリック時のみ `handleSend()` を実行。
- **確認**:
  - `npm.cmd run build` 成功。
- **関連ファイル**:
  - `app/chat/[id]/page.tsx`
### 2026-05-09 TSG専用LINEログインチャネル基本設定確認
- **確認内容**:
  - LINE Developers Console上で、プロバイダー「内職管理システム」配下にTSG専用のLINEログインチャネル「TS Groupware」が作成されていることを確認。
  - チャネルIDは `2010023803`。
  - チャネル基本設定上は、アプリタイプがWebアプリ、権限が `PROFILE` / `OPENID_CONNECT` になっており、TSGの現在の認証実装に必要な土台は揃っている。
  - OpenID Connectのメールアドレス権限は未申請だが、現在のTSGはLINE OAuthでメールアドレスを要求していないため必須ではない。
- **未確認/必須設定**:
  - 「LINEログイン設定」タブで、コールバックURLに `https://v0-line-blush.vercel.app/api/auth/line/callback` を登録する必要がある。
  - チャネルが「開発中」の間はAdmin/Tester以外はログインできないため、テストユーザー2名を「権限設定」でTester追加するか、運用時はチャネルを公開する必要がある。
  - Vercel Production環境変数をTSG専用チャネルへ差し替える必要がある。
    - `LINE_CHANNEL_ID=2010023803`
    - `LINE_CHANNEL_SECRET=<TS Groupwareチャネルのシークレット>`
  - 環境変数差し替え後はProduction再デプロイが必要。
- **判断**:
  - 画像の基本設定タブだけで見る限り、TSG専用LINEログインチャネルの作成方向はOK。
  - ただし現時点の本番アプリは、Vercel環境変数を差し替えるまで旧チャネルを使い続ける。

### 2026-05-09 TSG専用LINEログインチャネルのコールバックURL登録状況
- **ユーザー確認**:
  - LINEログイン設定タブ側で、TSG本番URLのコールバックURLは登録済み。
  - 追加スクリーンショットで「ウェブアプリでLINEログインを利用する」がON、コールバックURLが `https://v0-line-blush.vercel.app/api/auth/line/callback` になっていることを確認。
  - 直前の確認では基本設定タブのスクリーンショットからはコールバックURL欄が見えていなかったため、未確認事項として記録していた。
- **残作業**:
  - Vercel Production環境変数をTSG専用チャネルへ差し替える。
    - `LINE_CHANNEL_ID=2010023803`
    - `LINE_CHANNEL_SECRET=<TS Groupwareチャネルのシークレット>`
  - 差し替え後にProductionを再デプロイする。
  - チャネルが開発中の間は、ログイン確認する一般ユーザーをTesterへ追加するか、チャネル公開後に確認する。

### 2026-05-09 Vercel LINE環境変数をTSG専用チャネルへ差し替え
- **実施内容**:
  - Vercel `ts-groupware` プロジェクトの `LINE_CHANNEL_ID` / `LINE_CHANNEL_SECRET` をTSG専用LINEログインチャネルへ差し替え。
  - 対象環境はProduction / Preview。
  - `LINE_CHANNEL_ID` は `2010023803`。
  - `LINE_CHANNEL_SECRET` はTS Groupwareチャネルの値を登録済み。シークレット値はドキュメントに残さない。
- **デプロイ**:
  - `npx vercel --prod --yes` でProduction再デプロイ済み。
  - Production alias: `https://v0-line-blush.vercel.app`
- **確認**:
  - `https://v0-line-blush.vercel.app/api/auth/line` のリダイレクト先が `client_id=2010023803` になっていることを確認。
- **残注意**:
  - LINE Developers側のチャネルが開発中の場合、Admin/Tester以外はログインできない。

### 2026-05-09 TSG専用LINEログインチャネル公開
- **確認内容**:
  - LINE Developers Console上で、TSG専用LINEログインチャネル「TS Groupware」が公開済みになったことを確認。
  - これによりAdmin/Tester限定の制約は解除され、一般LINEユーザーもLINEログインフローへ進める状態になった。
- **次の確認**:
  - 未登録ユーザーがLINEログインすると、TSG側では `gw_users.status = pending` の承認待ちユーザーとして作成される想定。
  - 管理者アカウントで `/admin` を開き、承認待ちユーザーを「承認」するとログイン可能になる。
  - 既存管理者はすでに `approved` のため、そのままログイン可能。

### 2026-05-09 TSG LINEログイン成功と内職管理システムへの影響範囲確認
- **確認内容**:
  - TSG専用LINEログインチャネル公開後、LINEログイン成功を確認。
  - Vercel CLIの対象プロジェクトは `.vercel/project.json` 上で `ts-groupware`。
  - 今回差し替えた `LINE_CHANNEL_ID` / `LINE_CHANNEL_SECRET` はVercelの `ts-groupware` プロジェクト環境変数のみ。
  - LINE Developers側では新規作成した「TS Groupware」LINEログインチャネルを使っており、既存の「会津ブランド館内職ログイン」チャネル自体は変更していない。
  - Supabaseは内職管理システムと共用DBだが、TSG側の追加/更新対象は `gw_` prefixのテーブル。
- **判断**:
  - 現時点で、内職管理システムのVercel環境変数や既存LINEログインチャネルへ直接影響する操作は行っていない。
  - 共有DBについては、今後もTSG用テーブルは `gw_` prefixに限定する。

### 2026-05-09 LINEログインQR導線の整理
- **背景**:
  - PCでLINEログインする場合、LINE公式側でもQRログインや画像認証が表示されることがある。
  - TSG側でQRを常時表示すると、TSGのQRとLINE公式のQRが重なり、二重にQRを読むような体験になる。
- **修正内容**:
  - TOPページとログインページで、LINEログインボタンを主導線に変更。
  - TSG側QRはPC幅のみ表示される「スマホで開くQR」の折りたたみ内へ移動。
  - スマホ幅ではTSG側QRを表示せず、LINEログインボタン中心の画面にした。
- **確認**:
  - `npm run build` 成功。
  - ローカル `http://localhost:3000/` でTOPページの初期表示にQRが常時表示されないことを確認。
  - ローカル `http://localhost:3000/login?error=cancelled` でログインページの初期表示にQRが常時表示されず、折りたたみを開くとQRが表示されることを確認。
  - Productionへデプロイ済み。
  - Production `https://v0-line-blush.vercel.app/` で「スマホで開くQR」の折りたたみ導線があることを確認。
  - Production `https://v0-line-blush.vercel.app/login?error=cancelled` でQRが初期非表示になっていることを確認。
- **関連ファイル**:
  - `app/page.tsx`
  - `app/login/page.tsx`
  - `app/globals.css`

### 2026-05-10 ログイン後ホームへLINEログインQRを追加
- **要望**:
  - ログイン後のホーム画面にも、小さくLINEログインへ飛ぶQRを設置する。
- **修正内容**:
  - ログイン後ホームであるグループ一覧画面の上部に、小さなLINEログインQRカードを追加。
  - QRは76px表示にして、グループ一覧の邪魔にならないサイズにした。
  - QRクリック時もLINEログイン開始URLへ遷移する。
- **確認**:
  - `npm run build` 成功。
  - ローカルでは未ログイン状態のため `/groups` が `/login` に戻され、実セッション付きの画面確認は本番ログイン後確認が必要。
- **関連ファイル**:
  - `app/groups/page.tsx`
  - `app/globals.css`

### 2026-05-10 LINEログインQRをユーザー写真メニューへ移動
- **要望**:
  - メインのタイムラインは掲示板とChatだけが並ぶ画面にしたい。
  - LINEログインQRは右上のユーザー写真メニュー内に置く。
- **修正内容**:
  - グループ一覧上部に置いたLINEログインQRカードを削除。
  - 右上のユーザー写真メニュー内に、小さなLINEログインQRを追加。
  - ユーザーメニュー内のQRは72px表示にして、ログアウト操作と同じメニュー内の補助導線にした。
- **確認**:
  - `npm run build` 成功。
- **関連ファイル**:
  - `app/groups/page.tsx`
  - `app/globals.css`
### 2026-05-10 TSG内表示名の管理者変更機能
- **要望**:
  - LINEログイン時の表示名があだ名や判別しにくい名前の場合、社内で誰か分からない。
  - システム内で分かりやすい名前へ変換できるようにする。
- **実装内容**:
  - 管理者画面のユーザー一覧に、TSG内表示名の入力欄と「名前保存」ボタンを追加。
  - `/api/admin/users` の `PUT` で `display_name` 更新を受け付けるようにした。
  - 空の表示名、80文字超の表示名はAPI側で拒否。
  - 変更対象は `gw_users.display_name` のみで、LINEアカウント自体の表示名は変更しない。
- **反映範囲**:
  - 掲示板、Chat、メンバー一覧など、`gw_users.display_name` を参照する画面に反映される。
- **関連ファイル**:
  - `app/admin/page.tsx`
  - `app/api/admin/users/route.ts`
### 2026-05-10 iPhone Safariログイン時のChrome遷移対策
- **問題**:
  - iPhoneでSafariからLINEログインした時、Safari → LINE → Chromeへ戻ることがあり、Safari/PWA前提の通知設定ができない。
- **原因想定**:
  - TSG側のLINEログインURLに `openExternalBrowser=1` を付けていたため、LINEアプリから戻る際にiPhoneの既定ブラウザへ開かれ、Chromeへ遷移するケースがある。
- **修正内容**:
  - TOPページ、ログインページ、ログイン後ユーザー写真メニュー内QRのLINEログインURLから `openExternalBrowser=1` を削除。
  - Safariで開始したログインは、Safariへ戻りやすい導線に変更。
- **確認**:
  - `npm run build` 成功。
- **関連ファイル**:
  - `app/page.tsx`
  - `app/login/page.tsx`
  - `app/groups/page.tsx`

### 2026-05-10 掲示板コメントボタンの反応改善
- **担当**: 掲示板
- **症状**:
  - 掲示板投稿の「コメントする」ボタンを押しても、コメント欄が既に開いている場合や入力欄が画面下に出る場合に反応が分かりにくい。
- **修正**:
  - 「コメントする」押下時は必ずコメント欄を開き、未読込ならコメント一覧を読み込むように変更。
  - コメント欄を開いた後、該当投稿のコメント入力欄へフォーカスするようにした。
- **確認**:
  - `npm.cmd run build` 成功。
- **関連ファイル**:
  - `app/board/[id]/page.tsx`
### 2026-05-10 掲示板コメント入力フォームの確実表示
- **担当**: 掲示板
- **症状**:
  - 投稿下部の「コメントする」またはコメント件数ボタンを押しても、入力フォームが表示されないように見える。
- **修正**:
  - コメント一覧の展開状態とは別に、入力フォーム表示用の `activeCommentPostId` を追加。
  - 「コメントする」とコメント件数ボタンのどちらを押しても、該当投稿直下のコメント入力フォームを必ず表示するように変更。
  - 表示後に該当コメント欄へスクロールし、入力欄へフォーカスするように変更。
- **確認**:
  - `npm.cmd run build` 成功。
- **関連ファイル**:
  - `app/board/[id]/page.tsx`
### 2026-05-10 掲示板コメントフォームをdetails方式に変更
- **担当**: 掲示板
- **症状**:
  - PC表示で投稿下部の「コメントする」を押しても入力フォームが表示されない。
- **修正**:
  - Reactのクリック状態だけに依存せず、ブラウザ標準の `details/summary` でもコメント欄を開ける構造へ変更。
  - フッターのコメント件数ボタンと「コメントする」ボタンはどちらも同じ入力フォーム表示処理に統一。
  - `details` 用CSSを追加し、開いた時はsummaryを隠してフォームを投稿直下に表示。
- **確認**:
  - `npm.cmd run build` 成功。
- **関連ファイル**:
  - `app/board/[id]/page.tsx`
  - `app/globals.css`
### 2026-05-10 掲示板コメント開閉をsummaryネイティブ動作へ変更
- **担当**: 掲示板
- **症状**:
  - 本番PCで投稿下部の「コメントする」を押しても入力フォームが開かない。
- **原因想定**:
  - フッターのbuttonクリックからReact stateで別要素を開く構造だったため、本番でhydration/JS状態に問題があると見た目が一切変わらない。
- **修正**:
  - 投稿フッター自体を `details > summary` に変更し、ブラウザ標準の開閉動作で入力フォームが開く構造にした。
  - summary内に「コメント件数」「コメントする」を表示し、同じ箇所を押すだけで投稿直下のコメントフォームが開くようにした。
  - JSが動く場合は従来通りコメント読込・入力欄フォーカスも実行する。
- **確認**:
  - `npm.cmd run build` 成功。
  - `npx vercel --prod --yes` で本番デプロイ成功。Production alias `https://v0-line-blush.vercel.app` 反映済み。
- **関連ファイル**:
  - `app/board/[id]/page.tsx`
  - `app/globals.css`
### 2026-05-10 LINEログインのiPhone挙動を内職管理システム方式へ戻し
- **対象**: LINEログイン開始処理
- **症状**:
  - iPhoneのSafariからLINEログインすると、Safari → LINE → 再度LINEログイン画面となり、「アプリでログイン」が表示されないケースがあった。
- **原因想定**:
  - TSG側だけ `disable_auto_login=true` を付けており、LINEアプリでの自動ログイン導線を抑止していた。
  - 内職管理システムの通常LINEログインにはこの指定がなく、TSGだけ挙動差が出ていた。
- **修正内容**:
  - `/api/auth/line` のLINE認可URLから `disable_auto_login` 指定を削除。
  - LINEログイン開始Routeの文字化けコメントを整理し、内職管理システムと同じ標準OAuthパラメータに戻した。
- **関連ファイル**:
  - `app/api/auth/line/route.ts`

### 2026-05-10 掲示板コメントのリアクション対応
- **担当**: 掲示板
- **対応内容**:
  - コメントにも投稿と同じリアクションボタンを追加。
  - コメント一覧の `commentsByPost` にもリアクションの楽観更新を反映し、押した直後に件数と選択状態が変わるようにした。
  - 保存処理は既存の `/api/reactions` を利用し、投稿とコメントで同じリアクション仕様に統一。
- **確認**:
  - `npm.cmd run build` 成功。
  - `npx vercel --prod --yes` 成功。
  - Production alias `https://v0-line-blush.vercel.app` 反映済み。
  - 本番URLをブラウザで開き、未ログイン状態では `/login` へ遷移することを確認。
- **関連ファイル**:
  - `app/board/[id]/page.tsx`
  - `app/globals.css`

### 2026-05-10 iPhone Push通知の根本修正（内職管理システム方式への統一）
- **問題**:
  - iPhoneでSafariからLINEログインすると、Safari → LINE → Chromeに戻ってしまい、結果としてChromeで通知設定しても通知が届かない。
  - device-loginリンクをSafariで開いても通知トグルが反応しない。
- **根本原因の特定（内職管理システムとの比較）**:
  - **iOSではWeb Push通知はSafari PWA（ホーム画面追加アプリ）でのみ利用可能**。Chrome等の他ブラウザでは不可。
  - 内職管理システムはこれを正しく判定し、PWA外では通知ボタンを非表示にしてPWA化手順を案内していた。
  - TSGはこの判定が欠如しており、Chromeからでも通知トグルが表示されて操作できるが、実際には動作しない状態だった。
- **修正内容**:
  - **PWA基盤の修正**:
    - `public/manifest.json`: 192x192/512x512 PNGアイコンを追加、`start_url`を`/groups`に変更
    - `public/apple-touch-icon.png`, `public/icon-192.png`, `public/icon-512.png` を追加
    - `app/layout.tsx`: `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-mobile-web-app-title`, `apple-touch-icon` メタタグを追加
  - **設定ページの全面改修** (`app/settings/page.tsx`):
    - 内職管理システムと同じiOS standalone判定を導入（`navigator.standalone` + `display-mode: standalone`）
    - iOSでPWA外の場合: 通知トグルを表示せず、Safari PWA化の手順を案内するガイドを表示
    - iOSでPWA内の場合: 通常通り通知トグルを表示
    - 「通知非対応」「通知ブロック済み」の状態別UIを追加
    - device-login経由アクセス時（`?deviceLogin=1`）に成功メッセージを表示
    - iPhoneの設定ガイドを「Safari PWA限定」に明確化、Chrome不可を赤色警告で表示
- **iPhone通知の正しい設定手順（修正後）**:
  1. iPhoneの**Safari**で `v0-line-blush.vercel.app` を開く
  2. 共有ボタン → 「ホーム画面に追加」
  3. ホーム画面のTSGアイコンからアプリを開く
  4. LINEでログイン（PWA内のWebViewでOAuthが完結するためSafariに戻る問題なし）
  5. 設定画面で通知をONにする
  - または、別ブラウザでログイン済みの場合は設定画面から「Safari用ログインリンクを作成」し、Safari PWAで開いてセッションを引き継ぐ
- **確認**:
  - `npm run build` 成功。
  - `git push origin main` 成功。Vercel自動デプロイ開始。
- **関連ファイル**:
  - `app/layout.tsx`
  - `app/settings/page.tsx`
  - `public/manifest.json`
  - `public/apple-touch-icon.png`
  - `public/icon-192.png`
  - `public/icon-512.png`

### 2026-05-10 投稿の編集・削除で通知を送らないよう変更
- **対象**: 掲示板・グループChat
- **要件**: 投稿の「編集」および「削除」操作時にはプッシュ通知を送信しない
- **修正内容**:
  - `app/api/posts/route.ts`: PATCH（編集）とDELETE（削除）ハンドラから通知送信ロジックを完全に除去
  - `app/settings/page.tsx`: 設定画面の通知説明文を端末ごとの受信ON/OFFであることが分かる文言へ修正
- **関連ファイル**:
  - `app/api/posts/route.ts`
  - `app/settings/page.tsx`

### 2026-05-10 PWAバッジ表示（未読数アイコンバッジ）
- **対象**: PWA（ホーム画面追加アプリ）
- **要件**: iPhoneアプリのようにアイコンに未読件数バッジを表示
- **修正内容**:
  - `app/groups/page.tsx`: グループ一覧取得時に未読数合計を集計し、`navigator.setAppBadge()` でバッジを表示
  - `public/sw.js`: プッシュ通知受信時にバッジをセット、通知タップ時にクリア
- **制限事項**: iOS 16.4+のPWA環境でのみ動作。バッジ更新はService Workerアクティブ時または通知受信時のみ
- **関連ファイル**:
  - `app/groups/page.tsx`
  - `public/sw.js`

### 2026-05-10 本名（real_name）機能の追加
- **対象**: ユーザー管理・全画面の表示名
- **要件**: LINEネームを保持したまま、管理画面で本名を設定できるようにする。本名が設定されている場合はアプリ全体で本名を優先表示する
- **DB変更**:
  - `gw_users` テーブルに `real_name TEXT` カラムを追加（内職管理システムと共用のSupabase DB `oem-btob` にて実行）
- **修正内容**:
  - **管理画面UI** (`app/admin/page.tsx`):
    - LINEネーム表示の下に「本名 (任意)」入力欄と小さな「保存」ボタンを配置
    - スマホでもコンパクトに収まるようデザイン調整
  - **API** (`app/api/admin/users/route.ts`):
    - GET: `real_name` カラムをSELECTに追加
    - PUT: `real_name` の更新に対応（空文字列はNULLとして保存）
  - **セッション** (`lib/session.ts`):
    - `getUserSession()` で `real_name || display_name` を `display_name` にセット（アプリ全体で自動的に本名優先）
  - **各API全面対応**:
    - `app/api/posts/route.ts`: 投稿者情報取得で `real_name` を考慮
    - `app/api/chat/route.ts`: チャットメンバー・メッセージ著者で `real_name` を考慮
    - `app/api/chat/direct/route.ts`: メンバー一覧・ターゲットユーザーで `real_name` を考慮
    - `app/api/groups/route.ts`: ダイレクトチャット相手の表示名で `real_name` を考慮
    - `app/api/admin/members/route.ts`: グループメンバー管理で `real_name` を考慮
- **関連ファイル**:
  - `sql/006_user_real_name.sql`
  - `lib/session.ts`
  - `app/admin/page.tsx`
  - `app/api/admin/users/route.ts`
  - `app/api/posts/route.ts`
  - `app/api/chat/route.ts`
  - `app/api/chat/direct/route.ts`
  - `app/api/groups/route.ts`
  - `app/api/admin/members/route.ts`

### 2026-05-10 グループ一覧APIのパフォーマンス最適化（N+1クエリ解消）
- **対象**: `/api/groups` GET
- **問題**: グループ一覧取得時、各グループごとに個別にDBクエリを発行していた（N+1問題）
  - 1グループあたり最大3クエリ（最新投稿・既読ステータス・未読数）
  - 10グループで最大30回のDB往復 → Vercel↔Supabase間のレイテンシが積算されて遅延
- **修正内容**:
  - 全グループ分のデータを3回の一括クエリで取得し、メモリ上でマッピングする方式に変更
    1. 全グループの投稿を一括取得 → 最新投稿を抽出
    2. 全グループの既読ステータスを一括取得
    3. 全グループの投稿日時を一括取得 → 未読数を計算
  - **30クエリ → 3クエリに90%削減**
- **追加改善**:
  - `app/api/chat/route.ts`: `getChatAccess()` から不要なユーザーロール再取得クエリを削除（3クエリ→2クエリ）。呼び出し元からセッションの `user.role` を渡す方式に変更
- **関連ファイル**:
  - `app/api/groups/route.ts`
  - `app/api/chat/route.ts`

### 2026-05-11 eFax送信エラー調査
- **症状**: 5/8〜5/9のFAX送信が複数取引先（高速・二丸屋・ダイサン食材・高瀬物産・磐梯フード）で一律エラー
- **調査結果**:
  - DBのエラーメッセージ: 全件「`81XXXXXXXXXX宛のFaxを送信完了できませんでした`」
  - Gmail API経由のメール送信（DocScanner→eFax）は成功している
  - eFax→相手FAX機への送信がeFax側で失敗している
  - 特定の相手先ではなく全取引先で発生 → eFaxアカウント側の問題（課金停止・認証停止等）
- **結論**: システム（コード）の問題ではなく、eFaxアカウントの状態問題。eFaxポータルでの確認が必要
- **補足**: FAX送受信の認証はGmail APIサービスアカウント（`docscanner@tsai-460605.iam.gserviceaccount.com`）で完結しており、eFaxポータルのログイン情報はシステム上に保存されていない

### 2026-05-13〜14 チャット既読機能・DM通知・PWA App Badgeの改修
- **チャット・DMの既読機能実装**:
  - gw_read_status テーブルを利用して、チャットメッセージの既読状況（最終閲覧時間）を記録
  - 相手の投稿時間と自分の最終閲覧時間を比較して「既読」や「既読数」を表示
- **DM通知設定**:
  - これまで無効化されていたDMへのプッシュ通知を有効化
  - 送信者自身には通知されず、相手にのみ通知が飛ぶよう制御（sendPushNotificationToUser を利用）
  - TSG君（AI）がDMで返答した際にも、質問者に通知を送信するよう実装
- **未読バッジ（赤丸）の最適化とPWA対応**:
  - 全体未読API (/api/unread) を新設し、グループとDMの未読数をそれぞれ集計
  - ボトムナビゲーション（下部メニュー）の「DM」タブに未読バッジを表示
  - DMメンバー一覧 (/members) にて、ユーザーごとの個別未読バッジをアバター右上に表示
  - **iOS Safari PWA App Badgeの修正**:
    - グループの未読数しか集計していなかった問題を修正
    - アプリ全体のレイアウト (pp/layout.tsx) で全体未読APIをポーリングし、グループ・DM両方の未読数合計を 
avigator.setAppBadge() でホーム画面アイコンの赤丸に反映するよう改善
- **デザイン・UX改修**:
  - iOS Safariでの動的ビューポートとセーフエリアに合わせたボトムナビゲーションの固定表示 (position: sticky, 100dvh, safe-area-inset-bottom)
  - ライトモードとダークモードの切り替え設定を追加し、localStorage にて永続化（即時反映）
  - iOS向けプッシュ通知設定ガイド文の改善（「先にホーム画面に追加してからログインする」手順を明記）

### 2026-05-31 DM一覧の新着順対応
- **要望**: DM一覧もホームと同じく新着順にする。ただし「自分用メモ」と「TSG君」は固定表示にする。
- **修正**:
  - `/api/chat/direct` のGETで、ログインユーザーが参加している個人Chat（`direct:`）と最新投稿時刻を取得。
  - DM一覧は「自分用メモ」→「TSG君」→ 既存DMの最新投稿順 → 未開始ユーザーの名前順で返す。
  - 取得系には短いタイムアウトを入れ、共有Supabaseの遅延時にDM一覧全体が詰まりにくいようにした。
- **確認**:
  - `npx tsc --noEmit` 成功。
  - `npm run build` 成功。
- **関連ファイル**:
  - `app/api/chat/direct/route.ts`
