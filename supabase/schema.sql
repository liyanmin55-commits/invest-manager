-- 投资管家 · 云端同步表结构
-- 在 Supabase 控制台 -> SQL Editor 全选执行一次即可。
-- 用途：把持仓流水(transactions)与定投计划(plans)同步到云端，实现手机/电脑多端一致。

-- ① 交易流水
create table if not exists public.transactions (
  id          text primary key,
  owner       text not null default '',
  plan_id     text,
  account     text,
  symbol      text,
  name        text,
  asset       text,
  type        text,
  quantity    numeric,
  price       numeric,
  fee         numeric,
  date        text,
  risk        text,
  discount    numeric,
  created_at  timestamptz default now()
);

-- ② 定投计划
create table if not exists public.plans (
  id          text primary key,
  owner       text not null default '',
  symbol      text,
  name        text,
  asset       text,
  amount      numeric,
  freq        text,
  day         int,
  last_run    text,
  risk        text,
  created_at  timestamptz default now()
);

create index if not exists idx_tx_owner    on public.transactions(owner);
create index if not exists idx_plan_owner  on public.plans(owner);

-- ③ 行级安全
-- 说明：这是「个人单机同步」用途，默认对 anon 角色开放读写，
-- 业务层用 owner 字段做逻辑隔离（不同 owner 互不看见彼此数据）。
-- 数据敏感度中等（是你的持仓汇总，非账户凭据），可接受。
-- 如需强隔离，请改为启用 Supabase Auth 邮箱登录并改写下方策略用 auth.uid()。
alter table public.transactions enable row level security;
alter table public.plans        enable row level security;

drop policy if exists "anon_all_tx" on public.transactions;
create policy "anon_all_tx" on public.transactions
  for all to anon using (true) with check (true);

drop policy if exists "anon_all_plans" on public.plans;
create policy "anon_all_plans" on public.plans
  for all to anon using (true) with check (true);
