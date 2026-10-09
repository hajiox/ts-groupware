-- Payroll mail is a purpose-locked service integration. All payroll writes and
-- the report outbox are committed together; no existing result is replaced.
CREATE TABLE IF NOT EXISTS public.gw_payroll_mail_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  original_source_key text NOT NULL,
  message_id text NOT NULL,
  attachment_id text NOT NULL DEFAULT '',
  zip_sha256 text NOT NULL DEFAULT '',
  payroll_month text NOT NULL DEFAULT '',
  attendance_month text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('imported','needs_review')),
  reason text,
  batch_id uuid REFERENCES public.gw_labor_import_batches(id) ON DELETE RESTRICT,
  payroll_period_id uuid REFERENCES public.gw_payroll_periods(id) ON DELETE RESTRICT,
  comparison jsonb NOT NULL DEFAULT '{}'::jsonb,
  report_content text NOT NULL,
  report_status text NOT NULL DEFAULT 'pending' CHECK (report_status IN ('pending','sent')),
  report_post_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  reported_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.gw_payroll_mail_sources (
  source_key text PRIMARY KEY,
  request_fingerprint text NOT NULL,
  job_id uuid NOT NULL REFERENCES public.gw_payroll_mail_jobs(id) ON DELETE RESTRICT,
  message_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.gw_payroll_mail_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gw_payroll_mail_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gw_payroll_mail_jobs, public.gw_payroll_mail_sources FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.gw_payroll_mail_jobs, public.gw_payroll_mail_sources TO service_role;

CREATE OR REPLACE FUNCTION public.gw_receive_payroll_mail(p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_source text := p_payload->>'sourceKey';
  v_sha text := coalesce(p_payload->>'sha256','');
  v_month text := coalesce(p_payload->>'payrollMonth','');
  v_attendance text := coalesce(p_payload->>'attendanceMonth','');
  v_key text;
  v_job public.gw_payroll_mail_jobs%ROWTYPE;
  v_source_row public.gw_payroll_mail_sources%ROWTYPE;
  v_period public.gw_payroll_periods%ROWTYPE;
  v_existing_batch public.gw_labor_import_batches%ROWTYPE;
  v_existing_run public.gw_payroll_runs%ROWTYPE;
  v_batch uuid;
  v_run uuid;
  v_zip_document uuid;
  v_statement_document uuid;
  v_result uuid;
  v_item uuid;
  v_record jsonb;
  v_detail jsonb;
  v_document jsonb;
  v_reason text := nullif(p_payload->>'reviewReason','');
  v_status text := 'imported';
  v_count integer;
  v_payment numeric;
  v_deduction numeric;
  v_net numeric;
BEGIN
  IF v_source !~ '^[A-Za-z0-9:_-]{1,200}$'
     OR coalesce(p_payload->>'fingerprint','') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Invalid payroll mail identity' USING ERRCODE='22023';
  END IF;
  -- Serialize every ZIP and review event for this payroll month. Rechecks here
  -- protect against concurrent submissions after the application's read phase.
  PERFORM pg_advisory_xact_lock(hashtextextended('payroll-mail:' || coalesce(nullif(v_month,''),v_source),0));
  SELECT * INTO v_source_row FROM public.gw_payroll_mail_sources WHERE source_key=v_source;
  IF FOUND THEN
    IF v_source_row.request_fingerprint <> p_payload->>'fingerprint' THEN
      RAISE EXCEPTION 'Payroll mail source conflict' USING ERRCODE='23505';
    END IF;
    SELECT * INTO v_job FROM public.gw_payroll_mail_jobs WHERE id=v_source_row.job_id;
    RETURN to_jsonb(v_job) || jsonb_build_object('duplicate',true);
  END IF;
  v_key := CASE WHEN p_payload->>'mode'='review' THEN 'review:'||v_source ELSE 'zip:'||v_sha||':'||v_month||':'||v_attendance END;
  SELECT * INTO v_job FROM public.gw_payroll_mail_jobs WHERE idempotency_key=v_key;
  IF FOUND THEN
    INSERT INTO public.gw_payroll_mail_sources(source_key,request_fingerprint,job_id,message_id)
    VALUES(v_source,p_payload->>'fingerprint',v_job.id,p_payload->>'messageId');
    RETURN to_jsonb(v_job) || jsonb_build_object('duplicate',true);
  END IF;

  IF p_payload->>'mode'='import' AND v_reason IS NULL THEN
    IF v_sha !~ '^[a-f0-9]{64}$' OR v_month !~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'
       OR jsonb_array_length(coalesce(p_payload->'results','[]'::jsonb))=0 THEN
      RAISE EXCEPTION 'Invalid validated payroll payload' USING ERRCODE='22023';
    END IF;
    SELECT * INTO v_period FROM public.gw_payroll_periods
      WHERE payroll_month=(v_month||'-01')::date AND payroll_kind='monthly' FOR UPDATE;
    IF FOUND AND (v_period.attendance_month <> (v_attendance||'-01')::date
      OR v_period.pay_date <> (p_payload->>'payDate')::date) THEN
      v_reason := 'period_conflict';
    ELSIF FOUND AND v_period.status IN ('approved','paid','locked','voided','attendance_locked') THEN
      v_reason := 'period_locked';
    END IF;
    SELECT batches.* INTO v_existing_batch FROM public.gw_labor_source_documents documents
      JOIN public.gw_labor_import_batches batches ON batches.id=documents.import_batch_id
      WHERE documents.sha256=v_sha AND documents.file_extension='.zip' LIMIT 1;
    IF FOUND AND v_reason IS NULL THEN
      IF v_existing_batch.target_payroll_month <> (v_month||'-01')::date
         OR v_existing_batch.target_attendance_month <> (v_attendance||'-01')::date
         OR v_existing_batch.payroll_kind <> 'monthly' OR v_existing_batch.status <> 'imported'
         OR coalesce(v_existing_batch.summary->>'analysisStage','') <> 'completed' THEN
        v_reason := 'existing_archive_pending';
      ELSE
        SELECT * INTO v_existing_run FROM public.gw_payroll_runs
          WHERE source_import_batch_id=v_existing_batch.id AND payroll_period_id=v_period.id
          ORDER BY run_number DESC LIMIT 1;
        SELECT count(*),coalesce(sum(payment_total),0),coalesce(sum(deduction_total),0),coalesce(sum(net_payment),0)
          INTO v_count,v_payment,v_deduction,v_net FROM public.gw_payroll_employee_results
          WHERE payroll_run_id=v_existing_run.id;
        IF v_existing_run.id IS NULL OR v_count <> (p_payload->'totals'->>'employeeCount')::integer
           OR v_payment <> (p_payload->'totals'->>'paymentTotal')::numeric
           OR v_deduction <> (p_payload->'totals'->>'deductionTotal')::numeric
           OR v_net <> (p_payload->'totals'->>'netPayment')::numeric THEN
          v_reason := 'existing_archive_pending';
        ELSE
          v_batch := v_existing_batch.id;
        END IF;
      END IF;
    ELSIF v_reason IS NULL AND v_period.id IS NOT NULL AND (
      EXISTS(SELECT 1 FROM public.gw_payroll_runs WHERE payroll_period_id=v_period.id AND status<>'voided')
      OR EXISTS(SELECT 1 FROM public.gw_payroll_employee_results WHERE payroll_period_id=v_period.id)
    ) THEN
      v_reason := 'existing_payroll';
    END IF;
    IF v_reason IS NULL AND v_batch IS NULL THEN
      IF v_period.id IS NULL THEN
        INSERT INTO public.gw_payroll_periods(payroll_month,payroll_kind,attendance_month,period_start,period_end,pay_date)
        VALUES((v_month||'-01')::date,'monthly',(v_attendance||'-01')::date,
          (v_attendance||'-01')::date,((v_attendance||'-01')::date+interval '1 month - 1 day')::date,
          (p_payload->>'payDate')::date) RETURNING * INTO v_period;
      END IF;
      INSERT INTO public.gw_labor_import_batches(source_root,payroll_kind,target_attendance_month,target_payroll_month,
        period_start,period_end,pay_date,status,summary)
      VALUES('gmail-payroll:'||(p_payload->>'messageId'),'monthly',(v_attendance||'-01')::date,(v_month||'-01')::date,
        (v_attendance||'-01')::date,((v_attendance||'-01')::date+interval '1 month - 1 day')::date,
        (p_payload->>'payDate')::date,'imported',p_payload->'summary') RETURNING id INTO v_batch;
      FOR v_document IN SELECT value FROM jsonb_array_elements(p_payload->'documents') LOOP
        INSERT INTO public.gw_labor_source_documents(import_batch_id,relative_path,file_name,file_extension,file_size,sha256,
          document_type,target_attendance_month,target_payroll_month,extraction_status,extraction_notes,extracted_summary)
        VALUES(v_batch,v_document->>'path',v_document->>'name',v_document->>'extension',(v_document->>'size')::bigint,
          v_document->>'sha256',v_document->>'documentType',(v_attendance||'-01')::date,(v_month||'-01')::date,
          v_document->>'status','給与メール原本保存・必須Excel検証済み',v_document->'summary')
        RETURNING id INTO v_item;
        IF v_document->>'documentType'='zip_package' THEN v_zip_document:=v_item; END IF;
        IF v_document->>'isStatement'='true' THEN v_statement_document:=v_item; END IF;
      END LOOP;
      INSERT INTO public.gw_payroll_runs(payroll_period_id,source_import_batch_id,run_number,status,calculation_mode,summary)
      VALUES(v_period.id,v_batch,1,'calculated','imported',p_payload->'summary') RETURNING id INTO v_run;
      FOR v_record IN SELECT value FROM jsonb_array_elements(p_payload->'results') LOOP
        INSERT INTO public.gw_payroll_employee_results(payroll_run_id,payroll_period_id,employee_id,taxable_payment_total,
          non_taxable_payment_total,payment_total,social_insurance_total,deduction_total,taxable_income,net_payment,
          cash_payment,transfer_payment,dependents_count,tax_table_category,source_document_id,raw_payload)
        VALUES(v_run,v_period.id,(v_record->>'employeeId')::uuid,(v_record->>'taxablePaymentTotal')::numeric,
          (v_record->>'nonTaxablePaymentTotal')::numeric,(v_record->>'paymentTotal')::numeric,
          (v_record->>'socialInsuranceTotal')::numeric,(v_record->>'deductionTotal')::numeric,
          (v_record->>'taxableIncome')::numeric,(v_record->>'netPayment')::numeric,(v_record->>'cashPayment')::numeric,
          (v_record->>'transferPayment')::numeric,(v_record->>'dependentsCount')::integer,
          v_record->>'taxTableCategory',v_statement_document,v_record->'rawPayload') RETURNING id INTO v_result;
        FOR v_detail IN SELECT value FROM jsonb_array_elements(v_record->'items') LOOP
          INSERT INTO public.gw_payroll_items(code,name,item_type,taxable,is_system,sort_order)
          VALUES(v_detail->>'code',v_detail->>'name',v_detail->>'itemType',(v_detail->>'taxable')::boolean,true,
            (v_detail->>'sortOrder')::integer) ON CONFLICT(code) DO NOTHING;
          SELECT id INTO STRICT v_item FROM public.gw_payroll_items WHERE code=v_detail->>'code';
          INSERT INTO public.gw_payroll_result_items(payroll_result_id,payroll_item_id,amount,minutes,days,rate,source_document_id,raw_payload)
          VALUES(v_result,v_item,(v_detail->>'amount')::numeric,(v_detail->>'minutes')::integer,
            (v_detail->>'days')::numeric,(v_detail->>'rate')::numeric,v_statement_document,
            jsonb_build_object('source','payroll_mail','rawValue',v_detail->'rawValue'));
        END LOOP;
      END LOOP;
      -- No calculation-profile insert/update occurs in this integration.
    END IF;
  END IF;
  IF v_reason IS NOT NULL OR p_payload->>'mode'='review' THEN v_status:='needs_review'; END IF;
  INSERT INTO public.gw_payroll_mail_jobs(idempotency_key,original_source_key,message_id,attachment_id,zip_sha256,
    payroll_month,attendance_month,status,reason,batch_id,payroll_period_id,comparison,report_content)
  VALUES(v_key,v_source,p_payload->>'messageId',coalesce(p_payload->>'attachmentId',''),v_sha,v_month,v_attendance,
    v_status,v_reason,v_batch,v_period.id,coalesce(p_payload->'comparison','{}'::jsonb),
    CASE WHEN v_status='needs_review' THEN p_payload->>'reviewContent' ELSE p_payload->>'reportContent' END)
  RETURNING * INTO v_job;
  INSERT INTO public.gw_payroll_mail_sources(source_key,request_fingerprint,job_id,message_id)
  VALUES(v_source,p_payload->>'fingerprint',v_job.id,p_payload->>'messageId');
  RETURN to_jsonb(v_job) || jsonb_build_object('duplicate',false);
END $$;
REVOKE ALL ON FUNCTION public.gw_receive_payroll_mail(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gw_receive_payroll_mail(jsonb) TO service_role;
