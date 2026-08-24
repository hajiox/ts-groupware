-- Store each manufacturing employee's normal shift in the existing HR profile.
-- The shift generator uses these values only when both start and end are present.
WITH manufacturing_defaults(surname, start_time, end_time, break_minutes) AS (
  VALUES
    ('芳賀', '08:00', '17:00', 60),
    ('橋本', '08:30', '17:30', 60),
    ('本名', '08:30', '16:15', 45),
    ('山口', '08:30', '16:15', 45),
    ('呉東', '09:00', '16:45', 45),
    ('佐藤', '09:00', '15:30', 30),
    ('鈴木', '09:00', '15:30', 30),
    ('舟木', '09:00', '15:30', 30),
    ('小桧山', '09:00', '15:30', 30),
    ('小島', '12:30', '17:30', 0)
)
UPDATE public.gw_payroll_employees AS employee
SET raw_payload = jsonb_set(
  COALESCE(employee.raw_payload, '{}'::jsonb),
  '{hr_profile}',
  COALESCE(employee.raw_payload -> 'hr_profile', '{}'::jsonb) || jsonb_build_object(
    'basic_work_start', defaults.start_time,
    'basic_work_end', defaults.end_time,
    'basic_break_minutes', defaults.break_minutes
  ),
  true
),
updated_at = now()
FROM manufacturing_defaults AS defaults
WHERE employee.payroll_status = 'active'
  AND regexp_replace(COALESCE(NULLIF(employee.real_name, ''), employee.display_name), '[[:space:]　]+', '', 'g') LIKE defaults.surname || '%'
  AND COALESCE(
    (SELECT users.department FROM public.gw_users AS users WHERE users.id = employee.user_id),
    employee.department,
    ''
  ) LIKE '%製造%';
