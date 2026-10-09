-- Run only after the migration, inside the same explicit BEGIN / ROLLBACK.
-- Synthetic payroll records are never committed, and no DM/Drive API is used.
DO $$
DECLARE
  employee_uuid uuid:=gen_random_uuid();
  profile_uuid uuid;
  payload jsonb;
  received jsonb;
  repeated jsonb;
  conflicted jsonb;
  period_uuid uuid;
  batch_uuid uuid;
  stored_count integer;
  baseline_profiles integer;
BEGIN
  IF has_function_privilege('anon','public.gw_receive_payroll_mail(jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','public.gw_receive_payroll_mail(jsonb)','EXECUTE')
    OR has_table_privilege('anon','public.gw_payroll_mail_jobs','SELECT')
    OR has_table_privilege('authenticated','public.gw_payroll_mail_jobs','SELECT') THEN
    RAISE EXCEPTION 'Payroll service boundary is open';
  END IF;
  IF EXISTS(SELECT 1 FROM public.gw_payroll_periods WHERE payroll_month IN ('2097-02-01','2097-03-01','2097-04-01','2097-05-01')) THEN
    RAISE EXCEPTION 'Synthetic test months are occupied';
  END IF;
  INSERT INTO public.gw_payroll_employees(id,employee_code,display_name,payroll_status)
    VALUES(employee_uuid,'mail-fixture-'||employee_uuid::text,'検証用社員','active');
  INSERT INTO public.gw_payroll_calculation_profiles(employee_id,effective_from,calculation_type,hourly_rate)
    VALUES(employee_uuid,'2097-01-01','hourly',1000) RETURNING id INTO profile_uuid;
  SELECT count(*) INTO baseline_profiles FROM public.gw_payroll_calculation_profiles WHERE employee_id=employee_uuid;
  payload:=jsonb_build_object(
    'mode','import','sourceKey','fixture-mail-001','fingerprint',repeat('a',64),'messageId','fixture-message',
    'attachmentId','fixture-attachment','sha256',repeat('b',64),'payrollMonth','2097-02','attendanceMonth','2097-01','payDate','2097-02-09',
    'reportContent','検証用取込完了','reviewContent','検証用要確認','summary',jsonb_build_object('analysisStage','completed','profileUpdated',false),
    'comparison',jsonb_build_object('counts',jsonb_build_object('employees',1,'compared',1,'mismatches',0,'unverified',0)),
    'totals',jsonb_build_object('employeeCount',1,'paymentTotal',100,'deductionTotal',10,'netPayment',90),
    'documents',jsonb_build_array(jsonb_build_object('path','fixture.zip','name','fixture.zip','extension','.zip','size',100,
      'sha256',repeat('b',64),'documentType','zip_package','status','extracted','summary','{}'::jsonb),
      jsonb_build_object('path','fixture.xlsx','name','fixture.xlsx','extension','.xlsx','size',50,'sha256',repeat('c',64),
      'documentType','payroll_statement','status','extracted','isStatement',true,'summary','{}'::jsonb)),
    'results',jsonb_build_array(jsonb_build_object('employeeId',employee_uuid,'taxablePaymentTotal',100,'nonTaxablePaymentTotal',0,
      'paymentTotal',100,'socialInsuranceTotal',0,'deductionTotal',10,'taxableIncome',100,'netPayment',90,
      'cashPayment',0,'transferPayment',90,'dependentsCount',0,'taxTableCategory','甲','rawPayload','{}'::jsonb,
      'items',jsonb_build_array(jsonb_build_object('code','fixture_salary_mail','name','検証支給','itemType','earning',
        'taxable',true,'sortOrder',999,'amount',100,'minutes',null,'days',null,'rate',null,'rawValue',100)))));
  received:=public.gw_receive_payroll_mail(payload);
  IF received->>'status'<>'imported' OR received->>'report_status'<>'pending' OR received->>'batch_id' IS NULL THEN
    RAISE EXCEPTION 'Initial import/outbox failed';
  END IF;
  period_uuid:=(received->>'payroll_period_id')::uuid;
  batch_uuid:=(received->>'batch_id')::uuid;
  IF (SELECT pay_date FROM public.gw_payroll_periods WHERE id=period_uuid)<>'2097-02-09' THEN RAISE EXCEPTION 'Actual pay date lost'; END IF;
  repeated:=public.gw_receive_payroll_mail(payload);
  IF repeated->>'id'<>received->>'id' OR NOT(repeated->>'duplicate')::boolean THEN RAISE EXCEPTION 'Same source replay failed'; END IF;
  repeated:=public.gw_receive_payroll_mail(payload||jsonb_build_object('sourceKey','fixture-mail-alias','fingerprint',repeat('d',64),'messageId','fixture-forward'));
  IF repeated->>'id'<>received->>'id' OR NOT(repeated->>'duplicate')::boolean THEN RAISE EXCEPTION 'Same ZIP deduplication failed'; END IF;
  BEGIN
    PERFORM public.gw_receive_payroll_mail(payload||jsonb_build_object('fingerprint',repeat('e',64)));
    RAISE EXCEPTION 'Changed source payload was accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  conflicted:=public.gw_receive_payroll_mail(payload||jsonb_build_object('sourceKey','fixture-revision','fingerprint',repeat('f',64),'sha256',repeat('1',64)));
  IF conflicted->>'status'<>'needs_review' OR conflicted->>'reason'<>'existing_payroll' OR conflicted->>'batch_id' IS NOT NULL THEN
    RAISE EXCEPTION 'Revision conflict protection failed';
  END IF;
  IF (SELECT count(*) FROM public.gw_payroll_employee_results WHERE payroll_period_id=period_uuid)<>1
     OR (SELECT payment_total FROM public.gw_payroll_employee_results WHERE payroll_period_id=period_uuid)<>100 THEN
    RAISE EXCEPTION 'Existing payroll was changed';
  END IF;
  IF (SELECT count(*) FROM public.gw_payroll_calculation_profiles WHERE employee_id=employee_uuid)<>baseline_profiles
    OR (SELECT hourly_rate FROM public.gw_payroll_calculation_profiles WHERE id=profile_uuid)<>1000 THEN
    RAISE EXCEPTION 'In-house profile was changed';
  END IF;
  UPDATE public.gw_payroll_periods SET status='locked' WHERE id=period_uuid;
  conflicted:=public.gw_receive_payroll_mail(payload||jsonb_build_object('sourceKey','fixture-locked','fingerprint',repeat('2',64),'sha256',repeat('3',64)));
  IF conflicted->>'reason'<>'period_locked' THEN RAISE EXCEPTION 'Locked period protection failed'; END IF;

  -- Simulate an existing completed manual batch, with the same source hash.
  INSERT INTO public.gw_payroll_periods(payroll_month,payroll_kind,attendance_month,period_start,period_end,pay_date)
    VALUES('2097-03-01','monthly','2097-02-01','2097-02-01','2097-02-28','2097-03-10') RETURNING id INTO period_uuid;
  INSERT INTO public.gw_labor_import_batches(source_root,target_payroll_month,target_attendance_month,payroll_kind,status,summary)
    VALUES('fixture-manual','2097-03-01','2097-02-01','monthly','imported','{"analysisStage":"completed"}') RETURNING id INTO batch_uuid;
  INSERT INTO public.gw_labor_source_documents(import_batch_id,relative_path,file_name,file_extension,sha256)
    VALUES(batch_uuid,'manual.zip','manual.zip','.zip',repeat('4',64));
  INSERT INTO public.gw_payroll_runs(payroll_period_id,source_import_batch_id,status,calculation_mode)
    VALUES(period_uuid,batch_uuid,'calculated','imported') RETURNING id INTO employee_uuid;
  INSERT INTO public.gw_payroll_employee_results(payroll_run_id,payroll_period_id,employee_id,payment_total,deduction_total,net_payment)
    VALUES(employee_uuid,period_uuid,(payload->'results'->0->>'employeeId')::uuid,100,10,90);
  repeated:=public.gw_receive_payroll_mail(payload||jsonb_build_object('sourceKey','fixture-manual-reuse','fingerprint',repeat('5',64),'sha256',repeat('4',64),
    'payrollMonth','2097-03','attendanceMonth','2097-02','payDate','2097-03-10'));
  IF repeated->>'status'<>'imported' OR (repeated->>'batch_id')::uuid<>batch_uuid THEN RAISE EXCEPTION 'Manual batch was not reused'; END IF;
  IF (SELECT import_batch_id FROM public.gw_labor_source_documents WHERE sha256=repeat('4',64))<>batch_uuid THEN
    RAISE EXCEPTION 'Manual source document was moved';
  END IF;

  -- An invalid detail aborts the complete import, including period/batch/outbox.
  SELECT count(*) INTO stored_count FROM public.gw_payroll_mail_jobs;
  BEGIN
    PERFORM public.gw_receive_payroll_mail(payload||jsonb_build_object('sourceKey','fixture-rollback','fingerprint',repeat('6',64),'sha256',repeat('7',64),
      'payrollMonth','2097-04','attendanceMonth','2097-03','payDate','2097-04-10','documents','[]'::jsonb,
      'results',jsonb_build_array((payload->'results'->0)||jsonb_build_object('employeeId','not-a-uuid'))));
    RAISE EXCEPTION 'Invalid employee unexpectedly imported';
  EXCEPTION WHEN invalid_text_representation THEN NULL; END;
  IF EXISTS(SELECT 1 FROM public.gw_payroll_periods WHERE payroll_month='2097-04-01')
    OR (SELECT count(*) FROM public.gw_payroll_mail_jobs)<>stored_count THEN RAISE EXCEPTION 'Partial transaction survived'; END IF;
  repeated:=public.gw_receive_payroll_mail(jsonb_build_object('mode','review','sourceKey','fixture-review','fingerprint',repeat('8',64),
    'messageId','fixture-nozip','reviewReason','attachment_missing','reviewContent','検証用添付なし'));
  IF repeated->>'status'<>'needs_review' OR repeated->>'report_status'<>'pending' OR repeated->>'batch_id' IS NOT NULL THEN
    RAISE EXCEPTION 'ZIP-less review outbox failed';
  END IF;
END $$;
SELECT 'payroll transaction, replay, conflict, manual reuse, profile preservation, locked period, atomic rollback, review outbox passed' AS result;
