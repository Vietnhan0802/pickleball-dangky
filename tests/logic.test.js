import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhone,
  validateName,
  validatePhone,
  courseAvailability,
  defaultCourse,
  isAllFull,
  initials,
  maskPhone,
  errorMessage,
  rosterText,
  toCsv,
  validatePassword,
  loginEmail,
  displayName,
  validateNickname,
} from '../js/logic.js';

const status = (taken4, taken5, extra = {}) => ({
  is_open: true,
  fill_in_order: false,
  waitlist: 0,
  courses: [
    { id: 4, name: 'Khóa 4', capacity: 12, taken: taken4, members: [] },
    { id: 5, name: 'Khóa 5', capacity: 12, taken: taken5, members: [] },
  ],
  ...extra,
});

test('normalizePhone strips spaces and converts +84 to 0', () => {
  assert.equal(normalizePhone(' 0901 234-567 '), '0901234567');
  assert.equal(normalizePhone('+84 901 234 567'), '0901234567');
  assert.equal(normalizePhone('84901234567'), '0901234567');
  assert.equal(normalizePhone(undefined), '');
});

test('validateName requires 2–80 characters after trimming', () => {
  assert.equal(validateName('  An '), null);
  assert.match(validateName(' A '), /họ tên/i);
  assert.match(validateName('x'.repeat(81)), /quá dài/i);
});

test('validatePhone accepts 10-digit Vietnamese numbers only', () => {
  assert.equal(validatePhone('+84 901 234 567'), null);
  assert.match(validatePhone('12345'), /10 số/);
  assert.match(validatePhone(''), /số điện thoại/i);
});

test('courseAvailability marks full courses as locked', () => {
  const s = status(12, 3);

  assert.deepEqual(courseAvailability(s, 4), { open: false, reason: 'full', left: 0 });
  assert.deepEqual(courseAvailability(s, 5), { open: true, reason: null, left: 9 });
});

test('courseAvailability keeps later courses waiting when fill_in_order is on', () => {
  const s = status(5, 0, { fill_in_order: true });

  assert.deepEqual(courseAvailability(s, 5), { open: false, reason: 'waiting', left: 12 });
  assert.equal(courseAvailability(status(12, 0, { fill_in_order: true }), 5).open, true);
});

test('courseAvailability reports closed registration and unknown courses', () => {
  assert.equal(courseAvailability(status(0, 0, { is_open: false }), 4).reason, 'closed');
  assert.equal(courseAvailability(status(0, 0), 9).reason, 'missing');
});

test('defaultCourse picks the first open course, or null when all are full', () => {
  assert.equal(defaultCourse(status(3, 0)), 4);
  assert.equal(defaultCourse(status(12, 0)), 5);
  assert.equal(defaultCourse(status(12, 12)), null);
  assert.equal(isAllFull(status(12, 12)), true);
  assert.equal(isAllFull(status(12, 11)), false);
});

test('initials uses the given name last, Vietnamese style', () => {
  assert.equal(initials('Nguyễn Văn An'), 'NA');
  assert.equal(initials('linh'), 'L');
  assert.equal(initials('  '), '?');
});

test('maskPhone hides the middle digits', () => {
  assert.equal(maskPhone('0901234567'), '0901•••567');
});

test('errorMessage maps backend codes to friendly Vietnamese text', () => {
  assert.match(errorMessage('ALREADY_REGISTERED'), /đã đăng ký/);
  assert.match(errorMessage('COURSE_FULL'), /vừa đủ người/);
  assert.match(errorMessage('something odd'), /thử lại/);
});

test('toCsv escapes quotes, commas and starts with a BOM for Excel', () => {
  const csv = toCsv([
    { full_name: 'Lê "Bé", Ba', phone: '0901234567', course_id: 4, status: 'registered', created_at: '2026-09-30T01:02:03Z' },
    { full_name: '=cmd', phone: '0911111111', course_id: null, status: 'waitlist', created_at: '2026-09-30T02:00:00Z' },
  ]);
  const lines = csv.slice(1).split('\r\n');

  assert.equal(csv[0], '﻿');
  assert.equal(lines[0], 'STT,Họ tên,Nickname,SĐT,Khóa,Trạng thái,Thời gian');
  assert.ok(lines[1].includes('"Lê ""Bé"", Ba"'));
  // Giữ số 0 đầu khi mở bằng Excel.
  assert.ok(lines[1].includes('"0901 234 567"'));
  assert.ok(lines[2].includes("\"'=cmd\""));
  assert.ok(lines[2].includes('Danh sách chờ'));
});

test('loginEmail maps the admin username to its internal account', () => {
  assert.equal(loginEmail(' Admin '), 'admin@pickleball.local');
  assert.equal(loginEmail(''), '');
});

test('validatePassword requires 8+ characters and a matching confirmation', () => {
  assert.equal(validatePassword('12345678', '12345678'), null);
  assert.match(validatePassword('1234567', '1234567'), /8 ký tự/);
  assert.match(validatePassword('12345678', '12345679'), /không khớp/);
});

test('rosterText numbers names under a heading, without phone numbers', () => {
  assert.equal(
    rosterText('Khóa 4', ['Lê Thu Hà', 'Phạm Đức Huy'], 'T3, T5 · 18:00'),
    'Khóa 4 · T3, T5 · 18:00 (2 người)\n1. Lê Thu Hà\n2. Phạm Đức Huy',
  );
  assert.equal(rosterText('Danh sách chờ', []), 'Danh sách chờ (0 người)');
});

test('displayName appends the nickname only when there is one', () => {
  assert.equal(displayName(' Nguyễn  Văn Bình ', ' Bin '), 'Nguyễn Văn Bình (Bin)');
  assert.equal(displayName('Lê Thu', ''), 'Lê Thu');
  assert.equal(displayName('Lê Thu', undefined), 'Lê Thu');
});

test('validateNickname allows empty and limits length to 30', () => {
  assert.equal(validateNickname(''), null);
  assert.equal(validateNickname('x'.repeat(30)), null);
  assert.match(validateNickname('x'.repeat(31)), /30 ký tự/);
});
