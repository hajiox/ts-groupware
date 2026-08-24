-- Store resumes in a dedicated private Supabase Storage bucket.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'hr-documents',
  'hr-documents',
  false,
  4194304,
  ARRAY['application/pdf']::text[]
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

ALTER TABLE public.gw_hr_documents
  ALTER COLUMN drive_file_id DROP NOT NULL;

ALTER TABLE public.gw_hr_documents
  ADD COLUMN IF NOT EXISTS storage_provider text NOT NULL DEFAULT 'supabase'
    CHECK (storage_provider IN ('supabase', 'google_drive')),
  ADD COLUMN IF NOT EXISTS storage_path text;

COMMENT ON COLUMN public.gw_hr_documents.storage_path
IS 'Private object path in the hr-documents Supabase Storage bucket.';
