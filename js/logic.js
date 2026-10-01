// Hàm thuần (không đụng DOM/mạng) dùng chung cho trang đăng ký và trang admin.
// Luật thật nằm ở database (supabase/schema.sql); ở đây chỉ để báo lỗi sớm cho người dùng.

const PHONE_PATTERN = /^0\d{9}$/;
const NAME_MIN = 2;
const NAME_MAX = 80;
export const NICKNAME_MAX = 30;

/** @param {string | undefined | null} raw @returns {string} */
export function normalizePhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.startsWith('84') && digits.length === 11 ? `0${digits.slice(2)}` : digits;
}

/** @param {string} name @returns {string} */
export function cleanName(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ');
}

/** @param {string} name @returns {string | null} lỗi, hoặc null nếu hợp lệ */
export function validateName(name) {
  const value = cleanName(name);
  if (value.length < NAME_MIN) return 'Nhập họ tên đầy đủ giúp mình nhé.';
  if (value.length > NAME_MAX) return 'Họ tên quá dài (tối đa 80 ký tự).';
  return null;
}

/** Nickname không bắt buộc, chỉ giới hạn độ dài. @param {string} nickname @returns {string | null} */
export function validateNickname(nickname) {
  if (cleanName(nickname).length > NICKNAME_MAX) return `Nickname tối đa ${NICKNAME_MAX} ký tự.`;
  return null;
}

/** "Nguyễn Văn An" + "Bin" → "Nguyễn Văn An - Bin"; không có nickname thì giữ tên. */
export function displayName(name, nickname) {
  const nick = cleanName(nickname);
  return nick ? `${cleanName(name)} - ${nick}` : cleanName(name);
}

/** @param {string} phone @returns {string | null} */
export function validatePhone(phone) {
  const value = normalizePhone(phone);
  if (!value) return 'Nhập số điện thoại để giữ chỗ.';
  if (!PHONE_PATTERN.test(value)) return 'Số điện thoại cần đủ 10 số, bắt đầu bằng 0.';
  return null;
}

const ADMIN_DOMAIN = 'pickleball.local';
const PASSWORD_MIN = 8;

/** Tên đăng nhập "admin" → tài khoản nội bộ admin@pickleball.local của Supabase. */
export function loginEmail(username) {
  const value = String(username ?? '').trim().toLowerCase();
  return value ? `${value}@${ADMIN_DOMAIN}` : '';
}

/** @param {string} password @param {string} confirm @returns {string | null} */
export function validatePassword(password, confirm) {
  if (String(password ?? '').length < PASSWORD_MIN) return errorMessage('WEAK_PASSWORD');
  if (password !== confirm) return 'Hai mật khẩu không khớp.';
  return null;
}

/**
 * @typedef {{ name: string, nickname?: string }} Member
 * @typedef {{ id: number, name: string, capacity: number, taken: number, schedule?: string, members: Member[] }} Course
 * @typedef {{ is_open: boolean, fill_in_order: boolean, waitlist: number, courses: Course[] }} Status
 * @typedef {{ open: boolean, reason: null | 'full' | 'waiting' | 'closed' | 'missing', left: number }} Availability
 */

/** @param {Status} status @param {number} courseId @returns {Availability} */
export function courseAvailability(status, courseId) {
  const course = status.courses.find((c) => c.id === courseId);
  if (!course) return { open: false, reason: 'missing', left: 0 };

  const left = Math.max(course.capacity - course.taken, 0);
  if (!status.is_open) return { open: false, reason: 'closed', left };
  if (left === 0) return { open: false, reason: 'full', left };

  const earlierOpen = status.courses.some((c) => c.id < courseId && c.taken < c.capacity);
  if (status.fill_in_order && earlierOpen) return { open: false, reason: 'waiting', left };

  return { open: true, reason: null, left };
}

/** @param {Status} status @returns {boolean} */
export function isAllFull(status) {
  return status.courses.every((c) => c.taken >= c.capacity);
}

/** @param {Status} status @returns {number | null} */
export function defaultCourse(status) {
  const open = status.courses.find((c) => courseAvailability(status, c.id).open);
  return open ? open.id : null;
}

/** Tên riêng (chữ cuối) đứng cuối, giống cách gọi tên ở Việt Nam: "Nguyễn Văn An" → "NA". */
export function initials(name) {
  const words = cleanName(name).split(' ').filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : '';
  return (first + last).toUpperCase();
}

/** @param {string} phone @returns {string} */
export function maskPhone(phone) {
  const p = normalizePhone(phone);
  return p.length === 10 ? `${p.slice(0, 4)}•••${p.slice(7)}` : p;
}

/** @param {string} phone @returns {string} */
export function formatPhone(phone) {
  const p = normalizePhone(phone);
  return p.length === 10 ? `${p.slice(0, 4)} ${p.slice(4, 7)} ${p.slice(7)}` : p;
}

const ERRORS = {
  ALREADY_REGISTERED: 'Số điện thoại này đã đăng ký rồi. Mỗi người chỉ giữ được 1 chỗ — tra cứu bên dưới để xem khóa của bạn.',
  COURSE_FULL: 'Khóa này vừa đủ người. Bạn chọn khóa còn lại nhé.',
  ADMIN_COURSE_FULL: 'Khóa đó đã đủ người. Dùng nút ⇄ để đổi chỗ với một người trong khóa đó.',
  COURSE_NOT_OPEN: 'Khóa này mở khi khóa trước đủ người.',
  SEATS_AVAILABLE: 'Vẫn còn chỗ trống — chọn một khóa để giữ chỗ luôn.',
  CLOSED: 'Đăng ký đang tạm đóng.',
  INVALID_NAME: 'Họ tên chưa hợp lệ.',
  INVALID_NICKNAME: 'Nickname tối đa 30 ký tự.',
  INVALID_PHONE: 'Số điện thoại cần đủ 10 số, bắt đầu bằng 0.',
  INVALID_COURSE: 'Khóa học không tồn tại.',
  INVALID_COURSE_NAME: 'Tên khóa cần 1–40 ký tự.',
  INVALID_SCHEDULE: 'Lịch học tối đa 120 ký tự.',
  INVALID_CAPACITY: 'Số chỗ phải từ 1 đến 50.',
  CAPACITY_TOO_SMALL: 'Số chỗ không được ít hơn số người đang có trong khóa. Chuyển bớt người ra trước nhé.',
  NOT_FOUND: 'Không tìm thấy đăng ký với số điện thoại này.',
  FORBIDDEN: 'Tài khoản này không có quyền quản trị.',
  BAD_LOGIN: 'Sai tên đăng nhập hoặc mật khẩu.',
  WEAK_PASSWORD: 'Mật khẩu cần ít nhất 8 ký tự.',
  SESSION_EXPIRED: 'Phiên đăng nhập đã hết hạn, đăng nhập lại nhé.',
  NETWORK: 'Mất kết nối. Kiểm tra mạng rồi thử lại.',
};

/** @param {string} code @returns {string} */
export function errorMessage(code) {
  return ERRORS[code] ?? 'Có lỗi xảy ra, bạn thử lại sau ít phút nhé.';
}

/** Danh sách dạng text để dán vào nhóm Zalo. Chỉ có tên, không có SĐT. */
export function rosterText(title, names, schedule = '') {
  const head = [title, schedule].filter(Boolean).join(' · ');
  const lines = names.map((name, i) => `${i + 1}. ${name}`);
  return [`${head} (${names.length} người)`, ...lines].join('\n');
}

/** Chặn chèn công thức khi mở CSV bằng Excel (=, +, -, @). */
function csvCell(value) {
  const text = String(value ?? '');
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

const STATUS_LABEL = { registered: 'Đã có chỗ', waitlist: 'Danh sách chờ' };

/** @param {Array<{ full_name: string, nickname?: string, phone: string, course_id: number | null, status: string, created_at: string }>} rows */
export function toCsv(rows) {
  const header = 'STT,Họ tên,Nickname,SĐT,Khóa,Trạng thái,Thời gian';
  const body = rows.map((r, i) => [
    i + 1,
    r.full_name,
    r.nickname ?? '',
    formatPhone(r.phone),
    r.course_id ? `Khóa ${r.course_id}` : '',
    STATUS_LABEL[r.status] ?? r.status,
    new Date(r.created_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
  ].map(csvCell).join(','));
  return '﻿' + [header, ...body].join('\r\n');
}
