// Hàm thuần (không đụng DOM/mạng) dùng chung cho trang đăng ký và trang admin.
// Luật thật nằm ở database (supabase/schema.sql); ở đây chỉ để báo lỗi sớm cho người dùng.

const PHONE_PATTERN = /^0\d{9}$/;
const NAME_MIN = 2;
const NAME_MAX = 80;

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

/** @param {string} phone @returns {string | null} */
export function validatePhone(phone) {
  const value = normalizePhone(phone);
  if (!value) return 'Nhập số điện thoại để giữ chỗ.';
  if (!PHONE_PATTERN.test(value)) return 'Số điện thoại cần đủ 10 số, bắt đầu bằng 0.';
  return null;
}

/**
 * @typedef {{ id: number, name: string, capacity: number, taken: number, schedule?: string, members: string[] }} Course
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
  COURSE_NOT_OPEN: 'Khóa này mở khi khóa trước đủ người.',
  SEATS_AVAILABLE: 'Vẫn còn chỗ trống — chọn một khóa để giữ chỗ luôn.',
  CLOSED: 'Đăng ký đang tạm đóng.',
  INVALID_NAME: 'Họ tên chưa hợp lệ.',
  INVALID_PHONE: 'Số điện thoại cần đủ 10 số, bắt đầu bằng 0.',
  INVALID_COURSE: 'Khóa học không tồn tại.',
  NOT_FOUND: 'Không tìm thấy đăng ký với số điện thoại này.',
  WRONG_CODE: 'Mã hủy chưa đúng.',
  TOO_MANY_ATTEMPTS: 'Nhập sai mã quá 5 lần. Liên hệ người tổ chức để được hủy giúp.',
  FORBIDDEN: 'Tài khoản này không có quyền quản trị.',
  BAD_LOGIN: 'Sai email hoặc mật khẩu.',
  SESSION_EXPIRED: 'Phiên đăng nhập đã hết hạn, đăng nhập lại nhé.',
  NETWORK: 'Mất kết nối. Kiểm tra mạng rồi thử lại.',
};

/** @param {string} code @returns {string} */
export function errorMessage(code) {
  return ERRORS[code] ?? 'Có lỗi xảy ra, bạn thử lại sau ít phút nhé.';
}

/** Chặn chèn công thức khi mở CSV bằng Excel (=, +, -, @). */
function csvCell(value) {
  const text = String(value ?? '');
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

const STATUS_LABEL = { registered: 'Đã có chỗ', waitlist: 'Danh sách chờ' };

/** @param {Array<{ full_name: string, phone: string, course_id: number | null, status: string, created_at: string }>} rows */
export function toCsv(rows) {
  const header = 'STT,Họ tên,SĐT,Khóa,Trạng thái,Thời gian';
  const body = rows.map((r, i) => [
    i + 1,
    r.full_name,
    formatPhone(r.phone),
    r.course_id ? `Khóa ${r.course_id}` : '',
    STATUS_LABEL[r.status] ?? r.status,
    new Date(r.created_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
  ].map(csvCell).join(','));
  return '﻿' + [header, ...body].join('\r\n');
}
