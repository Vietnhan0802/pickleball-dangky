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
  assert.deepEqual(status.courses[0].members, [{ name: 'Nguyễn Văn A', nickname: '' }]);
  assert.equal(status.courses[0].taken, 1);
});

test('nickname is optional, cleaned, shown publicly and editable by admin', async () => {
  await call('register', 'Nguyễn Văn Bình', phone(1), 4, '  Bin   Bin ');
  await call('register', 'Lê Thu', phone(2), 4);

  const status = await call('get_status');
  assert.deepEqual(status.courses[0].members, [
    { name: 'Nguyễn Văn Bình', nickname: 'Bin Bin' },
    { name: 'Lê Thu', nickname: '' },
  ]);
  assert.equal((await call('lookup', phone(1))).nickname, 'Bin Bin');
  assert.equal(await errorOf(call('register', 'Dài Quá', phone(3), 4, 'x'.repeat(31))), 'INVALID_NICKNAME');

  await asAdmin('admin@pickleball.local');
  const [first] = await call('admin_list');
  assert.equal(first.nickname, 'Bin Bin');
  // Không truyền nickname: giữ nguyên.
  await call('admin_update', first.id, 'Nguyễn Văn Bình', phone(1));
  assert.equal((await call('lookup', phone(1))).nickname, 'Bin Bin');
  await call('admin_update', first.id, 'Nguyễn Văn Bình', phone(1), ' Bé Bin ');
  assert.equal((await call('lookup', phone(1))).nickname, 'Bé Bin');
  await call('admin_update', first.id, 'Nguyễn Văn Bình', phone(1), '');
  assert.equal((await call('lookup', phone(1))).nickname, '');
  assert.equal(await errorOf(call('admin_update', first.id, 'Nguyễn Văn Bình', phone(1), 'x'.repeat(31))), 'INVALID_NICKNAME');
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

test('the single admin account is seeded and admin management is not exposed', async () => {
  const { rows } = await db.query('select email from admins');
  assert.deepEqual(rows, [{ email: 'admin@pickleball.local' }]);

  const fns = await db.query("select proname from pg_proc where proname in ('admin_admins', 'admin_add_admin', 'admin_remove_admin')");
  assert.equal(fns.rows.length, 0);

  await asAdmin('admin@pickleball.local');
  assert.deepEqual(await call('admin_list'), []);
});

test('admin can edit a registration; phone stays unique and validated', async () => {
  await asAdmin('admin@pickleball.local');
  await call('register', 'Người Cũ', phone(1), 4);
  await call('register', 'Người Khác', phone(2), 4);
  const [first] = await call('admin_list');

  assert.deepEqual(await call('admin_update', first.id, '  Người   Mới ', '+84 912 345 678'), { ok: true });
  const [edited] = await call('admin_list');
  assert.equal(edited.full_name, 'Người Mới');
  assert.equal(edited.phone, '0912345678');
  assert.equal(edited.course_id, 4);

  assert.equal(await errorOf(call('admin_update', first.id, 'Trùng', phone(2))), 'ALREADY_REGISTERED');
  assert.equal(await errorOf(call('admin_update', first.id, 'A', phone(3))), 'INVALID_NAME');
  assert.equal(await errorOf(call('admin_update', first.id, 'Hợp lệ', '123')), 'INVALID_PHONE');
  assert.equal(await errorOf(call('admin_update', 999, 'Hợp lệ', phone(3))), 'NOT_FOUND');
  await asAdmin('stranger@x.vn');
  assert.equal(await errorOf(call('admin_update', first.id, 'Hack', phone(3))), 'FORBIDDEN');
});

test('admin can swap two slots: within a course, across full courses, and with the waitlist', async () => {
  await asAdmin('admin@pickleball.local');
  await fill(4, 12);
  await fill(5, 12);
  await call('register', 'Người Chờ', phone(1), null);
  const byPhone = async (p) => (await call('admin_list')).find((r) => r.phone === p);

  // Trong cùng khóa: người số 1 và số 3 đổi thứ tự.
  const a = await byPhone(phone(400));
  const c = await byPhone(phone(402));
  assert.deepEqual(await call('admin_swap', a.id, c.id), { ok: true });
  assert.equal((await call('lookup', phone(402))).seat, 1);
  assert.equal((await call('lookup', phone(400))).seat, 3);

  // Giữa 2 khóa đều đầy.
  const b5 = await byPhone(phone(505));
  assert.deepEqual(await call('admin_swap', a.id, b5.id), { ok: true });
  assert.equal((await call('lookup', phone(400))).course_id, 5);
  assert.equal((await call('lookup', phone(505))).course_id, 4);
  assert.deepEqual((await call('get_status')).courses.map((x) => x.taken), [12, 12]);

  // Với danh sách chờ.
  const w = await byPhone(phone(1));
  assert.deepEqual(await call('admin_swap', w.id, b5.id), { ok: true });
  assert.equal((await call('lookup', phone(1))).course_id, 4);
  assert.equal((await call('lookup', phone(505))).status, 'waitlist');

  assert.equal(await errorOf(call('admin_swap', w.id, 999)), 'NOT_FOUND');
  await asAdmin('stranger@x.vn');
  assert.equal(await errorOf(call('admin_swap', w.id, b5.id)), 'FORBIDDEN');
});

test('admin can edit a course; raising capacity pulls people off the waitlist', async () => {
  await db.exec("insert into admins values ('boss@congty.vn')");
  await fill(4, 12);
  await fill(5, 12);
  await call('register', 'Chờ 1', phone(1), null);
  await call('register', 'Chờ 2', phone(2), null);
  assert.equal(await errorOf(call('admin_update_course', 4, 'Khóa 4', 14, '')), 'FORBIDDEN');
  await asAdmin();

  assert.deepEqual(await call('admin_update_course', 4, '  Khóa   sáng ', 13, ' T3, T5 · 18:00 '), { ok: true });
  const course = (await call('get_status')).courses[0];
  assert.deepEqual([course.name, course.capacity, course.schedule, course.taken], ['Khóa sáng', 13, 'T3, T5 · 18:00', 13]);
  assert.equal((await call('lookup', phone(1))).course_id, 4);
  assert.equal((await call('lookup', phone(2))).status, 'waitlist');

  assert.equal(await errorOf(call('admin_update_course', 4, 'Khóa 4', 12, '')), 'CAPACITY_TOO_SMALL');
  assert.equal(await errorOf(call('admin_update_course', 4, ' ', 13, '')), 'INVALID_COURSE_NAME');
  assert.equal(await errorOf(call('admin_update_course', 4, 'Khóa 4', 0, '')), 'INVALID_CAPACITY');
  assert.equal(await errorOf(call('admin_update_course', 4, 'Khóa 4', 13, 'x'.repeat(121))), 'INVALID_SCHEDULE');
  assert.equal(await errorOf(call('admin_update_course', 9, 'Khóa 9', 13, '')), 'INVALID_COURSE');
});

test('changes fire the realtime notifier without Supabase Realtime installed', async () => {
  const { rows } = await db.query(
    "select tgname from pg_trigger where tgname like '%_notify' order by tgname");
  assert.deepEqual(rows.map((r) => r.tgname), ['courses_notify', 'registrations_notify', 'settings_notify']);

  // Có realtime.send thì mỗi thay đổi phát đúng 1 tín hiệu, không kèm dữ liệu cá nhân.
  await db.exec(`
    create schema realtime;
    create table realtime.sent (payload jsonb, event text, topic text, private boolean);
    create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
      returns void language sql as $$ insert into realtime.sent values (payload, event, topic, private) $$;
  `);
  await call('register', 'Người mới', phone(1), 4);
  const sent = await db.query('select * from realtime.sent');
  assert.deepEqual(sent.rows, [{ payload: {}, event: 'changed', topic: 'pickleball', private: false }]);
});
