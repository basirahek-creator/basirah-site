-- Basirah: run this ONCE in Supabase (SQL Editor -> New query -> paste -> Run).
create table if not exists public.kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists kv_key_pattern on public.kv (key text_pattern_ops);
-- nobody can reach the table from the internet; only the back office (service key) can
alter table public.kv enable row level security;

-- private box for receipts, voice answers, pictures and report PDFs
insert into storage.buckets (id, name, public) values ('basirah', 'basirah', false) on conflict (id) do nothing;
