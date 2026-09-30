// Chọn backend: Supabase thật nếu đã cấu hình, ngược lại dùng bản demo.
import { CONFIG } from './config.js';
import { BackendError, createMockBackend } from './mock-backend.js';

export { BackendError };

const DEMO_KEY = 'pickleball-demo-v1';
const SESSION_KEY = 'pickleball-admin-session';

// Mã lỗi của Supabase Auth → mã lỗi của ứng dụng.
const AUTH_ERRORS = {
  weak_password: 'WEAK_PASSWORD',
  email_address_invalid: 'INVALID_EMAIL',
  validation_failed: 'INVALID_EMAIL',
  signup_disabled: 'SIGNUP_DISABLED',
  email_provider_disabled: 'SIGNUP_DISABLED',
  over_email_send_rate_limit: 'RATE_LIMITED',
  over_request_rate_limit: 'RATE_LIMITED',
};

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

/** Link xác nhận email của Supabase quay về dạng admin.html#access_token=...&type=signup */
function sessionFromConfirmLink() {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('access_token');
  if (!token) return null;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const session = { access_token: token, user: { email: payload.email } };
    storage.set(sessionStorage, SESSION_KEY, session);
    return session;
  } catch {
    return null;
  }
}

function createSupabaseBackend({ supabaseUrl, supabaseAnonKey }) {
  const base = supabaseUrl.replace(/\/$/, '');
  let session = sessionFromConfirmLink() ?? storage.get(sessionStorage, SESSION_KEY);

  const request = async (path, body, { auth = false } = {}) => {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method: 'POST',
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
    error.authCode = data?.error_code ?? (res.status === 429 ? 'over_email_send_rate_limit' : null);
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
    async signUp(email, password) {
      const redirect = encodeURIComponent(new URL('admin.html', location.href).href);
      try {
        await request(`/auth/v1/signup?redirect_to=${redirect}`, { email, password });
      } catch (err) {
        throw new BackendError(err.code === 'NETWORK' ? 'NETWORK' : AUTH_ERRORS[err.authCode] ?? 'UNKNOWN');
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
    adminSettings: (isOpen, fillInOrder) =>
      admin('admin_settings', { p_is_open: isOpen, p_fill_in_order: fillInOrder }),
    adminAdmins: () => admin('admin_admins'),
    adminAddAdmin: (email) => admin('admin_add_admin', { p_email: email }),
    adminRemoveAdmin: (email) => admin('admin_remove_admin', { p_email: email }),
  };
}

export function createApi(config = CONFIG) {
  if (config.supabaseUrl && config.supabaseAnonKey) return createSupabaseBackend(config);
  return createMockBackend({
    load: () => storage.get(localStorage, DEMO_KEY),
    save: (state) => storage.set(localStorage, DEMO_KEY, state),
  });
}
