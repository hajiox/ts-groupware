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
