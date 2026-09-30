// Chọn backend: Supabase thật nếu đã cấu hình, ngược lại dùng bản demo.
import { CONFIG } from './config.js';
import { BackendError, createMockBackend } from './mock-backend.js';

export { BackendError };

const REALTIME_JS = 'https://cdn.jsdelivr.net/npm/@supabase/realtime-js@2.117.2/+esm';
const DEMO_KEY = 'pickleball-demo-v1';
const SESSION_KEY = 'pickleball-admin-session';

const storage = {
  get(store, key) {
    try {
      return JSON.parse(store.getItem(key));
    } catch {
      return null;
    }
  },
  set(store, key, value) {
    try {
      if (value == null) store.removeItem(key);
      else store.setItem(key, JSON.stringify(value));
    } catch {
      // Chế độ ẩn danh / bị chặn lưu trữ: vẫn chạy, chỉ không nhớ được.
    }
  },
};

function createSupabaseBackend({ supabaseUrl, supabaseAnonKey }) {
  const base = supabaseUrl.replace(/\/$/, '');
  let session = storage.get(sessionStorage, SESSION_KEY);

  const request = async (path, body, { auth = false, method = 'POST' } = {}) => {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        // Key kiểu mới (sb_publishable_...) chỉ được gửi qua header apikey;
        // Authorization chỉ mang JWT: phiên admin, hoặc anon key kiểu cũ (eyJ...).
        headers: {
          apikey: supabaseAnonKey,
          ...(auth && session
            ? { Authorization: `Bearer ${session.access_token}` }
            : supabaseAnonKey.startsWith('eyJ') ? { Authorization: `Bearer ${supabaseAnonKey}` } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body ?? {}),
      });
    } catch {
      throw new BackendError('NETWORK');
    }
    const data = await res.json().catch(() => null);
    if (res.ok) return data;
    if (res.status === 401 && auth) {
      session = null;
      storage.set(sessionStorage, SESSION_KEY, null);
      throw new BackendError('SESSION_EXPIRED');
    }
    // Lỗi nghiệp vụ từ Postgres (raise exception 'CODE') nằm trong message.
    const code = data?.message ?? data?.error_description ?? data?.msg ?? 'UNKNOWN';
    const error = new BackendError(/^[A-Z_]+$/.test(code) ? code : 'UNKNOWN');
    error.authCode = data?.error_code ?? null;
    throw error;
  };

  const rpc = (fn, args, opts) => request(`/rest/v1/rpc/${fn}`, args, opts);
  const admin = (fn, args) => rpc(fn, args, { auth: true });

  return {
    isDemo: false,
    getStatus: () => rpc('get_status'),
    register: (name, phone, courseId) =>
      rpc('register', { p_name: name, p_phone: phone, p_course: courseId }),
    lookup: (phone) => rpc('lookup', { p_phone: phone }),

    async signIn(email, password) {
      try {
        session = await request('/auth/v1/token?grant_type=password', { email, password });
      } catch (err) {
        throw new BackendError(err.code === 'NETWORK' ? 'NETWORK' : 'BAD_LOGIN');
      }
      storage.set(sessionStorage, SESSION_KEY, session);
      return { email: session.user?.email ?? email };
    },
    async changePassword(password) {
      try {
        await request('/auth/v1/user', { password }, { auth: true, method: 'PUT' });
      } catch (err) {
        if (err.code === 'NETWORK' || err.code === 'SESSION_EXPIRED') throw err;
        throw new BackendError(err.authCode === 'weak_password' ? 'WEAK_PASSWORD' : 'UNKNOWN');
      }
      return { ok: true };
    },
    async signOut() {
      session = null;
      storage.set(sessionStorage, SESSION_KEY, null);
    },
    currentAdmin: () => (session ? { email: session.user?.email ?? '' } : null),
    adminList: () => admin('admin_list'),
    adminMove: (id, courseId) => admin('admin_move', { p_id: id, p_course: courseId }),
    adminDelete: (id) => admin('admin_delete', { p_id: id }),
    adminUpdate: (id, name, phone) => admin('admin_update', { p_id: id, p_name: name, p_phone: phone }),
    adminSwap: (idA, idB) => admin('admin_swap', { p_a: idA, p_b: idB }),
    adminSettings: (isOpen, fillInOrder) =>
      admin('admin_settings', { p_is_open: isOpen, p_fill_in_order: fillInOrder }),
    adminUpdateCourse: (id, name, capacity, schedule) =>
      admin('admin_update_course', { p_id: id, p_name: name, p_capacity: capacity, p_schedule: schedule }),

    /** Gọi onChange mỗi khi database báo có thay đổi (xem _notify_change trong schema.sql). */
    async subscribe(onChange) {
      const { RealtimeClient } = await import(REALTIME_JS);
      const client = new RealtimeClient(`${base.replace(/^http/, 'ws')}/realtime/v1`, {
        params: { apikey: supabaseAnonKey },
      });
      client.channel('pickleball', { config: { private: false } })
        .on('broadcast', { event: 'changed' }, onChange)
        .subscribe();
    },
  };
}

export function createApi(config = CONFIG) {
  if (config.supabaseUrl && config.supabaseAnonKey) return createSupabaseBackend(config);
  const backend = createMockBackend({
    load: () => storage.get(localStorage, DEMO_KEY),
    save: (state) => storage.set(localStorage, DEMO_KEY, state),
  });
  // Demo: tab khác ghi localStorage thì tab này nhận sự kiện "storage".
  backend.subscribe = async (onChange) => {
    addEventListener('storage', (event) => {
      if (event.key !== DEMO_KEY) return;
      backend.reload();
      onChange();
    });
  };
  return backend;
}
