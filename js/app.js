import { createApi } from './api.js';
import {
  cleanName, courseAvailability, defaultCourse, errorMessage, initials, isAllFull,
  normalizePhone, validateName, validatePhone,
} from './logic.js';

const REFRESH_MS = 15000;
const MINE_KEY = 'pickleball-mine';
const ICONS = 'assets/icons.svg';

const api = createApi();
const $ = (id) => document.getElementById(id);

const el = {
  court: $('court'), signup: $('signup'), name: $('name'), phone: $('phone'),
  nameError: $('name-error'), phoneError: $('phone-error'), formError: $('form-error'),
  formTitle: $('form-title'), formSub: $('form-sub'), submit: $('submit'), submitLabel: $('submit-label'),
  notice: $('notice'), ticket: $('ticket'), roster: $('roster'),
  lookupForm: $('lookup-form'), lookupPhone: $('lookup-phone'), lookupResult: $('lookup-result'),
  lookupError: $('lookup-error'), lookup: $('lookup'),
};

let status = null;
let selected = null;
let justLanded = null;
let mine = readMine();

function readMine() {
  try {
    return JSON.parse(localStorage.getItem(MINE_KEY));
  } catch {
    return null;
  }
}

function writeMine(value) {
  mine = value;
  try {
    if (value) localStorage.setItem(MINE_KEY, JSON.stringify(value));
    else localStorage.removeItem(MINE_KEY);
  } catch {
    // Không lưu được thì thôi, chỉ mất phần "nhớ" trên máy này.
  }
}

/** Tạo phần tử nhỏ gọn: h('p', { class: 'x' }, 'text', child) */
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

// ─── Sân ─────────────────────────────────────────────────────────────────

function renderSlot(course, index) {
  const name = course.members[index];
  if (name == null) return h('span', { class: 'slot is-empty', title: 'Còn trống' });
  const isMine = mine && mine.course_id === course.id && mine.name === name;
  const isNew = justLanded && justLanded.course_id === course.id && justLanded.seat === index + 1;
  const cls = ['slot', 'is-taken', isMine && 'is-mine', isNew && 'is-new'].filter(Boolean).join(' ');
  return h('span', { class: cls, title: name }, initials(name));
}

function kitchenState(course, availability) {
  if (availability.reason === 'full') return [icon('lock'), 'Đã khóa'];
  if (availability.reason === 'waiting') return [icon('clock'), `Mở khi ${status.courses[0].name} đủ`];
  if (availability.reason === 'closed') return [icon('lock'), 'Tạm đóng'];
  if (mine) return [];
  if (selected === course.id) return [icon('check'), 'Đang chọn'];
  return ['Chạm để chọn'];
}

function renderHalf(course) {
  const availability = courseAvailability(status, course.id);
  const slots = Array.from({ length: course.capacity }, (_, i) => renderSlot(course, i));
  const half = Math.ceil(slots.length / 2);
  const isChecked = selected === course.id;

  const node = h('div', {
    class: 'court-half',
    role: 'radio',
    'aria-checked': String(isChecked),
    'aria-disabled': String(!availability.open),
    'aria-label': `${course.name}, còn ${availability.left} trên ${course.capacity} chỗ`,
    tabindex: isChecked || (selected == null && availability.open) ? '0' : '-1',
    'data-course': course.id,
  },
    h('div', { class: 'boxes' },
      h('div', { class: 'box' }, ...slots.slice(0, half)),
      h('div', { class: 'box' }, ...slots.slice(half)),
    ),
    h('div', { class: 'kitchen' },
      h('div', {},
        h('div', { class: 'kitchen-name' }, course.name),
        h('div', { class: 'kitchen-state' }, ...kitchenState(course, availability)),
      ),
      h('div', { class: 'kitchen-count' },
        `${course.taken}/${course.capacity}`,
        h('small', {}, availability.left > 0 ? `còn ${availability.left} chỗ` : 'đủ người'),
      ),
    ),
    availability.reason === 'full'
      ? h('div', { class: 'tape', 'aria-hidden': 'true' }, icon('lock'), `Đã đủ ${course.capacity} người`)
      : null,
  );
  return node;
}

function renderCourt() {
  const [first, second] = status.courses;
  const net = h('div', { class: 'court-net', 'aria-hidden': 'true' });
  el.court.replaceChildren(renderHalf(first), net, renderHalf(second));
}

function choose(courseId) {
  if (!courseAvailability(status, courseId).open || mine) return;
  selected = courseId;
  render();
  el.court.querySelector(`[data-course="${courseId}"]`)?.focus();
}

el.court.addEventListener('click', (event) => {
  const half = event.target.closest('.court-half[data-course]');
  if (half) choose(Number(half.dataset.course));
});

el.court.addEventListener('keydown', (event) => {
  const half = event.target.closest('.court-half[data-course]');
  if (!half) return;
  const ids = status.courses.filter((c) => courseAvailability(status, c.id).open).map((c) => c.id);
  const current = Number(half.dataset.course);
  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault();
    choose(current);
  } else if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
    const next = ids[(ids.indexOf(current) + step + ids.length) % ids.length];
    if (next != null) choose(next);
  }
});

// ─── Form ────────────────────────────────────────────────────────────────

function courseName(id) {
  return status.courses.find((c) => c.id === id)?.name ?? `Khóa ${id}`;
}

function renderForm() {
  const allFull = isAllFull(status);
  const closed = !status.is_open;
  el.signup.hidden = Boolean(mine);

  if (closed) {
    el.formSub.textContent = 'Người tổ chức đang tạm đóng đăng ký.';
  } else if (allFull) {
    el.formSub.replaceChildren(
      'Cả hai khóa đã đủ người. Vào danh sách chờ, có người hủy là bạn được xếp vào ngay theo thứ tự.',
      status.waitlist ? h('strong', {}, ` Đang có ${status.waitlist} người chờ.`) : '',
    );
  } else if (selected != null) {
    const { left } = courseAvailability(status, selected);
    el.formSub.replaceChildren('Bạn đang chọn ', h('strong', {}, courseName(selected)), ` · còn ${left} chỗ.`);
  } else {
    el.formSub.textContent = 'Chọn một nửa sân bên cạnh để chọn khóa.';
  }

  const busy = el.submit.classList.contains('is-busy');
  el.submit.disabled = busy || closed || (!allFull && selected == null);
  if (!busy) {
    el.submitLabel.textContent = closed ? 'Đăng ký đang đóng'
      : allFull ? 'Vào danh sách chờ'
      : selected != null ? `Giữ chỗ ${courseName(selected)}`
      : 'Chọn khóa để giữ chỗ';
  }
  el.name.disabled = closed;
  el.phone.disabled = closed;
}

function renderNotice() {
  const courseFull = status.courses.find((c) => c.taken >= c.capacity);
  let text = null;
  if (!status.is_open) text = [icon('lock'), 'Đăng ký đang tạm đóng.'];
  else if (courseFull && !isAllFull(status)) {
    text = [icon('lock'), `${courseFull.name} đã đủ ${courseFull.capacity} người và đã khóa. Mời bạn đăng ký khóa còn lại.`];
  }
  el.notice.hidden = !text || Boolean(mine);
  if (text) el.notice.replaceChildren(...text);
}

function showFieldError(input, errorNode, message) {
  input.setAttribute('aria-invalid', String(Boolean(message)));
  errorNode.hidden = !message;
  errorNode.textContent = message ?? '';
  if (message) input.setAttribute('aria-describedby', errorNode.id);
  else input.removeAttribute('aria-describedby');
}

function setBusy(isBusy, label) {
  el.submit.classList.toggle('is-busy', isBusy);
  el.submit.disabled = isBusy;
  if (label) el.submitLabel.textContent = label;
}

el.name.addEventListener('blur', () => el.name.value && showFieldError(el.name, el.nameError, validateName(el.name.value)));
el.phone.addEventListener('blur', () => el.phone.value && showFieldError(el.phone, el.phoneError, validatePhone(el.phone.value)));
el.name.addEventListener('input', () => el.name.getAttribute('aria-invalid') === 'true' && showFieldError(el.name, el.nameError, validateName(el.name.value)));
el.phone.addEventListener('input', () => el.phone.getAttribute('aria-invalid') === 'true' && showFieldError(el.phone, el.phoneError, validatePhone(el.phone.value)));

el.signup.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.formError.hidden = true;
  const nameError = validateName(el.name.value);
  const phoneError = validatePhone(el.phone.value);
  showFieldError(el.name, el.nameError, nameError);
  showFieldError(el.phone, el.phoneError, phoneError);
  if (nameError) return el.name.focus();
  if (phoneError) return el.phone.focus();

  const waitlist = isAllFull(status);
  const courseId = waitlist ? null : selected;
  setBusy(true, waitlist ? 'Đang xếp hàng…' : 'Đang giữ chỗ…');
  try {
    const result = await api.register(cleanName(el.name.value), el.phone.value, courseId);
    const name = cleanName(el.name.value);
    writeMine({ name, phone: normalizePhone(el.phone.value), course_id: result.course_id });
    justLanded = result.course_id ? { course_id: result.course_id, seat: result.seat } : null;
    showTicket({ ...result, full_name: name });
    await refresh();
  } catch (err) {
    el.formError.textContent = errorMessage(err.code);
    el.formError.hidden = false;
    if (err.code === 'ALREADY_REGISTERED') {
      el.lookup.open = true;
      el.lookupPhone.value = el.phone.value;
    }
    await refresh();
  } finally {
    setBusy(false);
    renderForm();
  }
});

function showTicket(result) {
  const waiting = result.status === 'waitlist';
  $('ticket-title').textContent = waiting ? 'Đã vào danh sách chờ' : `Đã giữ chỗ ${courseName(result.course_id)}`;
  $('ticket-sub').textContent = waiting
    ? 'Khi có người hủy, bạn được xếp vào khóa có chỗ trống theo thứ tự chờ.'
    : 'Hẹn gặp bạn ở sân! Quả bóng có viền trắng trên sân là chỗ của bạn.';
  $('ticket-name').textContent = result.full_name;
  $('ticket-slot-label').textContent = waiting ? 'Thứ tự chờ' : 'Chỗ số';
  $('ticket-slot').textContent = waiting ? `#${result.waitlist_position}` : `${result.seat} / 12`;
  el.ticket.hidden = false;
  el.signup.hidden = true;
  el.ticket.focus({ preventScroll: true });
}

// ─── Tra cứu ───────────────────────────────────────────────────────

function showLookupError(message) {
  el.lookupError.textContent = message ?? '';
  el.lookupError.hidden = !message;
}

function describe(result) {
  if (result.status === 'waitlist') return `Đang ở danh sách chờ, thứ tự #${result.waitlist_position}.`;
  return `${courseName(result.course_id)} · chỗ số ${result.seat}.`;
}

el.lookupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showLookupError(null);
  el.lookupResult.hidden = true;
  const error = validatePhone(el.lookupPhone.value);
  if (error) return showLookupError(error);

  try {
    const result = await api.lookup(el.lookupPhone.value);
    if (!result) return showLookupError(errorMessage('NOT_FOUND'));
    el.lookupResult.className = 'lookup-result is-ok';
    el.lookupResult.replaceChildren(
      h('strong', {}, result.full_name),
      h('p', {}, describe(result)),
      h('p', {}, 'Muốn hủy hoặc đổi khóa, nhắn người quản trị nhé.'),
    );
    el.lookupResult.hidden = false;
  } catch (err) {
    showLookupError(errorMessage(err.code));
  }
});

// ─── Danh sách ───────────────────────────────────────────────────────────

function renderRoster() {
  const columns = status.courses.map((course) => {
    const items = Array.from({ length: course.capacity }, (_, i) => {
      const name = course.members[i];
      if (name == null) return h('li', { class: 'is-open' }, 'Còn trống');
      const isMine = mine && mine.course_id === course.id && mine.name === name;
      return h('li', { class: isMine ? 'is-mine' : null }, name);
    });
    return h('div', { class: 'roster-col' },
      h('h3', {}, course.name, h('span', {}, `${course.taken}/${course.capacity}`)),
      h('ol', {}, ...items),
    );
  });
  if (status.waitlist > 0) {
    columns.push(h('div', { class: 'roster-col' },
      h('h3', {}, 'Danh sách chờ', h('span', {}, `${status.waitlist} người`)),
      h('p', { class: 'roster-empty' }, 'Có người hủy thì người chờ lâu nhất được xếp vào trước.'),
    ));
  }
  el.roster.replaceChildren(...columns);
}

// ─── Vòng đời ────────────────────────────────────────────────────────────

function render() {
  if (selected != null && !courseAvailability(status, selected).open) selected = null;
  if (selected == null && !mine) selected = defaultCourse(status);
  renderCourt();
  justLanded = null; // Bóng chỉ "rơi" một lần, lần vẽ lại sau không lặp animation.
  renderNotice();
  renderForm();
  renderRoster();
}

async function refresh() {
  try {
    status = await api.getStatus();
    render();
  } catch (err) {
    el.formError.textContent = errorMessage(err.code);
    el.formError.hidden = false;
  }
}

async function restoreMine() {
  if (!mine) return;
  try {
    const result = await api.lookup(mine.phone);
    if (!result) return writeMine(null);
    writeMine({ ...mine, course_id: result.course_id });
    showTicket(result);
  } catch {
    // Offline: vẫn hiện form, lần refresh sau sẽ thử lại.
  }
}

function setupDemo() {
  if (!api.isDemo) return;
  $('demo-strip').hidden = false;
  $('demo-reset').addEventListener('click', async () => {
    await api.reset();
    writeMine(null);
    location.reload();
  });
}

setupDemo();
await refresh();
await restoreMine();
if (status) render();
setInterval(() => document.visibilityState === 'visible' && refresh(), REFRESH_MS);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());
