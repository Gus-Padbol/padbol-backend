BEGIN;
CREATE TABLE public.club_imported_contacts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sede_id integer NOT NULL,
  provider text NOT NULL CHECK (provider IN ('playtomic','matchi','generic')),
  source_key text NOT NULL,
  name text NOT NULL,
  email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(sede_id,provider,source_key)
);
CREATE UNIQUE INDEX club_imported_contacts_email ON public.club_imported_contacts(sede_id,email) WHERE email <> '';
CREATE TABLE public.club_import_batches (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sede_id integer NOT NULL,
  provider text NOT NULL,
  fingerprint text NOT NULL,
  created_by uuid NOT NULL,
  inserted_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.club_imported_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_import_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_imported_contacts, public.club_import_batches FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.club_imported_contacts IS 'Contactos importados privados por sede. No son cuentas de autenticación ni saldos o consentimientos transferidos.';
COMMIT;
