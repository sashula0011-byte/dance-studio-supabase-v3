create extension if not exists pgcrypto;
create extension if not exists btree_gist;

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  date text not null,
  room text not null,
  start integer not null,
  "end" integer not null,
  teacher text not null,
  type text not null,
  note text
);

alter table public.bookings
  add column if not exists time_range int4range
  generated always as (int4range(start, "end", '[]')) stored;

create index if not exists bookings_gist_idx on public.bookings using gist (date, room, time_range);

do $$
begin
  alter table public.bookings
    add constraint no_overlaps exclude using gist (date with =, room with =, time_range with &&);
exception when duplicate_object then null;
end $$;

alter table public.bookings enable row level security;

do $$ begin
  create policy "read all"  on public.bookings for select using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "write all" on public.bookings for insert with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "delete all" on public.bookings for delete using (true);
exception when duplicate_object then null; end $$;

