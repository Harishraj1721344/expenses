/* Expense Book - plain HTML/CSS/JS, no frameworks.
   All data is saved in your Google Sheet through the Apps Script web app (Code.gs). */
(() => {
'use strict';

/* ---------- tiny helpers ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clone = o => JSON.parse(JSON.stringify(o));
const pad = n => String(n).padStart(2, '0');
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = n => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n || 0);
const inrShort = n => n >= 100000 ? (n / 100000).toFixed(1) + 'L' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(Math.round(n));
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const monthOf = d => d.slice(0, 7);
const monthLabel = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }); };
const monthShort = (y, m) => new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short' });
const shiftMonth = (ym, delta) => { let [y, m] = ym.split('-').map(Number); m += delta; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return `${y}-${pad(m)}`; };
const sum = arr => round2(arr.reduce((a, e) => a + e.amount, 0));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const groupBy = (arr, fn) => { const m = new Map(); arr.forEach(e => { const k = fn(e); m.set(k, round2((m.get(k) || 0) + e.amount)); }); return [...m].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total); };

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------- Google Sheet connection ---------- */
const CFG = window.EXPENSE_CONFIG || {};
const TOKEN_KEY = 'eb:token';
const DEFAULT_LISTS = {
  categories: ['Food', 'Snacks', 'Petrol', 'Groceries', 'Bills', 'Shopping', 'Travel', 'Medical', 'Other'],
  banks: ['HDFC', 'SBI', 'ICICI', 'Axis', 'Kotak', 'Other'],
  cards: ['Credit Card', 'Debit Card', 'UPI', 'Cash']
};

let token = null;          // sign-in token issued by the Google Sheet script
let accountName = '';
let loaded = false;        // true once expenses have been read from the sheet
let loadError = '';
let busy = false;
let state = { entries: [], lists: clone(DEFAULT_LISTS) };
let viewMonth = todayStr().slice(0, 7);
let reportYear = new Date().getFullYear();
let editingId = null;
let authMode = 'login';

async function api(action, payload) {
  if (!CFG.API_URL) throw new Error('Not connected to Google Sheets yet. Add your Web app URL to config.js.');
  let res;
  try {
    // A plain-text body avoids a CORS preflight, which Apps Script does not answer.
    res = await fetch(CFG.API_URL, { method: 'POST', body: JSON.stringify(Object.assign({ action, token }, payload || {})) });
  } catch (e) {
    throw new Error('Could not reach Google Sheets. Check your internet connection.');
  }
  let data;
  try { data = await res.json(); }
  catch (e) { throw new Error('Unexpected reply from the Google Sheet script. Check that the web app is deployed with access set to Anyone.'); }
  if (!data.ok) {
    if (data.code === 'AUTH' && token) { logout('Your session ended. Please sign in again.'); }
    const err = new Error(data.error || 'Request failed.'); err.code = data.code; throw err;
  }
  return data;
}

function saveToken(tok, name, keep) {
  const v = JSON.stringify({ token: tok, name });
  try { (keep ? localStorage : sessionStorage).setItem(TOKEN_KEY, v); } catch (e) { /* storage blocked: sign-in lasts until reload */ }
}
function readToken() {
  for (const st of [sessionStorage, localStorage]) {
    try { const v = JSON.parse(st.getItem(TOKEN_KEY) || 'null'); if (v && v.token) return v; } catch (e) { /* ignore */ }
  }
  return null;
}
function clearToken() {
  try { sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
}

function setBusy(on) {
  busy = on;
  const b = $('#f-submit');
  b.disabled = on;
  b.textContent = on ? 'Saving to Google Sheet...' : (editingId ? 'Save changes' : 'Add expense');
}

/* =====================================================
   AUTH
   ===================================================== */
function setAuthMode(mode) {
  authMode = mode;
  const create = mode === 'create';
  $('#tab-login').setAttribute('aria-selected', String(!create));
  $('#tab-create').setAttribute('aria-selected', String(create));
  $('#a-pass2-wrap').hidden = !create;
  $('#a-code-wrap').hidden = !create;
  $('#a-pass').autocomplete = create ? 'new-password' : 'current-password';
  $('#auth-submit').textContent = create ? 'Create account' : 'Sign in';
  $('#auth-sub').textContent = create ? 'Choose a username and password.' : 'Sign in to see your expenses.';
  $('#auth-msg').textContent = '';
}

async function enterApp(tok, name, keep) {
  token = tok; accountName = name;
  saveToken(tok, name, keep);
  state = { entries: [], lists: clone(DEFAULT_LISTS) };
  loaded = false; loadError = '';
  $('#auth').hidden = true;
  $('#app').hidden = false;
  $('#who').textContent = name;
  viewMonth = todayStr().slice(0, 7);
  reportYear = new Date().getFullYear();
  fillSelects();
  $('#f-date').value = todayStr();
  switchView('entries');
  window.scrollTo(0, 0);
  await loadFromSheet();
}

async function loadFromSheet() {
  loaded = false; loadError = '';
  renderEntries();
  try {
    const d = await api('load');
    state.entries = d.entries || [];
    if (d.lists) state.lists = Object.assign(clone(DEFAULT_LISTS), d.lists);
    accountName = d.name || accountName;
    $('#who').textContent = accountName;
    loaded = true;
    fillSelects();
  } catch (err) {
    if (!token) return;               // already signed out
    loadError = err.message;
  }
  if (token) { $('#view-entries').hidden ? renderReports() : renderEntries(); }
}

function logout(message) {
  clearToken();
  token = null; editingId = null; loaded = false;
  state = { entries: [], lists: clone(DEFAULT_LISTS) };
  $('#app').hidden = true;
  $('#auth').hidden = false;
  $('#a-pass').value = ''; $('#a-pass2').value = ''; $('#a-code').value = '';
  endEdit();
  setAuthMode('login');
  $('#auth-msg').textContent = typeof message === 'string' ? message : '';
  $('#a-user').focus();
}

$('#tab-login').addEventListener('click', () => setAuthMode('login'));
$('#tab-create').addEventListener('click', () => setAuthMode('create'));
$('#a-show').addEventListener('change', e => {
  const t = e.target.checked ? 'text' : 'password';
  $('#a-pass').type = t; $('#a-pass2').type = t;
});
$('#auth-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const name = $('#a-user').value.trim();
  const pw = $('#a-pass').value;
  const msg = $('#auth-msg'), btn = $('#auth-submit');
  msg.textContent = '';
  try {
    if (!/^[A-Za-z0-9._-]{3,30}$/.test(name)) throw new Error('Username must be 3 to 30 characters: letters, numbers, dot, dash or underscore.');
    if (!pw) throw new Error('Enter your password.');
    let d;
    if (authMode === 'create') {
      if (pw.length < 6) throw new Error('Password must be at least 6 characters.');
      if (pw !== $('#a-pass2').value) throw new Error('The two passwords do not match.');
      if (!$('#a-code').value.trim()) throw new Error('Enter the sign-up code.');
      btn.disabled = true; btn.textContent = 'Creating account...';
      d = await api('register', { username: name, password: pw, code: $('#a-code').value.trim() });
    } else {
      btn.disabled = true; btn.textContent = 'Signing in...';
      d = await api('login', { username: name, password: pw });
    }
    await enterApp(d.token, d.name, $('#a-keep').checked);
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    btn.disabled = !CFG.API_URL;
    btn.textContent = authMode === 'create' ? 'Create account' : 'Sign in';
  }
});
$('#btn-logout').addEventListener('click', () => logout());

/* =====================================================
   SELECTS & FORM
   ===================================================== */
function fillSelect(sel, items, blank) {
  const cur = sel.value;
  sel.innerHTML = (blank ? '<option value="">None</option>' : '') + items.map(i => `<option value="${esc(i)}">${esc(i)}</option>`).join('');
  if (cur && items.includes(cur)) sel.value = cur;
}
function fillSelects() {
  fillSelect($('#f-cat'), state.lists.categories, false);
  fillSelect($('#f-card'), state.lists.cards, true);
  fillSelect($('#f-bank'), state.lists.banks, true);
}
function setSelect(sel, val) {
  if (val && ![...sel.options].some(o => o.value === val)) sel.add(new Option(val, val));
  sel.value = val || '';
}
function endEdit() {
  editingId = null;
  $('#f-submit').textContent = 'Add expense';
  $('#f-cancel').hidden = true;
  $('#entry-form').classList.remove('editing');
}
function resetForm() {
  $('#f-note').value = ''; $('#f-amt').value = '';
  $('#f-note').focus();
}

$('#entry-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  if (busy) return;
  if (!loaded) return toast('Still loading from Google Sheet. Try again in a moment.');
  const date = $('#f-date').value;
  const amount = round2(parseFloat($('#f-amt').value));
  if (!date) return toast('Pick a date.');
  if (!(amount > 0)) return toast('Enter an amount greater than 0.');
  const rec = { date, note: $('#f-note').value.trim(), category: $('#f-cat').value || 'Other', amount, card: $('#f-card').value, bank: $('#f-bank').value };
  setBusy(true);
  try {
    if (editingId) {
      const d = await api('update', { entry: Object.assign({ id: editingId }, rec) });
      const i = state.entries.findIndex(e => e.id === editingId);
      if (i > -1) state.entries[i] = d.entry;
      endEdit();
      toast('Changes saved to Google Sheet.');
    } else {
      const d = await api('add', { entry: rec });
      state.entries.push(d.entries[0]);
      toast('Saved to Google Sheet.');
    }
    viewMonth = monthOf(date);
    resetForm();
    renderEntries();
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(false);
  }
});
$('#f-cancel').addEventListener('click', () => { endEdit(); resetForm(); $('#f-date').value = todayStr(); });

/* =====================================================
   ENTRIES VIEW
   ===================================================== */
function breakdownPanel(title, field, ents, total) {
  const rows = groupBy(ents, e => e[field] || 'Not set');
  const body = rows.length
    ? `<ul class="bl">${rows.map(r => {
        const pct = total ? Math.round(r.total / total * 100) : 0;
        return `<li><div class="bl-row"><span>${esc(r.name)}</span><span>${inr(r.total)}</span></div>
          <div class="bl-track"><i style="width:${pct}%"></i></div><span class="bl-pct">${pct}% of the month</span></li>`;
      }).join('')}</ul>`
    : '<p class="hint">Nothing yet.</p>';
  return `<section class="panel"><h3>${title}</h3>${body}</section>`;
}

function renderEntries() {
  const ym = viewMonth;
  $('#m-label').textContent = monthLabel(ym);

  const monthEntries = state.entries.filter(e => monthOf(e.date) === ym);
  const total = sum(monthEntries);
  const prevYm = shiftMonth(ym, -1);
  const prevTotal = sum(state.entries.filter(e => monthOf(e.date) === prevYm));

  let cmp;
  if (!prevTotal) cmp = 'No spending last month to compare with.';
  else {
    const d = round2(total - prevTotal);
    cmp = d === 0 ? `Same as ${monthLabel(prevYm)}.` : `${inr(Math.abs(d))} ${d > 0 ? 'more' : 'less'} than ${monthLabel(prevYm)}.`;
  }
  const top = groupBy(monthEntries, e => e.category || 'Other')[0];
  const [y, m] = ym.split('-').map(Number);
  const now = new Date();
  const isNow = now.getFullYear() === y && now.getMonth() + 1 === m;
  const days = isNow ? now.getDate() : new Date(y, m, 0).getDate();

  $('#strip').innerHTML = `
    <div><span class="strip-label">Spent in ${esc(monthLabel(ym))}</span><strong class="strip-total">${inr(total)}</strong><span class="strip-note">${esc(cmp)}</span></div>
    <div><span class="strip-label">Biggest category</span><strong class="strip-val">${top ? esc(top.name) : 'None yet'}</strong><span class="strip-note">${top ? inr(top.total) : ''}</span></div>
    <div><span class="strip-label">Average per day</span><strong class="strip-val">${inr(round2(total / days))}</strong><span class="strip-note">over ${days} day${days > 1 ? 's' : ''}</span></div>
    <div><span class="strip-label">Entries</span><strong class="strip-val">${monthEntries.length}</strong><span class="strip-note">this month</span></div>`;

  const q = $('#search').value.trim().toLowerCase();
  const shown = monthEntries
    .filter(e => !q || [e.note, e.category, e.card, e.bank].some(v => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));

  $('#tbody').innerHTML = !loaded ? (loadError
    ? `<tr><td colspan="7" class="empty">${esc(loadError)}<br><button type="button" class="btn small" data-act="retry">Try again</button></td></tr>`
    : '<tr class="loading-row"><td colspan="7" class="empty">Loading your expenses from Google Sheet...</td></tr>')
    : shown.length ? shown.map(e => `
    <tr data-id="${esc(e.id)}">
      <td>${esc(e.date.split('-').reverse().join('-'))}</td>
      <td class="note">${esc(e.note) || '<span class="muted">No note</span>'}</td>
      <td><span class="tag">${esc(e.category)}</span></td>
      <td>${esc(e.card) || '<span class="muted">None</span>'}</td>
      <td>${esc(e.bank) || '<span class="muted">None</span>'}</td>
      <td class="num">${inr(e.amount)}</td>
      <td><div class="row-actions">
        <button type="button" class="link-btn" data-act="edit">Edit</button>
        <button type="button" class="link-btn danger" data-act="del">Delete</button>
      </div></td>
    </tr>`).join('')
    : `<tr><td colspan="7" class="empty">${q ? 'No entries match your search.' : `No expenses in ${esc(monthLabel(ym))}. Add one with the form above.`}</td></tr>`;

  $('#tfoot').innerHTML = loaded && shown.length ? `<tr><td colspan="5">${q ? 'Total of matching entries' : 'Total'}</td><td class="num">${inr(sum(shown))}</td><td></td></tr>` : '';

  $('#breakdown').innerHTML =
    breakdownPanel('By category', 'category', monthEntries, total) +
    breakdownPanel('By bank', 'bank', monthEntries, total) +
    breakdownPanel('By card', 'card', monthEntries, total);
}

$('#tbody').addEventListener('click', async ev => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'retry') return loadFromSheet();
  const id = btn.closest('tr').dataset.id;
  const e = state.entries.find(x => x.id === id);
  if (!e || busy) return;
  if (btn.dataset.act === 'del') {
    if (!confirm(`Delete this expense?\n${e.date}  ${e.note || e.category}  ${inr(e.amount)}`)) return;
    btn.disabled = true;
    try {
      await api('remove', { id });
      state.entries = state.entries.filter(x => x.id !== id);
      if (editingId === id) endEdit();
      renderEntries(); toast('Expense deleted from Google Sheet.');
    } catch (err) { btn.disabled = false; toast(err.message); }
  } else {
    editingId = id;
    $('#f-date').value = e.date; $('#f-note').value = e.note; $('#f-amt').value = e.amount;
    setSelect($('#f-cat'), e.category); setSelect($('#f-card'), e.card); setSelect($('#f-bank'), e.bank);
    $('#f-submit').textContent = 'Save changes';
    $('#f-cancel').hidden = false;
    $('#entry-form').classList.add('editing');
    $('#entry-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#f-note').focus();
  }
});
$('#search').addEventListener('input', renderEntries);
$('#m-prev').addEventListener('click', () => { viewMonth = shiftMonth(viewMonth, -1); renderEntries(); });
$('#m-next').addEventListener('click', () => { viewMonth = shiftMonth(viewMonth, 1); renderEntries(); });
$('#m-today').addEventListener('click', () => { viewMonth = todayStr().slice(0, 7); renderEntries(); });

/* =====================================================
   REPORTS VIEW
   ===================================================== */
function matrixTable(title, field, listItems, ents, year) {
  const extra = [...new Set(ents.map(e => e[field] || '').filter(v => v && !listItems.includes(v)))];
  let cols = [...listItems, ...extra];
  if (ents.some(e => !e[field])) cols.push('');
  const label = c => c || 'Not set';
  const val = (e) => e[field] || '';
  cols = cols.filter(c => ents.some(e => val(e) === c));
  if (!cols.length) return `<section class="panel"><h3>${title}</h3><p class="hint">No expenses in ${year} yet.</p></section>`;

  const colTotals = cols.map(() => 0);
  let grand = 0;
  const rows = [];
  for (let m = 1; m <= 12; m++) {
    const ym = `${year}-${pad(m)}`;
    const me = ents.filter(e => monthOf(e.date) === ym);
    const cells = cols.map((c, i) => { const v = sum(me.filter(e => val(e) === c)); colTotals[i] = round2(colTotals[i] + v); return v; });
    const rt = sum(me); grand = round2(grand + rt);
    rows.push(`<tr><td>${monthShort(year, m)}</td>${cells.map(v => `<td class="num${v ? '' : ' zero'}">${v ? inr(v) : '-'}</td>`).join('')}<td class="num"><strong>${rt ? inr(rt) : '-'}</strong></td></tr>`);
  }
  return `<section class="panel"><h3>${title}</h3><div class="matrix-wrap"><table class="matrix">
    <thead><tr><th>Month</th>${cols.map(c => `<th class="num">${esc(label(c))}</th>`).join('')}<th class="num">Total</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
    <tfoot><tr><td>${year} total</td>${colTotals.map(v => `<td class="num">${inr(v)}</td>`).join('')}<td class="num">${inr(grand)}</td></tr></tfoot>
  </table></div></section>`;
}

function renderReports() {
  const y = reportYear;
  $('#y-label').textContent = y;
  const ents = state.entries.filter(e => e.date.startsWith(y + '-'));
  const totals = [];
  for (let m = 1; m <= 12; m++) totals.push(sum(ents.filter(e => monthOf(e.date) === `${y}-${pad(m)}`)));
  const max = Math.max(...totals, 1);
  const now = new Date();
  $('#bars').innerHTML = totals.map((t, i) => {
    const ym = `${y}-${pad(i + 1)}`;
    const cur = now.getFullYear() === y && now.getMonth() === i;
    return `<button type="button" class="bar${cur ? ' now' : ''}" data-ym="${ym}" title="${esc(monthLabel(ym))}: ${inr(t)}" aria-label="${esc(monthLabel(ym))}: ${inr(t)}">
      <span class="bar-val">${t ? inrShort(t) : ''}</span>
      <span class="bar-fill" style="height:${Math.round(t / max * 150)}px"></span>
      <span class="bar-lab">${monthShort(y, i + 1)}</span></button>`;
  }).join('');

  $('#matrices').innerHTML =
    matrixTable('By category, month-wise', 'category', state.lists.categories, ents, y) +
    matrixTable('By bank, month-wise', 'bank', state.lists.banks, ents, y) +
    matrixTable('By card, month-wise', 'card', state.lists.cards, ents, y);
}
$('#bars').addEventListener('click', ev => {
  const b = ev.target.closest('.bar'); if (!b) return;
  viewMonth = b.dataset.ym; switchView('entries');
});
$('#y-prev').addEventListener('click', () => { reportYear--; renderReports(); });
$('#y-next').addEventListener('click', () => { reportYear++; renderReports(); });
$('#y-today').addEventListener('click', () => { reportYear = new Date().getFullYear(); renderReports(); });

/* =====================================================
   VIEW SWITCHING
   ===================================================== */
function switchView(v) {
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  $('#view-entries').hidden = v !== 'entries';
  $('#view-reports').hidden = v !== 'reports';
  if (v === 'entries') renderEntries(); else renderReports();
}
$$('.tabs button').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));

/* =====================================================
   LISTS DIALOG
   ===================================================== */
const LIST_META = [
  { key: 'categories', title: 'Categories', ph: 'e.g. Rent' },
  { key: 'banks', title: 'Banks', ph: 'e.g. Canara' },
  { key: 'cards', title: 'Cards and payment types', ph: 'e.g. Amazon Pay card' }
];
function renderLists() {
  $('#lists-body').innerHTML = LIST_META.map(m => `
    <div class="list-sec">
      <h3>${m.title}</h3>
      <div class="chips">${state.lists[m.key].map((it, i) =>
        `<span class="chip">${esc(it)}<button type="button" data-key="${m.key}" data-i="${i}" aria-label="Remove ${esc(it)}">×</button></span>`).join('') || '<span class="hint">Empty</span>'}</div>
      <form class="add-row" data-key="${m.key}">
        <input type="text" maxlength="40" placeholder="${m.ph}" aria-label="Add to ${m.title}">
        <button type="submit" class="btn">Add</button>
      </form>
    </div>`).join('');
}
$('#btn-lists').addEventListener('click', () => { renderLists(); $('#dlg-lists').showModal(); });
$('#dlg-close').addEventListener('click', () => $('#dlg-lists').close());
$('#dlg-lists').addEventListener('close', () => { fillSelects(); if (token) { $('#view-entries').hidden ? renderReports() : renderEntries(); } });

async function persistLists(previous) {
  try { await api('saveLists', { lists: state.lists }); toast('Lists saved to Google Sheet.'); }
  catch (err) { state.lists = previous; toast(err.message); }
  renderLists(); fillSelects();
}
$('#lists-body').addEventListener('click', ev => {
  const b = ev.target.closest('button[data-key]'); if (!b) return;
  const prev = clone(state.lists);
  state.lists[b.dataset.key].splice(Number(b.dataset.i), 1);
  renderLists(); persistLists(prev);
});
$('#lists-body').addEventListener('submit', ev => {
  ev.preventDefault();
  const f = ev.target, key = f.dataset.key, input = $('input', f);
  const val = input.value.trim();
  if (!val) return;
  if (state.lists[key].some(x => x.toLowerCase() === val.toLowerCase())) { toast('That is already in the list.'); return; }
  const prev = clone(state.lists);
  state.lists[key].push(val);
  renderLists(); persistLists(prev);
});

/* =====================================================
   CSV EXPORT / IMPORT  (columns match the Excel tracker)
   ===================================================== */
const csvCell = v => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const guardFormula = s => /^[=+\-@]/.test(s) ? "'" + s : s;
const unguardFormula = s => /^'[=+\-@]/.test(s) ? s.slice(1) : s;

function exportCSV() {
  const rows = [['Date', 'Note', 'Category', 'Amount', 'Card', 'Bank']];
  [...state.entries].sort((a, b) => a.date.localeCompare(b.date))
    .forEach(e => rows.push([e.date, guardFormula(e.note), e.category, e.amount, e.card, e.bank]));
  const csv = '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `expenses-${accountName || 'me'}-${todayStr()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${state.entries.length} entries.`);
}

function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some(x => x.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some(x => x.trim() !== '')) rows.push(row);
  return rows;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function validYMD(y, m, d) { const t = new Date(y, m - 1, d); return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d; }
function parseDate(s) {
  s = String(s || '').trim(); let m;
  let y, mo, d;
  if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s,-]+(\d{2,4})$/))) { d = +m[1]; mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1; y = +m[3]; }
  else return null;
  if (y < 100) y += 2000;
  return mo >= 1 && validYMD(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
}

async function importCSV(text) {
  if (!loaded) return toast('Still loading from Google Sheet. Try again in a moment.');
  const rows = parseCSV(text.replace(/^\ufeff/, ''));
  if (!rows.length) return toast('That file is empty.');
  let idx = { date: 0, note: 1, category: 2, amount: 3, card: 4, bank: 5 };
  const head = rows[0].map(h => h.trim().toLowerCase());
  if (head.includes('date') && head.some(h => h.startsWith('amount'))) {
    idx = {
      date: head.indexOf('date'), note: head.indexOf('note'), category: head.indexOf('category'),
      amount: head.findIndex(h => h.startsWith('amount')), card: head.indexOf('card'), bank: head.indexOf('bank')
    };
    rows.shift();
  }
  const get = (r, k) => (idx[k] > -1 && r[idx[k]] != null ? r[idx[k]].trim() : '');
  const seen = new Set(state.entries.map(e => [e.date, e.note, e.amount, e.category, e.card, e.bank].join('|')));
  const fresh = []; let dupes = 0, bad = 0;
  rows.forEach(r => {
    const date = parseDate(get(r, 'date'));
    const amount = round2(parseFloat(get(r, 'amount').replace(/[^0-9.\-]/g, '')));
    if (!date || !(amount > 0)) { bad++; return; }
    const rec = { date, note: unguardFormula(get(r, 'note')), category: get(r, 'category') || 'Other', amount, card: get(r, 'card'), bank: get(r, 'bank') };
    const k = [rec.date, rec.note, rec.amount, rec.category, rec.card, rec.bank].join('|');
    if (seen.has(k)) { dupes++; return; }
    seen.add(k); fresh.push(rec);
  });
  if (!fresh.length) return toast(`Nothing new to import. ${dupes} duplicate${dupes === 1 ? '' : 's'}, ${bad} unreadable row${bad === 1 ? '' : 's'}.`);

  busy = true;
  let added = 0;
  try {
    for (let i = 0; i < fresh.length; i += 200) {
      toast(`Saving to Google Sheet... ${Math.min(i + 200, fresh.length)} of ${fresh.length}`);
      const d = await api('bulkAdd', { entries: fresh.slice(i, i + 200) });
      state.entries.push(...d.entries); added += d.entries.length;
    }
    const prev = clone(state.lists); let changed = false;
    fresh.forEach(rec => [['categories', rec.category], ['cards', rec.card], ['banks', rec.bank]].forEach(([lk, v]) => {
      if (v && !state.lists[lk].some(x => x.toLowerCase() === v.toLowerCase())) { state.lists[lk].push(v); changed = true; }
    }));
    if (changed) { try { await api('saveLists', { lists: state.lists }); } catch (e) { state.lists = prev; } }
    toast(`Imported ${added}. Skipped ${dupes} duplicate${dupes === 1 ? '' : 's'} and ${bad} unreadable row${bad === 1 ? '' : 's'}.`);
  } catch (err) {
    toast(`Imported ${added} before an error: ${err.message}`);
  } finally {
    busy = false; fillSelects(); renderEntries();
  }
}

$('#btn-export').addEventListener('click', exportCSV);
$('#file-import').addEventListener('change', ev => {
  const f = ev.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => importCSV(String(r.result));
  r.onerror = () => toast('Could not read that file.');
  r.readAsText(f);
  ev.target.value = '';
});

/* =====================================================
   BOOT
   ===================================================== */
if (!CFG.API_URL) {
  $('#auth-msg').textContent = 'Not connected to Google Sheets yet. Paste your Web app URL into config.js (see README).';
  $('#auth-submit').disabled = true;
} else {
  const saved = readToken();
  if (saved) enterApp(saved.token, saved.name, !!localStorage.getItem(TOKEN_KEY));
  else $('#a-user').focus();
}

})();
