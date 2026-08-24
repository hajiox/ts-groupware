insert into public.gw_holidays (holiday_date, name, holiday_type, raw_payload)
values
  ('2026-01-01', '元日', 'national', '{"source":"Cabinet Office 2026"}'::jsonb),
  ('2026-01-12', '成人の日', 'national', '{"source":"Cabinet Office 2026"}'::jsonb),
  ('2026-02-11', '建国記念の日', 'national', '{"source":"Cabinet Office 2026"}'::jsonb),
  ('2026-02-23', '天皇誕生日', 'national', '{"source":"Cabinet Office 2026"}'::jsonb),
  ('2026-03-20', '春分の日', 'national', '{"source":"Cabinet Office 2026"}'::jsonb),
  ('2026-04-29', '昭和の日', 'national', '{"source":"Cabinet Office 2026"}'::jsonb),
  ('2026-05-03', '憲法記念日', 'national', '{"source":"Cabinet Office 2026"}'::jsonb),
  ('2026-05-04', 'みどりの日', 'national', '{"source":"Cabinet Office 2026"}'::jsonb),
  ('2026-05-05', 'こどもの日', 'national', '{"source":"Cabinet Office 2026"}'::jsonb),
  ('2026-05-06', '振替休日', 'national', '{"source":"Cabinet Office 2026"}'::jsonb),
  ('2026-07-20', '海の日', 'national', '{"source":"Cabinet Office 2026"}'::jsonb),
  ('2026-08-11', '山の日', 'national', '{"source":"Cabinet Office 2026"}'::jsonb),
  ('2026-09-21', '敬老の日', 'national', '{"source":"Cabinet Office 2026"}'::jsonb),
  ('2026-09-22', '国民の休日', 'national', '{"source":"Cabinet Office 2026"}'::jsonb),
  ('2026-09-23', '秋分の日', 'national', '{"source":"Cabinet Office 2026"}'::jsonb),
  ('2026-10-12', 'スポーツの日', 'national', '{"source":"Cabinet Office 2026"}'::jsonb),
  ('2026-11-03', '文化の日', 'national', '{"source":"Cabinet Office 2026"}'::jsonb),
  ('2026-11-23', '勤労感謝の日', 'national', '{"source":"Cabinet Office 2026"}'::jsonb)
on conflict (holiday_date) do update set
  name = excluded.name,
  holiday_type = excluded.holiday_type,
  raw_payload = excluded.raw_payload;
