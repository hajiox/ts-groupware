# TSG 勤怠・給与計算 実装計画

作成日: 2026-06-09

最終更新: 2026-06-12

## 目的

社労士から受領している勤怠・給与資料を、今後TSG上で社内作成できる状態にする。

既存TSGには `gw_users` としてログインユーザー、表示名、本名、部署、管理者権限、承認状態がある。ただし給与実務に必要な社員コード、雇用区分、時給/月給、入社日、生年月日、保険/税/通勤設定などは別マスタとして追加する。

## 調査した資料

`C:\作業用\勤怠\2026.06` 配下を確認。

主な資料:

- `R08.06月支給時点従業員一覧.pdf`
  - 社員コード、氏名、カナ、生年月日、入社年月日。
- `休憩時間.pdf`
  - 5時間以下休憩なし、5時間超-6時間以下30分、6時間超-8時間以下45分、8時間超60分。
- `時給一覧.pdf`
  - 従業員、事業所、時給。
- `通勤費R8.xlsx`
  - 出勤日数、勤務先別日数、片道距離、非課税上限、交通費上限、通勤費計算式。
  - ルール例: 日数 x 通勤距離 x 2 x 16円。一部例外あり。
- `給与計算チェックリスト.xlsx`
  - 事業所別の入力日/入力者/確認日/確認者、対象者数、給与計算人数。
  - 交通費対象者、社保月額変更、介護保険40歳、雇用保険65歳、入退社情報、確認事項。
- `勤怠集計分\従業員毎勤怠集計.pdf`
  - 日別の出勤、退社、労働時間、時間外、土日祝勤務、深夜、距離、備考、月次合計。
- `勤怠集計分\勤怠一覧.pdf`
  - 従業員 x 勤務地別の勤務時間、深夜時間。
- `2026.6勤怠チェックリスト.pdf`
  - 出勤日数、休日出勤、代休、有休、欠勤、就労時間、残業、深夜、勤務地別勤務時間、非課税通勤手当。
- `2026.6支給控除一覧表.pdf`
  - 本給/基本給、各種手当、残業手当、欠勤/遅早控除、課税/非課税支給、社会保険、所得税、住民税、控除、差引支給額。
- `2026年賃金台帳.pdf`
  - 年間の従業員別賃金台帳。
- `2026.6事業所負担保険料一覧表.pdf`
  - 会社負担分の健康保険、介護保険、子ども・子育て支援金、厚生年金、雇用保険、合計。
- `テクニカルスタッフ_5月給与集計.xls`
  - 事業所別支給額、社長支給分按分、総支給額。
- `確認資料\R8.6*.pdf`
  - タイムカード原票スキャン。テキスト抽出不可に近く、OCRまたは画像保存/手入力補正対象。

## 既存TSGとの接続方針

既存の `gw_users` はログイン・通知・部署・管理者判定に使う。

給与/勤怠側は、`gw_users.id` に直接すべてを持たせない。理由:

- 給与対象者が必ずLINEログイン済みとは限らない。
- 退職後も給与・勤怠履歴を保持する必要がある。
- 給与情報は通常プロフィールより機密度が高い。
- 管理者権限と給与担当権限は分ける余地を残すべき。

給与用従業員マスタに `user_id` を nullable で持たせ、ログインユーザーと紐付く場合だけ接続する。

## 権限設計

最低限のMVP:

- `admin`: 全閲覧・編集・給与計算実行。
- `member`: 自分の勤怠入力/確認、自分の給与明細閲覧のみ。

推奨:

`gw_feature_roles` を追加し、全体adminとは別に機能権限を管理する。

- `attendance_manager`: 勤怠確認、修正承認、月次締め。
- `payroll_manager`: 給与マスタ、給与計算、支給控除、賃金台帳。
- `employee`: 自分の勤怠/給与のみ。

給与情報は `gw_posts` のような公開系RLS/Realtimeには絶対に乗せない。既存TSGは service role API中心なので、API側で毎回 `getUserSession()` と機能権限を確認する。

## DB設計案

### 1. 事業所・部署

`gw_workplaces`

- `id`
- `code`
- `name`
- `department`
- `is_active`
- `created_at`
- `updated_at`

想定値:

- 本社
- 会津ブランド館
- 食のブランド館/道の駅
- 会津しこん

既存 `gw_users.department` は「所属部署」。給与計算では「勤務事業所」「給与原価事業所」が別概念になるため、分離する。

### 2. 給与用従業員マスタ

`gw_payroll_employees`

- `id`
- `user_id` nullable references `gw_users(id) on delete set null`
- `employee_code` unique
- `display_name`
- `real_name`
- `kana`
- `birth_date`
- `hire_date`
- `resigned_date`
- `employment_type` enum相当: `officer`, `monthly`, `hourly`, `other`
- `pay_type`: `monthly`, `hourly`
- `default_workplace_id`
- `payroll_status`: `active`, `inactive`, `retired`
- `created_at`
- `updated_at`

補足:

- `gw_users` 削除で給与履歴を消さない。
- 社員コードを社労士資料との突合キーにする。
- 初回は本名一致で `gw_users` と仮リンクし、未確定は管理画面で手動リンクする。

### 3. 給与設定履歴

`gw_pay_rates`

- `id`
- `employee_id`
- `workplace_id` nullable
- `rate_type`: `hourly`, `monthly_base`, `allowance`
- `amount`
- `effective_from`
- `effective_to`
- `note`

`gw_employee_payroll_settings`

- `id`
- `employee_id`
- `effective_from`
- `effective_to`
- `tax_category`
- `resident_tax_monthly_amount`
- `employment_insurance_enabled`
- `social_insurance_enabled`
- `care_insurance_enabled`
- `standard_monthly_remuneration`
- `payment_method`
- `note`

社会保険料率・税額表はコード直書きしない。料率マスタまたは手入力/取込で運用する。

### 4. 通勤設定

`gw_commute_routes`

- `id`
- `employee_id`
- `workplace_id`
- `route_type`: `commute`, `business`, `regular_pass`, `exception`
- `one_way_distance_km`
- `round_trip_multiplier`
- `yen_per_km`
- `tax_free_limit`
- `monthly_cap`
- `effective_from`
- `effective_to`
- `note`

`gw_commute_monthly_results`

- `id`
- `payroll_period_id`
- `employee_id`
- `workplace_id`
- `work_days`
- `tax_free_amount`
- `taxable_amount`
- `total_amount`
- `calculation_snapshot` jsonb

### 5. 休憩・休日・丸めルール

`gw_break_rules`

- `id`
- `name`
- `min_work_minutes_exclusive`
- `max_work_minutes_inclusive`
- `break_minutes`
- `rule_type`: `company`, `legal`
- `effective_from`
- `effective_to`

初期値:

- 0-300分: 0分
- 301-360分: 30分
- 361-480分: 45分
- 481分以上: 60分

`gw_holidays`

- `date`
- `name`
- `holiday_type`

### 6. 勤怠期間・日別勤怠

`gw_attendance_periods`

- `id`
- `attendance_month`
- `period_start`
- `period_end`
- `status`: `open`, `reviewing`, `locked`
- `locked_by`
- `locked_at`

`gw_attendance_devices`

タイムレコーダー端末/利用元の管理。個人スマホ打刻だけで始める場合も、後から共有タブレット、QR、事務所PCを増やせるように分ける。

- `id`
- `name`
- `workplace_id` nullable
- `device_type`: `personal_mobile`, `shared_tablet`, `office_pc`, `admin`
- `is_active`
- `notes`
- `created_at`
- `updated_at`

`gw_attendance_punches`

出勤/退勤/休憩などの生打刻ログ。給与計算の根拠になるため原則 immutable とし、誤打刻は削除せず修正申請/管理修正で補正する。

- `id`
- `employee_id`
- `user_id` nullable
- `workplace_id`
- `device_id` nullable
- `business_date`
- `punch_type`: `clock_in`, `clock_out`, `break_start`, `break_end`
- `punched_at`
- `client_type`: `web`, `pwa`, `mobile`, `admin`
- `source_type`: `self`, `admin_proxy`, `import`
- `location_status`: `not_used`, `ok`, `failed`, `out_of_range`
- `latitude` nullable
- `longitude` nullable
- `ip_hash` nullable
- `user_agent` nullable
- `memo`
- `attendance_record_id` nullable
- `created_at`

`gw_attendance_records`

給与計算用の日次勤怠。通常は `gw_attendance_punches` から生成し、管理修正・月次入力・インポートでも作成できる。

- `id`
- `period_id`
- `employee_id`
- `work_date`
- `workplace_id`
- `clock_in`
- `clock_out`
- `break_minutes`
- `actual_work_minutes`
- `regular_minutes`
- `overtime_minutes`
- `night_minutes`
- `holiday_minutes`
- `weekday_saturday_overtime_minutes`
- `sunday_overtime_minutes`
- `over_60h_overtime_minutes`
- `late_early_count`
- `late_early_minutes`
- `paid_leave_minutes`
- `absence_minutes`
- `distance_km`
- `memo`
- `source_type`: `punch`, `manual`, `import`, `correction`
- `status`: `draft`, `submitted`, `approved`, `rejected`, `locked`
- `created_by`
- `approved_by`
- `approved_at`
- `created_at`
- `updated_at`

### 7. 勤怠修正・原票添付

`gw_attendance_corrections`

- `id`
- `attendance_record_id`
- `employee_id`
- `requested_by`
- `reason`
- `before_values` jsonb
- `after_values` jsonb
- `status`
- `reviewed_by`
- `reviewed_at`
- `created_at`

`gw_attendance_source_files`

- `id`
- `period_id`
- `workplace_id`
- `file_name`
- `file_url`
- `file_type`
- `uploaded_by`
- `uploaded_at`
- `ocr_status`
- `notes`

確認資料PDFは、まず原票ファイルとして保管し、日別データは手入力/補正で確定させる。OCRは後続でよい。

### 8. 月次勤怠集計

`gw_attendance_monthly_summaries`

- `id`
- `period_id`
- `employee_id`
- `workplace_id` nullable
- `work_days`
- `holiday_work_days`
- `substitute_holidays`
- `paid_leave_days`
- `special_leave_days`
- `absence_days`
- `work_minutes`
- `regular_minutes`
- `overtime_minutes`
- `night_minutes`
- `holiday_minutes`
- `workplace_minutes` jsonb
- `commute_days` jsonb
- `status`
- `calculated_at`
- `approved_by`
- `approved_at`

### 9. 給与期間・給与ラン

`gw_payroll_periods`

- `id`
- `payroll_month`
- `attendance_period_id`
- `closing_date`
- `pay_date`
- `status`: `draft`, `attendance_locked`, `calculated`, `approved`, `paid`, `locked`
- `created_by`
- `locked_by`
- `locked_at`
- `created_at`
- `updated_at`

`gw_payroll_runs`

- `id`
- `payroll_period_id`
- `run_no`
- `status`
- `started_by`
- `started_at`
- `finished_at`
- `error_message`

### 10. 給与項目マスタ・結果

`gw_payroll_items`

- `id`
- `code`
- `name`
- `item_type`: `earning`, `deduction`, `company_contribution`
- `taxability`: `taxable`, `non_taxable`, `none`
- `default_calculation_type`: `manual`, `formula`, `rate`, `import`
- `display_order`
- `is_active`

初期項目例:

支給:

- 本給
- 基本給
- 土日祝勤手当
- 特別手当
- 技能手当
- 住宅手当
- 育児手当
- 課税通勤手当
- 非課税通勤手当
- 超過勤務手当
- 普通残業
- 遡及手当
- 深夜手当
- 休日出勤手当
- GW特別手当
- 有給買取手当
- 欠勤控除
- 遅早控除
- お盆特別手当
- 平日土曜残業
- 日曜残業
- 月60時間超手当
- 慰労金

控除:

- 健康保険
- 介護保険
- 子ども・子育て支援金
- 厚生年金
- 雇用保険
- 調整保険
- 所得税
- 住民税
- 社宅家賃
- 年調精算額
- その他控除

会社負担:

- 会社負担健康保険
- 会社負担介護保険
- 会社負担子ども・子育て支援金
- 会社負担厚生年金
- 会社負担雇用保険

`gw_payroll_employee_results`

- `id`
- `payroll_run_id`
- `payroll_period_id`
- `employee_id`
- `attendance_summary_id`
- `workplace_id`
- `taxable_earnings`
- `non_taxable_earnings`
- `gross_earnings`
- `total_deductions`
- `net_payment`
- `company_contribution_total`
- `payment_method`
- `status`: `draft`, `reviewed`, `approved`, `locked`
- `calculation_snapshot` jsonb
- `created_at`
- `updated_at`

`gw_payroll_result_items`

- `id`
- `payroll_result_id`
- `payroll_item_id`
- `amount`
- `quantity`
- `rate`
- `source`
- `memo`

### 11. チェックリスト・承認

`gw_payroll_checklists`

- `id`
- `payroll_period_id`
- `workplace_id`
- `input_date`
- `input_by`
- `checked_date`
- `checked_by`
- `target_employee_count`
- `calculated_employee_count`
- `status`

`gw_payroll_checklist_items`

- `id`
- `checklist_id`
- `category`
- `label`
- `target_employee_id`
- `status`
- `note`
- `checked_by`
- `checked_at`

対象:

- 交通費対象者
- 社保月額変更対象者
- 介護保険40歳到達者
- 雇用保険65歳到達者
- 入社者/退職者
- その他確認事項

### 12. 事業所別集計・按分

`gw_payroll_cost_allocations`

- `id`
- `payroll_period_id`
- `employee_id` nullable
- `source_result_id` nullable
- `workplace_id`
- `allocation_type`: `direct`, `manual`, `ratio`
- `amount`
- `memo`

`テクニカルスタッフ_5月給与集計.xls` の社長支給分按分はここに入れる。

## API設計案

従業員向け:

- `GET /api/attendance/me/today`
- `POST /api/attendance/punch`
- `GET /api/attendance/me`
- `POST /api/attendance/me/records`
- `PUT /api/attendance/me/records/[id]`
- `POST /api/attendance/me/submit`
- `GET /api/payroll/me`
- `GET /api/payroll/me/[periodId]`

管理者/給与担当向け:

- `GET/POST/PUT /api/admin/payroll/employees`
- `GET/POST/PUT /api/admin/payroll/rates`
- `GET/POST/PUT /api/admin/payroll/commute`
- `GET/POST/PUT /api/admin/attendance/periods`
- `GET/POST/PUT /api/admin/attendance/devices`
- `GET /api/admin/attendance/punches`
- `GET/POST/PUT /api/admin/attendance/records`
- `POST /api/admin/attendance/calculate`
- `POST /api/admin/attendance/lock`
- `GET/POST /api/admin/payroll/periods`
- `POST /api/admin/payroll/calculate`
- `POST /api/admin/payroll/approve`
- `POST /api/admin/payroll/lock`
- `GET /api/admin/payroll/reports/[type]`

## 画面設計案

### 従業員向け `app/attendance/page.tsx`

- タイムレコーダー
- 出勤/退勤/休憩開始/休憩終了
- 今日の勤務状態
- 最終打刻時刻
- 勤務地選択
- 今月の勤怠一覧
- 日別入力/修正
- 出勤/退社/休憩/勤務地/備考
- 申請状態
- 締め後は閲覧のみ

### 従業員向け `app/payroll/page.tsx`

- 自分の給与明細一覧
- 支給/控除/差引支給額
- PDF/印刷は後続

### 管理者向け `app/admin/attendance/page.tsx`

- 月次期間一覧
- 事業所/部署別の入力状況
- 日別勤怠編集
- 原票PDF添付
- 勤怠集計
- 差戻し/承認/ロック

### 管理者向け `app/admin/payroll/page.tsx`

- 従業員マスタ
- 時給/給与設定
- 通勤費設定
- 給与月作成
- 勤怠集計取込
- 給与計算プレビュー
- 支給控除一覧
- 賃金台帳
- 会社負担保険料
- チェックリスト
- 承認/ロック

下部ナビに出すかは要検討。給与は全員向けに出すと情報量が増えるため、MVPでは管理画面配下に置き、従業員向け給与明細は後続でよい。

## 計算方針

### MVPで自動計算する

- 勤務時間
- 休憩控除
- 所定/残業/深夜/休日区分の集計
- 勤務地別勤務時間
- 通勤費
- 時給 x 勤務時間
- 支給/控除の合計
- 差引支給額
- 事業所別支給集計

### MVPでは手入力/マスタ入力にする

- 社会保険料
- 所得税
- 住民税
- 年調精算
- 標準報酬月額
- 特殊手当
- 賞与
- 社長支給分などの特殊按分

理由:

税額表・保険料率・例外処理を最初から完全自動化するとリスクが高い。まず社労士資料と一致する手入力/取込可能な結果テーブルを作り、その後に計算範囲を広げる。

## 実装フェーズ

### Phase 0: 突合・仕様確定

- `gw_users` と従業員一覧の氏名を突合。
- 社員コードを給与側主キーとして確定。
- 事業所名を確定。
- 勤怠対象月、給与支給月、締日、支給日の関係を明示。
- 給与担当権限を `admin` のみで始めるか、機能別権限を作るか決める。

成果物:

- 従業員マッピング表
- 事業所マスタ案
- 初期給与項目マスタ

### Phase 1: DB基盤

- `sql/013_attendance_payroll_base.sql`
- `supabase/migrations/20260609xxxx_attendance_payroll_base.sql`
- 事業所、従業員、権限、給与項目、休憩ルール、通勤設定、時給設定を追加。
- RLSは有効化するが、既存方針に合わせてAPI service role経由でアクセス制御。
- 給与/勤怠テーブルはRealtime公開しない。

### Phase 2: 管理マスタUI

- `app/admin/payroll/page.tsx`
- 従業員マスタ編集
- `gw_users` とのリンク設定
- 時給/月給設定
- 通勤距離設定
- 休憩ルール表示/編集
- 事業所設定

### Phase 3: タイムレコーダー・勤怠入力・集計

- `app/attendance/page.tsx`
- `app/time-clock/[deviceKey]/page.tsx`
- `app/admin/attendance/page.tsx`
- 本社・道の駅の専用端末タイムレコーダー
- 名前スクエアボタン選択
- 出勤/退勤確認
- 端末IDつきリアルタイム打刻
- 打刻ログから日次勤怠を生成
- 日別勤怠入力
- 管理者による代理入力/修正
- 原票PDF添付
- 勤怠集計計算
- 承認/ロック

### Phase 4: 給与計算

- 給与月作成
- ロック済み勤怠から給与計算
- 通勤費計算
- 支給/控除手入力
- 社保/税/住民税の手入力またはCSV取込
- 給与計算プレビュー
- 差引支給額計算

### Phase 5: 帳票出力

既存資料と同等の出力をTSGから生成する。

- 勤怠チェックリスト
- 支給控除一覧表
- 賃金台帳
- 事業所負担保険料一覧表
- 給与計算チェックリスト
- 通勤費一覧
- 事業所別支給額集計

最初は画面/CSV出力、次にPDF出力。

### Phase 6: 従業員セルフサービス

- 自分の勤怠入力
- 自分の勤怠修正申請
- 自分の給与明細閲覧
- PWA通知: 勤怠未提出、差戻し、給与明細公開

## 検証方針

社労士資料の2026.06を検証データとして使う。

検証項目:

- 従業員数が一致するか。
- 事業所別人数が一致するか。
- 勤務時間、深夜、休日、残業が一致するか。
- 通勤費が `通勤費R8.xlsx` と一致するか。
- 支給合計/控除合計/差引支給額が `支給控除一覧表` と一致するか。
- 会社負担保険料合計が `事業所負担保険料一覧表` と一致するか。
- 賃金台帳の月別結果が給与結果から再生成できるか。

## 未確定事項

- 給与担当権限を既存adminに含めるか、別権限にするか。
- タイムカード原票をOCRするか、当面は画像保存 + 手入力にするか。
- 打刻端末は本社・道の駅の専用端末方式を主方式にする。個人スマホ/IP/GPS判定は補助扱い。
- 専用端末の本人確認はPINなし。名前選択 + 確認画面 + 管理者修正ログで運用する。
- 休日カレンダーの定義。
- 勤務時間の丸め単位は15分で確定。2025.08〜2026.06の `従業員毎勤怠集計.pdf` と支給控除一覧の給与額で確認済み。
- 深夜時間帯、休日勤務、法定休日の判定ルール。
- 残業単価、深夜単価、休日単価、月60時間超の割増率。
- 月給者の他事業所勤務時間の扱い。
- 社会保険/税/住民税を自動計算する範囲。
- 銀行振込データを扱うか。
- 賞与、年末調整、退職者源泉徴収票まで対象にするか。

## 推奨する最初の実装単位

最初に作るべきは「給与計算」ではなく「給与・勤怠マスタ + タイムレコーダー + 月次勤怠集計」です。

理由:

- 給与計算は勤怠集計とマスタの正しさに依存する。
- 月次入力だけで始めると、結局あとで打刻ログとの整合性を作り直す必要がある。
- 社保/税は手入力でも給与結果は作れる。
- 既存資料との照合がしやすい。
- 後から自動計算範囲を広げてもDB設計が崩れにくい。

実装順:

1. DB基盤。
2. 従業員マスタと `gw_users` 紐付け。
3. 事業所/時給/通勤/休憩ルール。
4. タイムレコーダー打刻。
5. 打刻ログからの日次勤怠生成と月次集計。
6. 給与月作成と支給控除結果の手入力/計算。
7. 帳票出力。

## 2026-06-12 再精査メモ

`C:\作業用\労務` を対象に再確認した。旧 `C:\作業用\勤怠\2026.06` と同等の社労士資料一式があり、給与計算の出力結果だけではなく、勤怠集計、通勤費、時給、休憩ルール、保険料、賃金台帳、事業所別支給額まで揃っている。

確認できた主な資料:

- `R08.06月支給時点従業員一覧.pdf`: 社員コード、氏名、カナ、生年月日、入社日。
- `休憩時間.pdf`: 5時間以下0分、5時間超-6時間以下30分、6時間超-8時間以下45分、8時間超60分。
- `時給一覧.pdf`: 事業所別の時給者、時給。
- `通勤費R8.xlsx`: 勤務先別出勤日数、片道距離、1km以下支給なし、上限10,000円、非課税/課税通勤費、一部個人例外。
- `給与計算チェックリスト.xlsx`: 事業所別の入力/確認、対象者数、給与計算人数、交通費対象者など。
- `勤怠集計分\従業員毎勤怠集計.pdf`: 日別の出勤、退社、労働時間、時間外、土日祝、深夜、距離、月次合計。
- `勤怠集計分\勤怠一覧.pdf`: 従業員ごとの勤務先別勤務時間、深夜時間。
- `2026.6勤怠チェックリスト.pdf`: 月次勤怠項目と非課税通勤手当。
- `2026.6支給控除一覧表.pdf`: 支給項目、控除項目、課税/非課税、差引支給額、税制扶養数、税表区分。
- `2026.6事業所負担保険料一覧表.pdf`: 会社負担分の社会保険/雇用保険系金額と事業所別集計。
- `2026年賃金台帳.pdf`: 従業員別の年間賃金台帳。
- `テクニカルスタッフ_5月給与集計.xls`: 事業所別支給額、社長支給分按分、総支給額。
- `確認資料\R8.6*.pdf`: 画像/スキャン系でテキスト抽出不可。原票添付またはOCR補助の扱いにする。

既存TSG実装との差分:

- 共有端末型タイムレコーダー、管理画面の打刻追加/無効化、給与タブ入口は既にある。
- ただし現在の打刻ログは `gw_users` 直結で、給与用従業員マスタ、社員コード、日次勤怠、月次集計、給与計算、帳票再生成は未実装。
- `gw_attendance_punches.user_id` が `gw_users ON DELETE CASCADE` のため、給与証跡としては危険。給与用従業員マスタを別に作り、打刻/日次勤怠/給与結果は退職・TSGユーザー削除でも消えない構造へ移す。
- 給与担当権限は現在氏名ベース。機密情報の本実装では、将来 `gw_feature_roles` などの権限テーブルに分離する。

完成までの現実的な実装順:

1. 給与用従業員マスタ、事業所、権限、時給/月給、通勤、休憩ルール、給与項目のDB追加。
2. 既存 `gw_users` と給与従業員マスタの紐付け画面を管理に追加。
3. タイムレコーダーを給与従業員マスタ基準に変更し、未ログイン従業員も打刻対象にできるようにする。
4. 打刻ログから日次勤怠を生成し、休憩控除、勤務先別時間、深夜/休日/残業の集計を行う。
5. 月次勤怠の確認、修正、ロックを実装する。
6. 給与期間/給与ランを作成し、勤怠集計、時給/月給、通勤費、手当/控除から支給控除結果を作る。
7. 社保/税は初期MVPでは手入力または前月取込を許容し、税額表/保険料率の完全自動化は後段にする。
8. 支給控除一覧、勤怠チェックリスト、賃金台帳、事業所負担保険料、事業所別支給額をTSGから再生成する。

実装前に確認が必要な点:

- 給与対象者はLINE/TSG未ログインでもタイムレコーダーに表示する前提でよいか。
- 締日と支給日の関係は「月末締め、翌月10日支給」で固定か。
- 打刻時刻/集計時間の丸めは15分単位。過去の社労士資料では `:15` / `:45` が多数あり、時給計算にも15分単位の月次時間が使われている。
- 休憩は資料のルールで自動控除するか、将来は休憩開始/終了も打刻するか。
- 社保、所得税、住民税は初期段階で手入力/取込にしてよいか。
- 通勤費の個人例外、営業例外、業務距離の扱いを現Excel通りにマスタ化してよいか。

## 2026-06-12 前提確定

- タイムレコーダーは専用端末方式。給与対象者はTSG未ログインでも打刻対象にする。
- 締日/支給日は、月末締め・翌月10日支給。
- 勤怠計算の丸めは15分単位。
- 休憩は `休憩時間.pdf` のルールで自動控除。
- 社保、所得税、住民税は過去データ取込後に推測・検証する。
- 通勤費、個人例外、営業例外、業務距離は現Excelのデータを使用する。
- 勤怠管理・人員管理も兼ねるため、労務フォルダから取れる情報は原本行も含めてテーブル化し、TSGアカウントへ紐付ける。

## 2026-06-13 丸め単位再確認

`C:\作業用\労務` の2025.08〜2026.06を横断確認した結果、勤怠集計は30分ではなく15分単位で運用されている。

- 各月の `勤怠集計分\従業員毎勤怠集計.pdf` に `:15` / `:45` の日別・月次勤務時間が多数存在する。
- 2026.06支給控除一覧では、松崎正恵さんの `91:15` と時給 `1,100円` が基本給 `100,375円` に一致する。
- 同じく猪俣彩さんの `123:15` と時給 `1,090円` が基本給 `134,343円` に一致し、円単位は四捨五入と見られる。
- よって `gw_attendance_periods.rounding_unit_minutes` と `gw_attendance_rounding_rules.rounding_unit_minutes` は15分を正とする。

## 2026-06-12 Phase 1 実装

`sql/016_payroll_labor_base.sql` / `supabase/migrations/202606120001_payroll_labor_base.sql` を追加し、本番Supabaseへ適用した。

主な追加:

- `gw_workplaces`
- `gw_feature_roles`
- `gw_payroll_employees`
- `gw_labor_import_batches`
- `gw_labor_source_documents`
- `gw_labor_source_rows`
- `gw_attendance_periods`
- `gw_payroll_periods`
- `gw_break_rules`
- `gw_attendance_rounding_rules`
- `gw_attendance_daily_records`
- `gw_attendance_monthly_summaries`
- `gw_attendance_corrections`
- `gw_pay_rates`
- `gw_employee_payroll_settings`
- `gw_commute_routes`
- `gw_commute_monthly_results`
- `gw_payroll_items`
- `gw_payroll_runs`
- `gw_payroll_employee_results`
- `gw_payroll_result_items`
- `gw_employer_insurance_costs`
- `gw_payroll_checklists`
- `gw_payroll_checklist_items`
- `gw_payroll_cost_allocations`

既存変更:

- `gw_attendance_punches.user_id` を nullable にし、FKを `ON DELETE CASCADE` から `ON DELETE SET NULL` へ変更。
- `gw_attendance_punches` に `employee_id` / `workplace_id` を追加。
- `gw_attendance_devices` に `workplace_id` を追加。
- 既存TSGユーザーから給与従業員マスタをseedし、既存打刻ログへ `employee_id` をbackfill。

取込:

`scripts/import_labor_data.py` を追加。標準はdry-runで、`--json-out` で確認用JSON、`--sql-out` でSupabase CLI投入用SQLを生成できる。

本番DBへ `C:\作業用\労務` の初回取込を実行済み。

- 原本文書: 15件
- 原本抽出行: 200件
- 給与従業員マスタ: 32件
- 社員コードあり: 21件
- TSGアカウント紐付け: 24件
- 社員コードありかつTSG紐付け: 18件
- 通勤ルート: 23件
- 月次通勤結果: 17件
- 給与チェックリスト: 9件
- 事業所別支給集計: 2件
- 画像原票PDF: 3件
