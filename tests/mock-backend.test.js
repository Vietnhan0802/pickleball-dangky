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
    random: () => 0.1234,
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
  assert.equal(status.courses[0].members[0], 'Nguyễn Minh Anh');
});

test('register persists, returns seat and code, and rejects duplicates by phone', async () => {
  const { api, saved } = setup();

  const result = await api.register(' Ngô  An ', '+84 901 234 567', 4);

  assert.deepEqual(result, { status: 'registered', course_id: 4, seat: 1, waitlist_position: null, cancel_code: '1234' });
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

test('waitlist, lookup and cancel promote the first person waiting', async () => {
  const { api } = setup();
  await fill(api, 4, 12);
  await fill(api, 5, 12);
  const w = await api.register('Chờ Một', phone(1), null);
  await api.register('Chờ Hai', phone(2), null);

  assert.equal(w.waitlist_position, 1);
  assert.equal(await api.lookup('0999999999'), null);
  assert.deepEqual(await api.cancel(phone(500), '0000'), { ok: false, error: 'WRONG_CODE', attempts_left: 4 });
  assert.deepEqual(await api.cancel(phone(500), '1234'), { ok: true });
  assert.deepEqual(await api.lookup(phone(1)), {
    full_name: 'Chờ Một', status: 'registered', course_id: 5, seat: 12, waitlist_position: null,
  });
  assert.equal((await api.lookup(phone(2))).waitlist_position, 1);
  await assert.rejects(api.cancel('0999999999', '1'), (e) => e.code === 'NOT_FOUND');
  assert.deepEqual(await api.cancel(phone(2), '1234'), { ok: true });
});

test('cancel locks after five wrong codes', async () => {
  const { api } = setup();
  await api.register('Phạm D', phone(1), 4);
  for (let i = 0; i < 5; i++) await api.cancel(phone(1), '9999');

  await assert.rejects(api.cancel(phone(1), '1234'), (e) => e.code === 'TOO_MANY_ATTEMPTS');
});

test('admin actions require sign-in and keep the rules', async () => {
  const { api } = setup();
  await assert.rejects(api.adminList(), (e) => e.code === 'FORBIDDEN');
  await assert.rejects(api.signIn('x', 'y'), (e) => e.code === 'BAD_LOGIN');
  await api.signIn(api.demoAdmin.email, api.demoAdmin.password);
  assert.deepEqual(api.currentAdmin(), { email: 'admin@demo' });

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
