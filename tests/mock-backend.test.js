import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockBackend, sampleState } from '../js/mock-backend.js';

const empty = () => ({ ...sampleState(), rows: [], nextId: 1 });

const setup = (state = empty()) => {
  let saved = null;
  let clock = Date.UTC(2026, 8, 30);
  const api = createMockBackend({
    load: () => state,
    save: (s) => { saved = s; },
    now: () => new Date((clock += 1000)),
  });
  return { api, saved: () => saved };
};

const codeOf = (err) => err.code;
const phone = (n) => `09${String(n).padStart(8, '0')}`;
const fill = async (api, course, count, offset = 0) => {
  for (let i = 0; i < count; i++) await api.register(`Người ${i + offset}`, phone(course * 100 + i + offset), course);
};

test('sample data leaves one seat in course 4', async () => {
  const { api } = setup(sampleState());

  const status = await api.getStatus();

  assert.deepEqual(status.courses.map((c) => c.taken), [11, 4]);
  assert.deepEqual(status.courses[0].members[0], { name: 'Nguyễn Minh Anh', nickname: '' });
});

test('register persists, returns seat and code, and rejects duplicates by phone', async () => {
  const { api, saved } = setup();

  const result = await api.register(' Ngô  An ', '+84 901 234 567', 4);

  assert.deepEqual(result, { status: 'registered', course_id: 4, seat: 1, waitlist_position: null });
  assert.equal(saved().rows[0].full_name, 'Ngô An');
  await assert.rejects(api.register('Ngô An', '0901234567', 5), (e) => codeOf(e) === 'ALREADY_REGISTERED');
});

test('register validates input, capacity, order and open state', async () => {
  const { api } = setup();
  await assert.rejects(api.register('A', phone(1), 4), (e) => e.code === 'INVALID_NAME');
  await assert.rejects(api.register('An', '123', 4), (e) => e.code === 'INVALID_PHONE');
  await assert.rejects(api.register('An', phone(1), 7), (e) => e.code === 'INVALID_COURSE');
  await assert.rejects(api.register('An', phone(1), null), (e) => e.code === 'SEATS_AVAILABLE');

  await fill(api, 4, 12);
  await assert.rejects(api.register('An', phone(1), 4), (e) => e.code === 'COURSE_FULL');

  const { api: ordered } = setup({ ...empty(), settings: { is_open: true, fill_in_order: true } });
  await assert.rejects(ordered.register('An', phone(1), 5), (e) => e.code === 'COURSE_NOT_OPEN');

  const { api: closed } = setup({ ...empty(), settings: { is_open: false, fill_in_order: false } });
  await assert.rejects(closed.register('An', phone(1), 4), (e) => e.code === 'CLOSED');
});

test('waitlist and lookup; an admin delete promotes the first person waiting', async () => {
  const { api } = setup();
  await fill(api, 4, 12);
  await fill(api, 5, 12);
  const w = await api.register('Chờ Một', phone(1), null);
  await api.register('Chờ Hai', phone(2), null);

  assert.equal(w.waitlist_position, 1);
  assert.equal(await api.lookup('0999999999'), null);
  await api.signIn('admin@pickleball.local', 'demo');
  const seat = (await api.adminList()).find((r) => r.phone === phone(500));
  assert.deepEqual(await api.adminDelete(seat.id), { ok: true });
  assert.deepEqual(await api.lookup(phone(1)), {
    full_name: 'Chờ Một', nickname: '', status: 'registered', course_id: 5, seat: 12, waitlist_position: null,
  });
  assert.equal((await api.lookup(phone(2))).waitlist_position, 1);
  const waiting = (await api.adminList()).find((r) => r.phone === phone(2));
  assert.deepEqual(await api.adminDelete(waiting.id), { ok: true });
  assert.equal(api.cancel, undefined);
});

test('admin actions require sign-in and keep the rules', async () => {
  const { api } = setup();
  await assert.rejects(api.adminList(), (e) => e.code === 'FORBIDDEN');
  await assert.rejects(api.signIn('x', 'y'), (e) => e.code === 'BAD_LOGIN');
  await api.signIn(api.demoAdmin.email, api.demoAdmin.password);
  assert.deepEqual(api.currentAdmin(), { email: 'admin@pickleball.local' });

  await fill(api, 4, 12);
  await fill(api, 5, 11);
  await api.register('Chờ', phone(1), 4).catch(() => null);
  const [first, second] = await api.adminList();

  assert.deepEqual(await api.adminMove(first.id, 4), { ok: true });
  assert.deepEqual(await api.adminMove(first.id, 5), { ok: true });
  await assert.rejects(api.adminMove(second.id, 5), (e) => e.code === 'COURSE_FULL');
  await assert.rejects(api.adminMove(999, 5), (e) => e.code === 'NOT_FOUND');

  await api.register('Chờ', phone(2), 4);
  assert.deepEqual(await api.adminMove(second.id, null), { ok: true });
  const waiting = (await api.adminList()).find((r) => r.id === second.id);
  assert.equal(waiting.status, 'waitlist');

  assert.deepEqual(await api.adminDelete(first.id), { ok: true });
  assert.equal((await api.lookup(second.phone)).course_id, 5);
  assert.deepEqual(await api.adminDelete(second.id), { ok: true });
  await assert.rejects(api.adminDelete(second.id), (e) => e.code === 'NOT_FOUND');

  await api.adminSettings(false, true);
  const status = await api.getStatus();
  assert.equal(status.is_open, false);
  assert.equal(status.fill_in_order, true);
  await api.adminSettings(null, null);
  assert.equal((await api.getStatus()).is_open, false);

  await api.reset();
  await api.signOut();
  assert.equal(api.currentAdmin(), null);
  assert.deepEqual((await api.getStatus()).courses.map((c) => c.taken), [11, 4]);
});

test('the demo admin can change its password', async () => {
  const { api } = setup();
  await assert.rejects(api.changePassword('matkhaumoi1'), (e) => e.code === 'FORBIDDEN');
  await api.signIn('admin@pickleball.local', 'demo');

  await assert.rejects(api.changePassword('ngan'), (e) => e.code === 'WEAK_PASSWORD');
  assert.deepEqual(await api.changePassword('matkhaumoi1'), { ok: true });
  await api.signOut();
  await assert.rejects(api.signIn('admin@pickleball.local', 'demo'), (e) => e.code === 'BAD_LOGIN');
  await api.signIn('admin@pickleball.local', 'matkhaumoi1');
});

test('admin can edit a person and swap slots like the database does', async () => {
  const { api } = setup();
  await api.signIn('admin@pickleball.local', 'demo');
  await fill(api, 4, 12);
  await fill(api, 5, 12);
  await api.register('Người Chờ', phone(1), null);
  const byPhone = async (p) => (await api.adminList()).find((r) => r.phone === p);

  const a = await byPhone(phone(400));
  assert.deepEqual(await api.adminUpdate(a.id, '  Tên   Mới ', '+84 912 345 678'), { ok: true });
  assert.equal((await byPhone('0912345678')).full_name, 'Tên Mới');
  await assert.rejects(api.adminUpdate(a.id, 'Trùng', phone(401)), (e) => e.code === 'ALREADY_REGISTERED');
  await assert.rejects(api.adminUpdate(a.id, 'A', phone(9)), (e) => e.code === 'INVALID_NAME');
  await assert.rejects(api.adminUpdate(a.id, 'Hợp lệ', '1'), (e) => e.code === 'INVALID_PHONE');
  await assert.rejects(api.adminUpdate(999, 'Hợp lệ', phone(9)), (e) => e.code === 'NOT_FOUND');

  const c = await byPhone(phone(402));
  assert.deepEqual(await api.adminSwap(a.id, c.id), { ok: true });
  assert.equal((await api.lookup(phone(402))).seat, 1);

  const b5 = await byPhone(phone(505));
  const w = await byPhone(phone(1));
  assert.deepEqual(await api.adminSwap(w.id, b5.id), { ok: true });
  assert.equal((await api.lookup(phone(1))).course_id, 5);
  assert.equal((await api.lookup(phone(505))).status, 'waitlist');
  await assert.rejects(api.adminSwap(w.id, 999), (e) => e.code === 'NOT_FOUND');

  await api.signOut();
  await assert.rejects(api.adminSwap(w.id, b5.id), (e) => e.code === 'FORBIDDEN');
});

test('admin can edit a course like the database does', async () => {
  const { api } = setup();
  await fill(api, 4, 12);
  await fill(api, 5, 12);
  await api.register('Chờ 1', phone(1), null);
  await assert.rejects(api.adminUpdateCourse(4, 'Khóa 4', 13, ''), (e) => e.code === 'FORBIDDEN');
  await api.signIn(api.demoAdmin.email, api.demoAdmin.password);

  assert.deepEqual(await api.adminUpdateCourse(4, ' Khóa  sáng ', 13, ' T3 · 18:00 '), { ok: true });
  const [course] = (await api.getStatus()).courses;
  assert.deepEqual([course.name, course.capacity, course.schedule, course.taken], ['Khóa sáng', 13, 'T3 · 18:00', 13]);
  assert.equal((await api.lookup(phone(1))).course_id, 4);

  const codes = await Promise.all([
    api.adminUpdateCourse(4, 'Khóa 4', 12, ''),
    api.adminUpdateCourse(4, ' ', 13, ''),
    api.adminUpdateCourse(4, 'Khóa 4', 0, ''),
    api.adminUpdateCourse(4, 'Khóa 4', 13, 'x'.repeat(121)),
    api.adminUpdateCourse(9, 'Khóa 9', 13, ''),
  ].map((p) => p.catch(codeOf)));
  assert.deepEqual(codes, ['CAPACITY_TOO_SMALL', 'INVALID_COURSE_NAME', 'INVALID_CAPACITY', 'INVALID_SCHEDULE', 'INVALID_COURSE']);
});

test('nickname is optional, shown publicly and editable like the database does', async () => {
  const { api } = setup();
  await api.register('Nguyễn Văn Bình', phone(1), 4, '  Bin   Bin ');
  await api.register('Lê Thu', phone(2), 4);

  const [course] = (await api.getStatus()).courses;
  assert.deepEqual(course.members, [{ name: 'Nguyễn Văn Bình', nickname: 'Bin Bin' }, { name: 'Lê Thu', nickname: '' }]);
  assert.equal((await api.lookup(phone(1))).nickname, 'Bin Bin');
  await assert.rejects(api.register('Dài Quá', phone(3), 4, 'x'.repeat(31)), (e) => e.code === 'INVALID_NICKNAME');

  await api.signIn(api.demoAdmin.email, api.demoAdmin.password);
  const [first] = await api.adminList();
  await api.adminUpdate(first.id, 'Nguyễn Văn Bình', phone(1));
  assert.equal((await api.lookup(phone(1))).nickname, 'Bin Bin');
  await api.adminUpdate(first.id, 'Nguyễn Văn Bình', phone(1), ' Bé Bin ');
  assert.equal((await api.lookup(phone(1))).nickname, 'Bé Bin');
  await assert.rejects(api.adminUpdate(first.id, 'Nguyễn Văn Bình', phone(1), 'x'.repeat(31)), (e) => e.code === 'INVALID_NICKNAME');
});
