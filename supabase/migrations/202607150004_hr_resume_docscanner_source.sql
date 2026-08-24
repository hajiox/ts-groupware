-- Idempotency metadata for DocScanner -> TSG resume imports.

ALTER TABLE public.gw_hr_documents
  ADD COLUMN IF NOT EXISTS source_system text,
  ADD COLUMN IF NOT EXISTS source_document_id text,
  ADD COLUMN IF NOT EXISTS source_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_gw_hr_documents_source_key
  ON public.gw_hr_documents(source_key)
  WHERE source_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gw_hr_documents_source_document
  ON public.gw_hr_documents(source_system, source_document_id)
  WHERE source_system IS NOT NULL AND source_document_id IS NOT NULL;

COMMENT ON COLUMN public.gw_hr_documents.source_key
IS 'Idempotency key supplied by an external source such as DocScanner.';
