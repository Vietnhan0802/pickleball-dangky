// Chạy schema.sql thật trên PGlite (Postgres trong Node) với các stub tối thiểu
// của Supabase: role anon/authenticated và auth.jwt().
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const SCHEMA = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');

const SUPABASE_STUBS = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  end $$;
  create schema if not exists auth;
  create or replace function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
  $$;
`;

let db;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  await db.exec(SCHEMA);
});

const call = async (fn, ...args) => {
  const params = args.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await db.query(`select public.${fn}(${params}) as r`, args);
  return rows[0].r;
};

const errorOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err.message;
  }
  assert.fail('expected an error');
};

const phone = (n) => `09${String(n).padStart(8, '0')}`;

const fill = async (course, count, offset = 0) => {
  for (let i = 0; i < count; i++) {
    await call('register', `Người ${course}-${i + offset}`, phone(course * 100 + i + offset), course);
  }
};

const asAdmin = (email = 'boss@congty.vn') =>
  db.exec(`select set_config('request.jwt.claims', '{"email":"${email}"}', false)`);

test('registers a person into the chosen course', async () => {
  const result = await call('register', '  Nguyễn   Văn A ', '0901 234 567', 4);

  assert.equal(result.status, 'registered');
  assert.equal(result.course_id, 4);
  assert.equal(result.seat, 1);
  assert.equal(result.cancel_code, undefined);

  const status = await call('get_status');
  assert.deepEqual(status.courses[0].members, ['Nguyễn Văn A']);
  assert.equal(status.courses[0].taken, 1);
});

test('normalizes +84 phone numbers so the same person cannot register twice', async () => {
  await call('register', 'Trần B', '0912345678', 4);

  const message = await errorOf(call('register', 'Trần B', '+84 912 345 678', 5));

  assert.equal(message, 'ALREADY_REGISTERED');
});

test('rejects invalid names and phone numbers', async () => {
  assert.equal(await errorOf(call('register', 'A', '0912345678', 4)), 'INVALID_NAME');
  assert.equal(await errorOf(call('register', 'Lê C', '12345', 4)), 'INVALID_PHONE');
  assert.equal(await errorOf(call('register', 'Lê C', '0912345678', 9)), 'INVALID_COURSE');
});

test('locks course 4 once it has 12 people, course 5 stays open', async () => {
  await fill(4, 12);

  assert.equal(await errorOf(call('register', 'Người 13', phone(999), 4)), 'COURSE_FULL');
  const ok = await call('register', 'Người 13', phone(999), 5);
  assert.equal(ok.course_id, 5);
});

test('fill_in_order keeps course 5 closed until course 4 is full', async () => {
  await db.exec('update settings set fill_in_order = true');

  assert.equal(await errorOf(call('register', 'Sớm quá', phone(1), 5)), 'COURSE_NOT_OPEN');
  await fill(4, 12, 10);
  const ok = await call('register', 'Sớm quá', phone(1), 5);
  assert.equal(ok.course_id, 5);
});

test('waitlist only opens when both courses are full, and a freed seat goes to the first in line', async () => {
  assert.equal(await errorOf(call('register', 'Chờ 1', phone(1), null)), 'SEATS_AVAILABLE');
  await fill(4, 12);
  await fill(5, 12);

  const w1 = await call('register', 'Chờ 1', phone(1), null);
  const w2 = await call('register', 'Chờ 2', phone(2), null);
  assert.equal(w1.status, 'waitlist');
  assert.equal(w2.waitlist_position, 2);

  await db.exec("insert into admins values ('boss@congty.vn')");
  await asAdmin();
  const firstInCourse5 = (await call('admin_list')).find((r) => r.phone === phone(500));
  assert.deepEqual(await call('admin_delete', firstInCourse5.id), { ok: true });

  const promoted = await call('lookup', phone(1));
  assert.equal(promoted.status, 'registered');
  assert.equal(promoted.course_id, 5);
  assert.equal((await call('lookup', phone(2))).waitlist_position, 1);
});

test('lookup returns null for unknown phones and seat order for known ones', async () => {
  await fill(4, 3);

  assert.equal(await call('lookup', '0999999999'), null);
  const third = await call('lookup', phone(402));
  assert.equal(third.seat, 3);
  assert.equal(third.full_name, 'Người 4-2');
});

test('the public cannot cancel or delete anyone', async () => {
  await call('register', 'Phạm D', '0911111111', 4);

  const { rows } = await db.query("select count(*)::int as n from pg_proc where proname = 'cancel'");
  assert.equal(rows[0].n, 0);
  assert.equal(await errorOf(call('admin_delete', 1)), 'FORBIDDEN');
  assert.equal(await errorOf(call('admin_move', 1, 5)), 'FORBIDDEN');
});

test('closing registration blocks new sign-ups', async () => {
  await db.exec('update settings set is_open = false');

  assert.equal(await errorOf(call('register', 'Trễ giờ', phone(1), 4)), 'CLOSED');
  assert.equal((await call('get_status')).is_open, false);
});

test('admin functions reject anyone not in the admins table', async () => {
  assert.equal(await errorOf(call('admin_list')), 'FORBIDDEN');
  await asAdmin('stranger@x.vn');
  assert.equal(await errorOf(call('admin_delete', 1)), 'FORBIDDEN');
});

test('admin can list, move, delete and change settings; deleting promotes the waitlist', async () => {
  await db.exec("insert into admins values ('boss@congty.vn')");
  await asAdmin('BOSS@congty.vn');
  await fill(4, 12);
  await fill(5, 11);
  const [someoneIn4] = await call('admin_list');

  // Chuyển 1 người từ khóa 4 sang chỗ trống cuối cùng của khóa 5.
  assert.deepEqual(await call('admin_move', someoneIn4.id, 5), { ok: true });
  assert.deepEqual((await call('get_status')).courses.map((c) => c.taken), [11, 12]);
  const stillIn4 = (await call('admin_list')).find((r) => r.course_id === 4);
  assert.equal(await errorOf(call('admin_move', stillIn4.id, 5)), 'COURSE_FULL');

  // Lấp chỗ cuối khóa 4, thêm 1 người chờ; xóa 1 người khóa 4 → người chờ được lên.
  await call('register', 'Vào sau', phone(1), 4);
  await call('register', 'Chờ', phone(2), null);
  assert.deepEqual(await call('admin_delete', stillIn4.id), { ok: true });
  assert.equal((await call('lookup', phone(2))).course_id, 4);

  // Đưa 1 người về hàng chờ: không bị tự kéo ngược vào chỗ vừa trống.
  const moved = (await call('admin_list')).find((r) => r.phone === phone(1));
  assert.deepEqual(await call('admin_move', moved.id, null), { ok: true });
  assert.equal((await call('lookup', phone(1))).status, 'waitlist');
  assert.equal(await errorOf(call('admin_delete', 999999)), 'NOT_FOUND');

  await call('admin_settings', false, true);
  const after = await call('get_status');
  assert.equal(after.is_open, false);
  assert.equal(after.fill_in_order, true);
});

test('admins can add and remove other admins but never themselves', async () => {
  await db.exec("insert into admins values ('boss@congty.vn')");
  await asAdmin('boss@congty.vn');

  assert.deepEqual(await call('admin_add_admin', '  Linh.Tran@CongTy.vn '), { ok: true });
  assert.deepEqual(await call('admin_add_admin', 'linh.tran@congty.vn'), { ok: true });
  assert.deepEqual(await call('admin_admins'), ['boss@congty.vn', 'linh.tran@congty.vn']);
  assert.equal(await errorOf(call('admin_add_admin', 'khong-phai-email')), 'INVALID_EMAIL');
  assert.equal(await errorOf(call('admin_remove_admin', 'BOSS@congty.vn')), 'CANNOT_REMOVE_SELF');

  // Admin mới đăng nhập được quyền ngay.
  await asAdmin('linh.tran@congty.vn');
  assert.deepEqual(await call('admin_list'), []);
  await asAdmin('boss@congty.vn');
  assert.deepEqual(await call('admin_remove_admin', 'linh.tran@congty.vn'), { ok: true });
  assert.equal(await errorOf(call('admin_remove_admin', 'ai-do@x.vn')), 'NOT_FOUND');

  await asAdmin('linh.tran@congty.vn');
  assert.equal(await errorOf(call('admin_admins')), 'FORBIDDEN');
  assert.equal(await errorOf(call('admin_add_admin', 'hacker@x.vn')), 'FORBIDDEN');
});
