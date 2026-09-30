import { createApi } from './api.js';
import { errorMessage, formatPhone, loginEmail, toCsv, validatePassword } from './logic.js';

const api = createApi();
const $ = (id) => document.getElementById(id);
const ICONS = 'assets/icons.svg';

let rows = [];
let status = null;

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `${ICONS}#${name}`);
  svg.append(use);
  return svg;
}

const formatTime = (iso) => new Date(iso).toLocaleString('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});

function showError(message) {
  $('dash-error').textContent = message ?? '';
  $('dash-error').hidden = !message;
}

async function guarded(action) {
  showError(null);
  try {
    await action();
  } catch (err) {
    if (err.code === 'SESSION_EXPIRED' || err.code === 'FORBIDDEN') {
      await api.signOut();
      showLogin(errorMessage(err.code));
      return;
    }
    showError(errorMessage(err.code));
  }
  await load();
}

// ─── Bảng ────────────────────────────────────────────────────────────────

function moveSelect(row) {
  const select = h('select', { 'aria-label': `Chuyển ${row.full_name}` },
    ...status.courses.map((c) => h('option', { value: c.id, selected: row.course_id === c.id }, c.name)),
    h('option', { value: '', selected: row.course_id == null }, 'Danh sách chờ'),
  );
  select.addEventListener('change', () => {
    const target = select.value === '' ? null : Number(select.value);
    guarded(() => api.adminMove(row.id, target));
  });
  return select;
}

function deleteButton(row) {
  const button = h('button', { type: 'button', class: 'icon-button', 'aria-label': `Xóa ${row.full_name}` }, icon('trash'));
  let timer = null;
  button.addEventListener('click', () => {
    if (!button.classList.contains('is-armed')) {
      button.classList.add('is-armed');
      button.replaceChildren('Xóa?');
      timer = setTimeout(() => {
        button.classList.remove('is-armed');
        button.replaceChildren(icon('trash'));
      }, 4000);
      return;
    }
    clearTimeout(timer);
    guarded(() => api.adminDelete(row.id));
  });
  return button;
}

function table(list) {
  return h('table', { class: 'table' },
    h('thead', {}, h('tr', {},
      h('th', {}, '#'), h('th', {}, 'Họ tên'), h('th', {}, 'SĐT'),
      h('th', {}, 'Đăng ký lúc'), h('th', {}, h('span', { class: 'visually-hidden' }, 'Thao tác')),
    )),
    h('tbody', {}, ...list.map((row, i) => h('tr', {},
      h('td', {}, String(i + 1)),
      h('td', { class: 'name' }, row.full_name),
      h('td', { class: 'num' }, h('a', { href: `tel:${row.phone}` }, formatPhone(row.phone))),
      h('td', { class: 'num' }, formatTime(row.created_at)),
      h('td', {}, h('div', { class: 'row-actions' }, moveSelect(row), deleteButton(row))),
    ))),
  );
}

function group(title, meta, list, emptyText) {
  return h('section', { class: 'group' },
    h('div', { class: 'group-head' }, h('h2', {}, title), h('span', {}, meta)),
    list.length ? table(list) : h('p', { class: 'group-empty' }, emptyText),
  );
}

function render() {
  const waiting = rows.filter((r) => r.status === 'waitlist');
  $('summary').replaceChildren(
    ...status.courses.map((c) => h('span', { class: c.taken >= c.capacity ? 'is-full' : null },
      `${c.name}: `, h('b', {}, `${c.taken}/${c.capacity}`))),
    h('span', {}, 'Chờ: ', h('b', {}, String(waiting.length))),
  );
  $('is-open').checked = status.is_open;
  $('fill-in-order').checked = status.fill_in_order;

  $('groups').replaceChildren(
    ...status.courses.map((c) => group(
      c.name, `${c.taken}/${c.capacity} chỗ`,
      rows.filter((r) => r.course_id === c.id), 'Chưa có ai đăng ký.',
    )),
    group('Danh sách chờ', `${waiting.length} người`, waiting, 'Không có ai đang chờ.'),
  );
}

async function load() {
  try {
    [status, rows] = await Promise.all([api.getStatus(), api.adminList()]);
    render();
  } catch (err) {
    if (err.code === 'SESSION_EXPIRED' || err.code === 'FORBIDDEN') {
      await api.signOut();
      return showLogin(errorMessage(err.code));
    }
    showError(errorMessage(err.code));
  }
}

// ─── Đăng nhập ───────────────────────────────────────────────────────────

function showLogin(message) {
  $('login').hidden = false;
  $('dash').hidden = true;
  $('bar-user').hidden = true;
  $('login-error').textContent = message ?? '';
  $('login-error').hidden = !message;
}

async function showDash() {
  $('login').hidden = true;
  $('dash').hidden = false;
  $('bar-user').hidden = false;
  $('admin-email').textContent = (api.currentAdmin()?.email ?? '').split('@')[0];
  await load();
}

$('login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = loginEmail($('username').value);
  if (!email || !$('password').value) return showLogin('Nhập tên đăng nhập và mật khẩu.');

  const submit = $('login-submit');
  submit.disabled = true;
  submit.classList.add('is-busy');
  try {
    await api.signIn(email, $('password').value);
    $('password').value = '';
    await showDash();
  } catch (err) {
    showLogin(errorMessage(err.code));
  } finally {
    submit.disabled = false;
    submit.classList.remove('is-busy');
  }
});

$('password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const next = $('new-password').value;
  const error = validatePassword(next, $('confirm-password').value);
  $('password-ok').hidden = true;
  $('password-error').hidden = !error;
  $('password-error').textContent = error ?? '';
  if (error) return;

  $('password-submit').disabled = true;
  try {
    await api.changePassword(next);
    $('new-password').value = '';
    $('confirm-password').value = '';
    $('password-ok').hidden = false;
  } catch (err) {
    if (err.code === 'SESSION_EXPIRED') return showLogin(errorMessage(err.code));
    $('password-error').textContent = errorMessage(err.code);
    $('password-error').hidden = false;
  } finally {
    $('password-submit').disabled = false;
  }
});

$('sign-out').addEventListener('click', async () => {
  await api.signOut();
  showLogin();
});

$('is-open').addEventListener('change', (e) => guarded(() => api.adminSettings(e.target.checked, null)));
$('fill-in-order').addEventListener('change', (e) => guarded(() => api.adminSettings(null, e.target.checked)));

$('export').addEventListener('click', () => {
  const ordered = [...rows].sort((a, b) => (a.course_id ?? 99) - (b.course_id ?? 99) || a.created_at.localeCompare(b.created_at));
  const blob = new Blob([toCsv(ordered)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: `pickleball-dang-ky-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
});

if (api.isDemo) $('demo-strip').hidden = false;
if (api.currentAdmin()) showDash();
else showLogin();
