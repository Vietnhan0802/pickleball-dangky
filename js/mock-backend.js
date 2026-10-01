// Backend giả lập chạy trong trình duyệt khi chưa cấu hình Supabase (chế độ demo).
// Mô phỏng đúng các luật trong supabase/schema.sql để xem thử giao diện.
import { normalizePhone, cleanName, NICKNAME_MAX } from './logic.js';

const DEMO_ADMIN = { email: 'admin@pickleball.local', password: 'demo' };

export class BackendError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const SAMPLE_NAMES = [
  'Nguyễn Minh Anh', 'Trần Quốc Bảo', 'Lê Thu Hà', 'Phạm Đức Huy', 'Võ Ngọc Lan', 'Đặng Hoàng Nam',
  'Bùi Thanh Tâm', 'Hồ Gia Khang', 'Đỗ Mỹ Linh', 'Ngô Tuấn Kiệt', 'Dương Khánh Vy',
  'Lý Quang Vinh', 'Mai Phương Thảo', 'Phan Nhật Minh', 'Trương Bảo Ngọc',
];

/** Dữ liệu mẫu: khóa 4 còn 1 chỗ, khóa 5 có 4 người. */
export function sampleState() {
  const start = Date.UTC(2026, 8, 29, 1, 0, 0);
  const rows = SAMPLE_NAMES.map((full_name, i) => ({
    id: i + 1,
    full_name,
    nickname: '',
    phone: `09${String(10000000 + i * 7919).slice(0, 8)}`,
    course_id: i < 11 ? 4 : 5,
    status: 'registered',
    created_at: new Date(start + i * 600000).toISOString(),
  }));
  return {
    nextId: rows.length + 1,
    settings: { is_open: true, fill_in_order: false },
    courses: [
      { id: 4, name: 'Khóa 4', capacity: 12, schedule: '' },
      { id: 5, name: 'Khóa 5', capacity: 12, schedule: '' },
    ],
    rows,
  };
}

/**
 * @param {{ load?: () => any, save?: (state: any) => void, random?: () => number, now?: () => Date }} [io]
 */
export function createMockBackend(io = {}) {
  const now = io.now ?? (() => new Date());
  let state = io.load?.() ?? sampleState();
  let session = null;
  let adminPassword = DEMO_ADMIN.password;

  const commit = (next) => {
    state = next;
    io.save?.(state);
  };
  const registered = (courseId, rows = state.rows) =>
    rows.filter((r) => r.status === 'registered' && r.course_id === courseId);
  const isFull = (course, rows = state.rows) => registered(course.id, rows).length >= course.capacity;
  const byTime = (a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id;
  const waitlist = (rows = state.rows) => rows.filter((r) => r.status === 'waitlist').sort(byTime);
  const courseOf = (id) => state.courses.find((c) => c.id === id);
  const requireAdmin = () => {
    if (!session) throw new BackendError('FORBIDDEN');
  };

  /** Trả về danh sách mới sau khi đưa người chờ vào chỗ trống. */
  const promote = (rows, courseId, excludeId = null) => {
    const course = courseOf(courseId);
    let next = rows;
    for (const w of waitlist(rows).filter((r) => r.id !== excludeId)) {
      if (isFull(course, next)) break;
      next = next.map((r) => (r.id === w.id ? { ...r, status: 'registered', course_id: courseId } : r));
    }
    return next;
  };

  const position = (row) => {
    const peers = row.status === 'waitlist' ? waitlist() : registered(row.course_id).sort(byTime);
    return peers.findIndex((r) => r.id === row.id) + 1;
  };

  return {
    isDemo: true,
    demoAdmin: DEMO_ADMIN,

    async getStatus() {
      return {
        ...state.settings,
        waitlist: waitlist().length,
        courses: state.courses.map((c) => ({
          ...c,
          taken: registered(c.id).length,
          members: registered(c.id).sort(byTime).map((r) => ({ name: r.full_name, nickname: r.nickname ?? '' })),
        })),
      };
    },

    async register(name, phone, courseId, nickname = '') {
      const full_name = cleanName(name);
      const nick = cleanName(nickname);
      const p = normalizePhone(phone);
      if (!state.settings.is_open) throw new BackendError('CLOSED');
      if (full_name.length < 2 || full_name.length > 80) throw new BackendError('INVALID_NAME');
      if (nick.length > NICKNAME_MAX) throw new BackendError('INVALID_NICKNAME');
      if (!/^0\d{9}$/.test(p)) throw new BackendError('INVALID_PHONE');
      if (state.rows.some((r) => r.phone === p)) throw new BackendError('ALREADY_REGISTERED');

      let status = 'registered';
      if (courseId == null) {
        if (state.courses.some((c) => !isFull(c))) throw new BackendError('SEATS_AVAILABLE');
        status = 'waitlist';
      } else {
        const course = courseOf(courseId);
        if (!course) throw new BackendError('INVALID_COURSE');
        if (isFull(course)) throw new BackendError('COURSE_FULL');
        const earlierOpen = state.courses.some((c) => c.id < courseId && !isFull(c));
        if (state.settings.fill_in_order && earlierOpen) throw new BackendError('COURSE_NOT_OPEN');
      }

      const row = {
        id: state.nextId,
        full_name,
        nickname: nick,
        phone: p,
        course_id: status === 'registered' ? courseId : null,
        status,
        created_at: now().toISOString(),
      };
      commit({ ...state, nextId: state.nextId + 1, rows: [...state.rows, row] });
      return {
        status,
        course_id: row.course_id,
        seat: status === 'registered' ? position(row) : null,
        waitlist_position: status === 'waitlist' ? position(row) : null,
      };
    },

    async lookup(phone) {
      const row = state.rows.find((r) => r.phone === normalizePhone(phone));
      if (!row) return null;
      return {
        full_name: row.full_name,
        nickname: row.nickname ?? '',
        status: row.status,
        course_id: row.course_id,
        seat: row.status === 'registered' ? position(row) : null,
        waitlist_position: row.status === 'waitlist' ? position(row) : null,
      };
    },

    async signIn(email, password) {
      if (email !== DEMO_ADMIN.email || password !== adminPassword) throw new BackendError('BAD_LOGIN');
      session = { email };
      return session;
    },

    async changePassword(password) {
      requireAdmin();
      if (String(password ?? '').length < 8) throw new BackendError('WEAK_PASSWORD');
      adminPassword = password;
      return { ok: true };
    },

    async signOut() {
      session = null;
    },

    currentAdmin() {
      return session;
    },

    async adminList() {
      requireAdmin();
      return [...state.rows].sort(byTime);
    },

    async adminMove(id, courseId) {
      requireAdmin();
      const row = state.rows.find((r) => r.id === id);
      if (!row) throw new BackendError('NOT_FOUND');
      if (row.course_id === courseId) return { ok: true };
      if (courseId != null && isFull(courseOf(courseId))) throw new BackendError('COURSE_FULL');

      const moved = state.rows.map((r) => (r.id !== id ? r : courseId == null
        ? { ...r, status: 'waitlist', course_id: null, created_at: now().toISOString() }
        : { ...r, status: 'registered', course_id: courseId }));
      commit({ ...state, rows: row.course_id ? promote(moved, row.course_id, id) : moved });
      return { ok: true };
    },

    /** nickname null/undefined = giữ nguyên nickname cũ (giống admin_update trong schema.sql). */
    async adminUpdate(id, name, phone, nickname = null) {
      requireAdmin();
      const full_name = cleanName(name);
      const nick = nickname == null ? null : cleanName(nickname);
      const p = normalizePhone(phone);
      if (!state.rows.some((r) => r.id === id)) throw new BackendError('NOT_FOUND');
      if (full_name.length < 2 || full_name.length > 80) throw new BackendError('INVALID_NAME');
      if (!/^0\d{9}$/.test(p)) throw new BackendError('INVALID_PHONE');
      if (nick != null && nick.length > NICKNAME_MAX) throw new BackendError('INVALID_NICKNAME');
      if (state.rows.some((r) => r.phone === p && r.id !== id)) throw new BackendError('ALREADY_REGISTERED');
      commit({
        ...state,
        rows: state.rows.map((r) => (r.id === id ? { ...r, full_name, phone: p, nickname: nick ?? r.nickname ?? '' } : r)),
      });
      return { ok: true };
    },

    async adminSwap(idA, idB) {
      requireAdmin();
      const a = state.rows.find((r) => r.id === idA);
      const b = state.rows.find((r) => r.id === idB);
      if (!a || !b) throw new BackendError('NOT_FOUND');
      const slot = ({ course_id, status, created_at }) => ({ course_id, status, created_at });
      commit({
        ...state,
        rows: state.rows.map((r) => (r.id === idA ? { ...r, ...slot(b) } : r.id === idB ? { ...r, ...slot(a) } : r)),
      });
      return { ok: true };
    },

    async adminDelete(id) {
      requireAdmin();
      const row = state.rows.find((r) => r.id === id);
      if (!row) throw new BackendError('NOT_FOUND');
      const rest = state.rows.filter((r) => r.id !== id);
      commit({ ...state, rows: row.course_id ? promote(rest, row.course_id) : rest });
      return { ok: true };
    },

    async adminUpdateCourse(id, name, capacity, schedule) {
      requireAdmin();
      const course = courseOf(id);
      const cleanTitle = cleanName(name);
      const cleanSchedule = String(schedule ?? '').trim();
      if (!course) throw new BackendError('INVALID_COURSE');
      if (cleanTitle.length < 1 || cleanTitle.length > 40) throw new BackendError('INVALID_COURSE_NAME');
      if (cleanSchedule.length > 120) throw new BackendError('INVALID_SCHEDULE');
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 50) throw new BackendError('INVALID_CAPACITY');
      if (capacity < registered(id).length) throw new BackendError('CAPACITY_TOO_SMALL');
      state = {
        ...state,
        courses: state.courses.map((c) => (c.id === id ? { ...c, name: cleanTitle, capacity, schedule: cleanSchedule } : c)),
      };
      commit({ ...state, rows: promote(state.rows, id) });
      return { ok: true };
    },

    async adminSettings(isOpen, fillInOrder) {
      requireAdmin();
      commit({
        ...state,
        settings: {
          is_open: isOpen ?? state.settings.is_open,
          fill_in_order: fillInOrder ?? state.settings.fill_in_order,
        },
      });
      return { ok: true };
    },

    /** Tab khác đã đổi dữ liệu demo: đọc lại. */
    reload() {
      state = io.load?.() ?? state;
    },

    async reset() {
      commit(sampleState());
    },
  };
}
