-- Run against a linked DB after the migration. All test rows are rolled back.
BEGIN;
DO $$
DECLARE
  first_user UUID := gen_random_uuid();
  second_user UUID := gen_random_uuid();
  saved public.gw_attendance_monthly_notes;
  first_version TIMESTAMPTZ;
BEGIN
  INSERT INTO public.gw_users (id, line_user_id, display_name, status)
  VALUES
    (first_user, 'codex-memo-rollback-' || first_user, 'Monthly memo rollback test A', 'pending'),
    (second_user, 'codex-memo-rollback-' || second_user, 'Monthly memo rollback test B', 'pending');

  INSERT INTO public.gw_attendance_monthly_checks (user_id, check_month, checked_by)
  VALUES (first_user, DATE '2099-01-01', first_user),
    (second_user, DATE '2099-01-01', first_user),
    (first_user, DATE '2099-02-01', first_user);

  SELECT * INTO saved FROM public.gw_save_attendance_monthly_note(
    first_user, DATE '2099-01-01', E'月全体の連絡\n二行目 & < >', first_user, NULL
  );
  first_version := saved.updated_at;
  IF saved.memo <> E'月全体の連絡\n二行目 & < >'
    OR EXISTS (SELECT 1 FROM public.gw_attendance_monthly_checks
      WHERE user_id = first_user AND check_month = DATE '2099-01-01')
    OR (SELECT count(*) FROM public.gw_attendance_monthly_checks
      WHERE user_id IN (first_user, second_user)) <> 2 THEN
    RAISE EXCEPTION 'Save / per-staff, per-month review isolation failed';
  END IF;

  INSERT INTO public.gw_attendance_monthly_checks (user_id, check_month, checked_by)
  VALUES (first_user, DATE '2099-01-01', first_user);
  DELETE FROM public.gw_attendance_monthly_checks
  WHERE user_id = first_user AND check_month = DATE '2099-01-01';
  IF NOT EXISTS (SELECT 1 FROM public.gw_attendance_monthly_notes
    WHERE user_id = first_user AND note_month = DATE '2099-01-01') THEN
    RAISE EXCEPTION 'Unchecking discarded memo';
  END IF;

  SELECT * INTO saved FROM public.gw_save_attendance_monthly_note(
    first_user, DATE '2099-01-01', '更新済み', second_user, first_version
  );
  BEGIN
    PERFORM * FROM public.gw_save_attendance_monthly_note(
      first_user, DATE '2099-01-01', '古い画面からの更新', first_user, first_version
    );
    RAISE EXCEPTION 'Stale version was accepted';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.gw_save_attendance_monthly_note(
      first_user, DATE '2099-01-01', '競合する初回保存', first_user, NULL
    );
    RAISE EXCEPTION 'Duplicate initial save was accepted';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.gw_save_attendance_monthly_note(
      first_user, DATE '2099-01-01', repeat('あ', 2001), first_user, saved.updated_at
    );
    RAISE EXCEPTION 'Oversized memo was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.gw_save_attendance_monthly_note(
      first_user, DATE '2099-01-02', '不正な月', first_user, NULL
    );
    RAISE EXCEPTION 'Non-month-start date was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  SELECT * INTO saved FROM public.gw_save_attendance_monthly_note(
    first_user, DATE '2099-01-01', '', first_user, saved.updated_at
  );
  IF saved.memo <> '' OR saved.updated_by <> first_user THEN
    RAISE EXCEPTION 'Clearing memo / audit actor failed';
  END IF;
  IF has_table_privilege('authenticated', 'public.gw_attendance_monthly_notes', 'SELECT')
    OR has_table_privilege('anon', 'public.gw_attendance_monthly_notes', 'SELECT')
    OR has_function_privilege('authenticated', 'public.gw_save_attendance_monthly_note(uuid,date,text,uuid,timestamptz)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.gw_save_attendance_monthly_note(uuid,date,text,uuid,timestamptz)', 'EXECUTE')
    OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.gw_attendance_monthly_notes'::regclass) THEN
    RAISE EXCEPTION 'Monthly memo privileges failed';
  END IF;
END;
$$;
SELECT 'Monthly attendance memo DB checks passed; transaction rolled back' AS result;
ROLLBACK;
