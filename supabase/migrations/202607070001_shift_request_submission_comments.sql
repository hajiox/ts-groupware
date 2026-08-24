alter table public.gw_shift_request_submissions
  add column if not exists request_comment text;
