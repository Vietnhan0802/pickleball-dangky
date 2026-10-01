-- Pickleball đăng ký khóa 4 & 5
-- Chạy toàn bộ file này trong Supabase → SQL Editor → New query → Run.
-- Chạy lại nhiều lần vẫn an toàn (idempotent), dữ liệu đăng ký không bị xóa.

-- ─── Bảng ────────────────────────────────────────────────────────────────

create table if not exists public.courses (
  id        int primary key,
  name      text not null,
  capacity  int  not null default 12 check (capacity > 0),
  schedule  text not null default ''
);

create table if not exists public.registrations (
  id          bigint generated always as identity primary key,
  full_name   text        not null check (char_length(full_name) between 2 and 80),
  phone       text        not null unique check (phone ~ '^0[0-9]{9}$'),
  course_id   int         references public.courses(id),
  status      text        not null check (status in ('registered', 'waitlist')),
  created_at  timestamptz not null default now(),
  check ((status = 'registered') = (course_id is not null))
);

-- Bỏ tính năng tự hủy: chỉ admin được xóa hoặc chuyển chỗ.
drop function if exists public.cancel(text, text);
alter table public.registrations drop column if exists cancel_code;
alter table public.registrations drop column if exists cancel_attempts;

-- Nickname (tùy chọn) để mọi người nhận ra nhau mà không cần nhớ tên thật.
alter table public.registrations add column if not exists nickname text not null default ''
  check (char_length(nickname) <= 30);

create index if not exists registrations_course_idx on public.registrations (course_id, created_at);

create table if not exists public.settings (
  id             boolean primary key default true check (id),
  fill_in_order  boolean not null default false,
  is_open        boolean not null default true
);

create table if not exists public.admins (
  email text primary key
);

insert into public.courses (id, name, capacity) values
  (4, 'Khóa 4', 12),
  (5, 'Khóa 5', 12)
on conflict (id) do nothing;

insert into public.settings (id) values (true) on conflict (id) do nothing;

insert into public.admins (email) values ('admin@pickleball.local') on conflict do nothing;

-- Không ai được đọc/ghi bảng trực tiếp; mọi thao tác đi qua các hàm bên dưới.
alter table public.courses       enable row level security;
alter table public.registrations enable row level security;
alter table public.settings      enable row level security;
alter table public.admins        enable row level security;

-- ─── Hàm nội bộ ──────────────────────────────────────────────────────────

create or replace function public._normalize_phone(p text)
returns text language sql immutable as $$
  select case
    when d like '84%' and char_length(d) = 11 then '0' || substr(d, 3)
    else d
  end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) s
$$;

create or replace function public._taken(p_course int)
returns int language sql stable as $$
  select count(*)::int from public.registrations
  where course_id = p_course and status = 'registered'
$$;

create or replace function public._is_full(p_course int)
returns boolean language sql stable as $$
  select public._taken(p_course) >= (select capacity from public.courses where id = p_course)
$$;

-- Đưa người chờ lâu nhất vào các chỗ còn trống của khóa.
drop function if exists public._promote_waitlist(int);
create or replace function public._promote_waitlist(p_course int, p_exclude bigint default null)
returns void language plpgsql as $$
declare
  v_next bigint;
begin
  loop
    exit when public._is_full(p_course);
    select id into v_next from public.registrations
      where status = 'waitlist' and id is distinct from p_exclude
      order by created_at, id limit 1;
    exit when v_next is null;
    update public.registrations
      set status = 'registered', course_id = p_course
      where id = v_next;
  end loop;
end $$;

create or replace function public._is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
$$;

create or replace function public._lock()
returns void language sql as $$
  -- Khóa theo transaction: hai người bấm cùng lúc sẽ được xử lý lần lượt.
  select pg_advisory_xact_lock(4545)
$$;

-- ─── Hàm công khai (anon) ────────────────────────────────────────────────

create or replace function public.get_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'is_open',       s.is_open,
    'fill_in_order', s.fill_in_order,
    'waitlist',      (select count(*) from registrations where status = 'waitlist'),
    'courses', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'capacity', c.capacity,
        'schedule', c.schedule,
        'taken', _taken(c.id),
        'members', (
          select coalesce(jsonb_agg(jsonb_build_object('name', r.full_name, 'nickname', r.nickname)
                                    order by r.created_at, r.id), '[]'::jsonb)
          from registrations r where r.course_id = c.id and r.status = 'registered'
        )
      ) order by c.id), '[]'::jsonb)
      from courses c
    )
  )
  from settings s
$$;

drop function if exists public.register(text, text, int);
create or replace function public.register(p_name text, p_phone text, p_course int, p_nickname text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_phone  text := _normalize_phone(p_phone);
  v_name   text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_nick   text := regexp_replace(btrim(coalesce(p_nickname, '')), '\s+', ' ', 'g');
  v_status text;
  v_course int;
  v_s      settings;
  v_row    registrations;
begin
  perform _lock();
  select * into v_s from settings;

  if not v_s.is_open then
    raise exception 'CLOSED' using errcode = 'P0001';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 80 then
    raise exception 'INVALID_NAME' using errcode = 'P0001';
  end if;
  if char_length(v_nick) > 30 then
    raise exception 'INVALID_NICKNAME' using errcode = 'P0001';
  end if;
  if v_phone !~ '^0[0-9]{9}$' then
    raise exception 'INVALID_PHONE' using errcode = 'P0001';
  end if;
  if exists (select 1 from registrations where phone = v_phone) then
    raise exception 'ALREADY_REGISTERED' using errcode = 'P0001';
  end if;

  if p_course is null then
    -- Không chọn khóa = xin vào danh sách chờ, chỉ hợp lệ khi mọi khóa đã đủ.
    if exists (select 1 from courses c where not _is_full(c.id)) then
      raise exception 'SEATS_AVAILABLE' using errcode = 'P0001';
    end if;
    v_status := 'waitlist';
  else
    if not exists (select 1 from courses where id = p_course) then
      raise exception 'INVALID_COURSE' using errcode = 'P0001';
    end if;
    if _is_full(p_course) then
      raise exception 'COURSE_FULL' using errcode = 'P0001';
    end if;
    if v_s.fill_in_order and exists (
      select 1 from courses c where c.id < p_course and not _is_full(c.id)
    ) then
      raise exception 'COURSE_NOT_OPEN' using errcode = 'P0001';
    end if;
    v_status := 'registered';
    v_course := p_course;
  end if;

  insert into registrations (full_name, nickname, phone, course_id, status)
    values (v_name, v_nick, v_phone, v_course, v_status)
    returning * into v_row;

  return jsonb_build_object(
    'status', v_row.status,
    'course_id', v_row.course_id,
    'seat', case when v_row.course_id is null then null else _taken(v_row.course_id) end,
    'waitlist_position', case when v_row.status = 'waitlist' then
      (select count(*) from registrations where status = 'waitlist') end
  );
end $$;

create or replace function public.lookup(p_phone text)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when r.id is null then null else jsonb_build_object(
    'full_name', r.full_name,
    'nickname', r.nickname,
    'status', r.status,
    'course_id', r.course_id,
    'seat', case when r.course_id is null then null else (
      select count(*) from registrations x
      where x.course_id = r.course_id and (x.created_at, x.id) <= (r.created_at, r.id)
    ) end,
    'waitlist_position', case when r.status = 'waitlist' then (
      select count(*) from registrations x
      where x.status = 'waitlist' and (x.created_at, x.id) <= (r.created_at, r.id)
    ) end
  ) end
  from (select 1) one
  left join registrations r on r.phone = _normalize_phone(p_phone)
$$;

-- ─── Hàm admin (cần đăng nhập, email nằm trong bảng admins) ─────────────

create or replace function public.admin_list()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not _is_admin() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at, r.id), '[]'::jsonb)
          from registrations r);
end $$;

create or replace function public.admin_move(p_id bigint, p_course int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_old int;
begin
  if not _is_admin() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  perform _lock();
  select course_id into v_old from registrations where id = p_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_course is not distinct from v_old then return jsonb_build_object('ok', true); end if;

  if p_course is null then
    update registrations set status = 'waitlist', course_id = null, created_at = now() where id = p_id;
  else
    if _is_full(p_course) then raise exception 'COURSE_FULL' using errcode = 'P0001'; end if;
    update registrations set status = 'registered', course_id = p_course where id = p_id;
  end if;
  if v_old is not null then perform _promote_waitlist(v_old, p_id); end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_delete(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_old int;
begin
  if not _is_admin() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  perform _lock();
  delete from registrations where id = p_id returning course_id into v_old;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if v_old is not null then perform _promote_waitlist(v_old); end if;
  return jsonb_build_object('ok', true);
end $$;

-- p_nickname null = giữ nguyên nickname cũ.
drop function if exists public.admin_update(bigint, text, text);
create or replace function public.admin_update(p_id bigint, p_name text, p_phone text, p_nickname text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_phone text := _normalize_phone(p_phone);
  v_name  text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_nick  text := regexp_replace(btrim(p_nickname), '\s+', ' ', 'g');
begin
  if not _is_admin() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  perform _lock();
  if not exists (select 1 from registrations where id = p_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 80 then
    raise exception 'INVALID_NAME' using errcode = 'P0001';
  end if;
  if v_phone !~ '^0[0-9]{9}$' then
    raise exception 'INVALID_PHONE' using errcode = 'P0001';
  end if;
  if char_length(v_nick) > 30 then
    raise exception 'INVALID_NICKNAME' using errcode = 'P0001';
  end if;
  if exists (select 1 from registrations where phone = v_phone and id <> p_id) then
    raise exception 'ALREADY_REGISTERED' using errcode = 'P0001';
  end if;
  update registrations
    set full_name = v_name, phone = v_phone, nickname = coalesce(v_nick, nickname)
    where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- Đổi slot của 2 người: khóa, trạng thái và thứ tự (created_at) hoán đổi cho nhau.
-- Dùng được trong cùng khóa (đổi thứ tự), giữa 2 khóa đầy, hoặc với danh sách chờ.
create or replace function public.admin_swap(p_a bigint, p_b bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_a registrations;
  v_b registrations;
begin
  if not _is_admin() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  perform _lock();
  select * into v_a from registrations where id = p_a;
  select * into v_b from registrations where id = p_b;
  if v_a.id is null or v_b.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  update registrations set course_id = v_b.course_id, status = v_b.status, created_at = v_b.created_at where id = v_a.id;
  update registrations set course_id = v_a.course_id, status = v_a.status, created_at = v_a.created_at where id = v_b.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_settings(p_is_open boolean, p_fill_in_order boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not _is_admin() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  update settings set
    is_open = coalesce(p_is_open, is_open),
    fill_in_order = coalesce(p_fill_in_order, fill_in_order);
  return jsonb_build_object('ok', true);
end $$;

-- Sửa tên, số chỗ, lịch học của khóa. Tăng số chỗ thì người chờ được xếp vào ngay.
create or replace function public.admin_update_course(p_id int, p_name text, p_capacity int, p_schedule text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_name     text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_schedule text := btrim(coalesce(p_schedule, ''));
begin
  if not _is_admin() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  perform _lock();
  if not exists (select 1 from courses where id = p_id) then
    raise exception 'INVALID_COURSE' using errcode = 'P0001';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 40 then
    raise exception 'INVALID_COURSE_NAME' using errcode = 'P0001';
  end if;
  if char_length(v_schedule) > 120 then
    raise exception 'INVALID_SCHEDULE' using errcode = 'P0001';
  end if;
  if p_capacity is null or p_capacity < 1 or p_capacity > 50 then
    raise exception 'INVALID_CAPACITY' using errcode = 'P0001';
  end if;
  if p_capacity < _taken(p_id) then
    raise exception 'CAPACITY_TOO_SMALL' using errcode = 'P0001';
  end if;
  update courses set name = v_name, capacity = p_capacity, schedule = v_schedule where id = p_id;
  perform _promote_waitlist(p_id);
  return jsonb_build_object('ok', true);
end $$;

-- ─── Realtime ────────────────────────────────────────────────────────────
-- Có thay đổi thì phát tín hiệu "changed" (không kèm dữ liệu) lên kênh công khai
-- "pickleball"; trang web nghe được sẽ gọi lại get_status(). Không có Supabase
-- Realtime (ví dụ khi test) thì bỏ qua.
create or replace function public._notify_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    perform realtime.send('{}'::jsonb, 'changed', 'pickleball', false);
  end if;
  return null;
end $$;

drop trigger if exists registrations_notify on public.registrations;
create trigger registrations_notify after insert or update or delete on public.registrations
  for each statement execute function public._notify_change();
drop trigger if exists courses_notify on public.courses;
create trigger courses_notify after insert or update or delete on public.courses
  for each statement execute function public._notify_change();
drop trigger if exists settings_notify on public.settings;
create trigger settings_notify after update on public.settings
  for each statement execute function public._notify_change();

-- Chỉ có 1 tài khoản admin (tên đăng nhập "admin"), không cấp quyền qua giao diện.
drop function if exists public.admin_admins();
drop function if exists public.admin_add_admin(text);
drop function if exists public.admin_remove_admin(text);

-- ─── Quyền ───────────────────────────────────────────────────────────────

revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function public.get_status()                    to anon, authenticated;
grant execute on function public.register(text, text, int, text) to anon, authenticated;
grant execute on function public.lookup(text)                    to anon, authenticated;
grant execute on function public.admin_list()                    to authenticated;
grant execute on function public.admin_move(bigint, int)         to authenticated;
grant execute on function public.admin_delete(bigint)            to authenticated;
grant execute on function public.admin_settings(boolean, boolean) to authenticated;
grant execute on function public.admin_update(bigint, text, text, text) to authenticated;
grant execute on function public.admin_swap(bigint, bigint)      to authenticated;
grant execute on function public.admin_update_course(int, text, int, text) to authenticated;
