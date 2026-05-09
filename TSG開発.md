# TS Groupware (TSG) 開発経過

## 最終更新: 2026-05-09

---

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
