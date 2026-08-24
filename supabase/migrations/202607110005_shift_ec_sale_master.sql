create table if not exists public.gw_shift_ec_sales (
  id text primary key,
  label text not null check (char_length(label) between 1 and 100),
  color text not null default 'red' check (color in ('red', 'green', 'orange')),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.gw_shift_ec_sales is 'Editable EC sale labels used in shift notes.';

alter table public.gw_shift_ec_sales enable row level security;

insert into public.gw_shift_ec_sales (id, label, color, sort_order)
values
  ('rakuten_marathon', '楽天お買い物マラソン', 'red', 10),
  ('rakuten_super_sale', '楽天スーパーSALL', 'red', 20),
  ('rakuten_black_friday', '楽天BLACKFRIDAY', 'red', 30),
  ('amazon_smile_sale', 'AmazonスマイルSALL', 'green', 40),
  ('amazon_prime_day', 'Amazonプライムデー', 'green', 50),
  ('amazon_black_friday', 'Amazonブラックフライデー', 'green', 60),
  ('yahoo_five_day', 'Yahoo 5の付く日', 'orange', 70),
  ('yahoo_premium_sunday', 'Yahooプレミアムな日曜日', 'orange', 80),
  ('yahoo_super_paypay', 'Yahoo超PayPay祭り', 'orange', 90),
  ('yahoo_bakugai_week', 'Yahoo爆買いWEEK', 'orange', 100)
on conflict (id) do nothing;

create table if not exists public.gw_shift_cell_styles (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.gw_shift_periods(id) on delete cascade,
  work_date date not null,
  cell_key text not null check (char_length(cell_key) between 1 and 140),
  background_color text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (period_id, work_date, cell_key)
);

comment on table public.gw_shift_cell_styles is 'User-selected background colors for shift grid cells.';

alter table public.gw_shift_cell_styles enable row level security;
