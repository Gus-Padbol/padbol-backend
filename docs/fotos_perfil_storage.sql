-- Run in Supabase SQL editor before enabling profile photo uploads.

INSERT INTO storage.buckets (id, name, public)
VALUES ('fotos-perfil', 'fotos-perfil', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

-- Allow public read access to profile photos.
CREATE POLICY IF NOT EXISTS "Public read fotos-perfil"
ON storage.objects
FOR SELECT
USING (bucket_id = 'fotos-perfil');

-- Service role uploads are handled by supabaseAdmin on the backend.
