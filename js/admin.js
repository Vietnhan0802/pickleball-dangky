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

let swapFrom = null;   // id người đang chờ chọn người để đổi chỗ
let editingId = null;  // id người đang sửa thông tin

const personOf = (id) => rows.find((r) => r.id === id);

function iconButton(name, label, onClick, { disabled = false, pressed = null } = {}) {
  const button = h('button', {
    type: 'button', class: 'icon-button', 'aria-label': label, title: label, disabled,
    'aria-pressed': pressed == null ? null : String(pressed),
  }, icon(name));
  button.addEventListener('click', onClick);
  return button;
}

function moveSelect(row) {
  const select = h('select', { 'aria-label': `Chuyển ${row.full_name}` },
    ...status.courses.map((c) => h('option', { value: c.id, selected: row.course_id === c.id }, c.name)),
    h('option', { value: '', selected: row.course_id == null }, 'Danh sách chờ'),
  );
  select.addEventListener('change', () => {
    const target = select.value === '' ? null : Number(select.value);
    guarded(() => api.adminMove(row.id, target).catch((err) => {
      // Khóa đích đầy: gợi ý dùng đổi chỗ thay vì chuyển.
      if (err.code === 'COURSE_FULL') err.code = 'ADMIN_COURSE_FULL';
      throw err;
    }));
  });
  return select;
}

function deleteButton(row) {
  const button = h('button', { type: 'button', class: 'icon-button is-delete', 'aria-label': `Xóa ${row.full_name}`, title: 'Xóa' }, icon('trash'));
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

function startSwap(row) {
  if (swapFrom === row.id) {
    swapFrom = null;
  } else if (swapFrom == null) {
    swapFrom = row.id;
  } else {
    const from = swapFrom;
    swapFrom = null;
    guarded(() => api.adminSwap(from, row.id));
    return;
  }
  render();
}

function swapButton(row) {
  const isSource = swapFrom === row.id;
  if (swapFrom != null && !isSource) {
    const button = h('button', { type: 'button', class: 'button button-ball button-sm swap-target' }, icon('swap'), 'Đổi với người này');
    button.addEventListener('click', () => startSwap(row));
    return button;
  }
  const label = isSource ? 'Bỏ chọn đổi chỗ' : `Đổi chỗ ${row.full_name} với người khác`;
  return iconButton('swap', label, () => startSwap(row), { pressed: isSource });
}

function orderButtons(list, i) {
  const swapWith = (j) => () => guarded(() => api.adminSwap(list[i].id, list[j].id));
  return [
    iconButton('up', 'Lên 1 chỗ', swapWith(i - 1), { disabled: i === 0 }),
    iconButton('down', 'Xuống 1 chỗ', swapWith(i + 1), { disabled: i === list.length - 1 }),
  ];
}

function editRow(row, i) {
  const name = h('input', { value: row.full_name, 'aria-label': 'Họ tên', maxlength: '80', autocomplete: 'off' });
  const phone = h('input', { value: formatPhone(row.phone), 'aria-label': 'Số điện thoại', type: 'tel', maxlength: '16', autocomplete: 'off' });
  const save = () => guarded(async () => {
    await api.adminUpdate(row.id, name.value, phone.value);
    editingId = null;
  });
  const cancel = () => {
    editingId = null;
    showError(null);
    render();
  };
  for (const input of [name, phone]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        cancel();
      }
    });
  }
  const saveButton = h('button', { type: 'button', class: 'button button-ball button-sm' }, 'Lưu');
  const cancelButton = h('button', { type: 'button', class: 'button button-quiet button-sm' }, 'Hủy');
  saveButton.addEventListener('click', save);
  cancelButton.addEventListener('click', cancel);
  queueMicrotask(() => name.focus());
  return h('tr', { class: 'is-editing' },
    h('td', {}, String(i + 1)),
    h('td', {}, name),
    h('td', {}, phone),
    h('td', { class: 'num' }, formatTime(row.created_at)),
    h('td', {}, h('div', { class: 'row-actions' }, saveButton, cancelButton)),
  );
}

function viewRow(row, i, list) {
  const choosing = swapFrom != null;
  const cls = swapFrom === row.id ? 'is-swap-source' : choosing ? 'is-swap-candidate' : null;
  const actions = choosing
    ? [swapButton(row)]
    : [
        ...orderButtons(list, i),
        swapButton(row),
        iconButton('edit', `Sửa ${row.full_name}`, () => {
          editingId = row.id;
          render();
        }),
        moveSelect(row),
        deleteButton(row),
      ];
  return h('tr', { class: cls },
    h('td', {}, String(i + 1)),
    h('td', { class: 'name' }, row.full_name),
    h('td', { class: 'num' }, h('a', { href: `tel:${row.phone}` }, formatPhone(row.phone))),
    h('td', { class: 'num' }, formatTime(row.created_at)),
    h('td', {}, h('div', { class: 'row-actions' }, ...actions)),
  );
}

function table(list) {
  return h('table', { class: 'table' },
    h('thead', {}, h('tr', {},
      h('th', {}, '#'), h('th', {}, 'Họ tên'), h('th', {}, 'SĐT'),
      h('th', {}, 'Đăng ký lúc'), h('th', {}, h('span', { class: 'visually-hidden' }, 'Thao tác')),
    )),
    h('tbody', {}, ...list.map((row, i) => (row.id === editingId ? editRow(row, i) : viewRow(row, i, list)))),
  );
}

function group(title, meta, list, emptyText) {
  return h('section', { class: 'group' },
    h('div', { class: 'group-head' }, h('h2', {}, title), h('span', {}, meta)),
    list.length ? table(list) : h('p', { class: 'group-empty' }, emptyText),
  );
}

function swapBanner() {
  const source = personOf(swapFrom);
  if (!source) return null;
  const cancel = h('button', { type: 'button', class: 'button button-quiet button-sm' }, 'Hủy');
  cancel.addEventListener('click', () => {
    swapFrom = null;
    render();
  });
  return h('div', { class: 'swap-banner', role: 'status' },
    icon('swap'),
    h('span', {}, 'Chọn người để đổi chỗ với ', h('b', {}, source.full_name), '. Hai người sẽ hoán đổi khóa và thứ tự cho nhau.'),
    cancel,
  );
}

function render() {
  if (swapFrom != null && !personOf(swapFrom)) swapFrom = null;
  if (editingId != null && !personOf(editingId)) editingId = null;
  const waiting = rows.filter((r) => r.status === 'waitlist');
  $('summary').replaceChildren(
    ...status.courses.map((c) => h('span', { class: c.taken >= c.capacity ? 'is-full' : null },
      `${c.name}: `, h('b', {}, `${c.taken}/${c.capacity}`))),
    h('span', {}, 'Chờ: ', h('b', {}, String(waiting.length))),
  );
  $('is-open').checked = status.is_open;
  $('fill-in-order').checked = status.fill_in_order;

  $('groups').replaceChildren(
    ...[swapBanner()].filter(Boolean),
    ...status.courses.map((c) => group(
      c.name, `${c.taken}/${c.capacity} chỗ`,
      rows.filter((r) => r.course_id === c.id), 'Chưa có ai đăng ký.',
    )),
    group('Danh sách chờ', `${waiting.length} người`, waiting, 'Không có ai đang chờ.'),
  );
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && swapFrom != null) {
    swapFrom = null;
    render();
  }
});

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
