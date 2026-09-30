// Backend giả lập chạy trong trình duyệt khi chưa cấu hình Supabase (chế độ demo).
// Mô phỏng đúng các luật trong supabase/schema.sql để xem thử giao diện.
import { normalizePhone, cleanName } from './logic.js';

const DEMO_ADMIN = { email: 'admin@demo.vn', password: 'demo' };

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
    admins: [DEMO_ADMIN.email],
  };
}

/**
 * @param {{ load?: () => any, save?: (state: any) => void, random?: () => number, now?: () => Date }} [io]
 */
export function createMockBackend(io = {}) {
  const now = io.now ?? (() => new Date());
  let state = io.load?.() ?? sampleState();
  let session = null;

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
          members: registered(c.id).sort(byTime).map((r) => r.full_name),
        })),
      };
    },

    async register(name, phone, courseId) {
      const full_name = cleanName(name);
      const p = normalizePhone(phone);
      if (!state.settings.is_open) throw new BackendError('CLOSED');
      if (full_name.length < 2 || full_name.length > 80) throw new BackendError('INVALID_NAME');
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
        status: row.status,
        course_id: row.course_id,
        seat: row.status === 'registered' ? position(row) : null,
        waitlist_position: row.status === 'waitlist' ? position(row) : null,
      };
    },

    async signIn(email, password) {
      if (email !== DEMO_ADMIN.email || password !== DEMO_ADMIN.password) throw new BackendError('BAD_LOGIN');
      session = { email };
      return session;
    },

    async signUp(email, password) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email ?? '').trim())) throw new BackendError('INVALID_EMAIL');
      if (String(password ?? '').length < 8) throw new BackendError('WEAK_PASSWORD');
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

    async adminDelete(id) {
      requireAdmin();
      const row = state.rows.find((r) => r.id === id);
      if (!row) throw new BackendError('NOT_FOUND');
      const rest = state.rows.filter((r) => r.id !== id);
      commit({ ...state, rows: row.course_id ? promote(rest, row.course_id) : rest });
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

    async adminAdmins() {
      requireAdmin();
      return [...(state.admins ?? [])].sort();
    },

    async adminAddAdmin(email) {
      requireAdmin();
      const value = String(email ?? '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw new BackendError('INVALID_EMAIL');
      const admins = state.admins ?? [];
      if (!admins.includes(value)) commit({ ...state, admins: [...admins, value] });
      return { ok: true };
    },

    async adminRemoveAdmin(email) {
      requireAdmin();
      const value = String(email ?? '').trim().toLowerCase();
      if (value === session.email) throw new BackendError('CANNOT_REMOVE_SELF');
      const admins = state.admins ?? [];
      if (!admins.includes(value)) throw new BackendError('NOT_FOUND');
      commit({ ...state, admins: admins.filter((a) => a !== value) });
      return { ok: true };
    },

    async reset() {
      commit(sampleState());
    },
  };
}
