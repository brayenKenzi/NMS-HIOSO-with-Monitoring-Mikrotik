-- ============================================================
-- MOMO NET NMS — SUPABASE CLOUD SCHEMA
-- Jalankan skrip ini di: Supabase Dashboard -> SQL Editor -> New Query -> Run
-- ============================================================

-- 1. Tabel Akun Pengguna (Admin & Teknisi)
CREATE TABLE IF NOT EXISTS public.nms_users (
    username TEXT PRIMARY KEY,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'technician',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Tabel Pengaturan Sistem (PIN Cepat, Router MikroTik, dll)
CREATE TABLE IF NOT EXISTS public.nms_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Tabel Daftar OLT (Disinkronkan ke seluruh HP Teknisi & Admin)
CREATE TABLE IF NOT EXISTS public.nms_olts (
    host TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    community TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 161,
    admin_user TEXT,
    admin_password TEXT,
    oids JSONB,
    rx_divider NUMERIC DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Tabel Log Tindakan ONU (Audit Trail Bersama Realtime)
CREATE TABLE IF NOT EXISTS public.nms_audit (
    id BIGSERIAL PRIMARY KEY,
    at BIGINT NOT NULL,
    username TEXT NOT NULL,
    host TEXT NOT NULL,
    mac TEXT NOT NULL,
    operation TEXT NOT NULL DEFAULT 'reboot',
    outcome TEXT NOT NULL DEFAULT 'request',
    recovery TEXT,
    client_name TEXT,
    onu_index TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nms_audit_at ON public.nms_audit(at DESC);

-- 5. Tabel Alarm Terpusat
CREATE TABLE IF NOT EXISTS public.nms_alarms (
    id BIGSERIAL PRIMARY KEY,
    key TEXT NOT NULL,
    at BIGINT NOT NULL,
    until BIGINT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nms_alarms_key ON public.nms_alarms(key);

-- Aktifkan Row Level Security (RLS) & Kebijakan Akses Penuh untuk Service/Anon Key
ALTER TABLE public.nms_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nms_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nms_olts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nms_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nms_alarms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all access to nms_users" ON public.nms_users;
CREATE POLICY "Allow all access to nms_users" ON public.nms_users FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all access to nms_settings" ON public.nms_settings;
CREATE POLICY "Allow all access to nms_settings" ON public.nms_settings FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all access to nms_olts" ON public.nms_olts;
CREATE POLICY "Allow all access to nms_olts" ON public.nms_olts FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all access to nms_audit" ON public.nms_audit;
CREATE POLICY "Allow all access to nms_audit" ON public.nms_audit FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all access to nms_alarms" ON public.nms_alarms;
CREATE POLICY "Allow all access to nms_alarms" ON public.nms_alarms FOR ALL USING (true) WITH CHECK (true);
