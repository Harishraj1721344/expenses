/**
 * Expense Book - Google Sheets backend (Google Apps Script)
 *
 * All data lives in the Google Sheet this script is attached to:
 *   Users     one row per account (password is stored as a salted hash, never as text)
 *   Expenses  one row per expense: ID, Username, Date, Note, Category, Amount, Card, Bank
 *   Lists     each user's categories, banks and cards (card name, its bank, and bill date for credit cards)
 *   Summary   month-wise totals by category, bank and card (live formulas)
 *
 * SET-UP (see README.md):  1) change SIGNUP_CODE   2) run setup() once
 *                          3) Deploy > New deployment > Web app (Execute as: Me, Access: Anyone)
 */

// Anyone who wants to create an account must type this code. Change it, and keep it private.
const SIGNUP_CODE = 'harish';

const TOKEN_DAYS = 30;     // how long a sign-in stays valid
const HASH_ROUNDS = 1000;  // password hashing rounds
const MAX_BATCH = 500;     // most rows accepted in one import request
const API_VERSION = 2;     // the website checks this to know the deployed script is up to date (2 = cards saved separately)

/* ============================ entry points ============================ */

function doGet() {
  return json_({ ok: true, message: 'Expense Book API is running.', v: API_VERSION });
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    out = route_(req);
  } catch (err) {
    if (!err.userMessage) console.error(err && err.stack ? err.stack : err);
    out = { ok: false, error: err.userMessage || 'Something went wrong. Please try again.', code: err.code || '' };
  }
  return json_(out);
}

function route_(r) {
  if (r.action === 'register') return register_(r);
  if (r.action === 'login') return login_(r);

  const user = authUser_(r.token);
  switch (r.action) {
    case 'load':      return load_(user);
    case 'add':       return withLock_(() => add_(user, [r.entry]));
    case 'bulkAdd':   return withLock_(() => add_(user, r.entries));
    case 'update':    return withLock_(() => update_(user, r.entry));
    case 'remove':    return withLock_(() => remove_(user, r.id));
    case 'saveLists': return withLock_(() => saveLists_(user, r.lists, r.cards));
    default: throw fail_('Unknown request.');
  }
}

/* ============================ accounts ============================ */

function register_(r) {
  if (SIGNUP_CODE === 'change-me') throw fail_('Sign-up is not ready. The owner must change SIGNUP_CODE in Code.gs first.');
  if (String(r.code || '') !== SIGNUP_CODE) throw fail_('The sign-up code is not correct.');
  const name = String(r.username || '').trim();
  const pw = String(r.password || '');
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(name)) throw fail_('Username must be 3 to 30 characters: letters, numbers, dot, dash or underscore.');
  if (pw.length < 6 || pw.length > 100) throw fail_('Password must be 6 to 100 characters.');
  const key = name.toLowerCase();

  return withLock_(() => {
    if (findUser_(key)) throw fail_('That username is already taken. Try signing in instead.');
    const salt = Utilities.getUuid();
    sheet_('Users').appendRow([key, name, salt, hashPw_(pw, salt), new Date()]);
    return { ok: true, token: makeToken_(key), name: name };
  });
}

function login_(r) {
  const key = String(r.username || '').trim().toLowerCase();
  const pw = String(r.password || '');
  const cache = CacheService.getScriptCache();
  const ck = 'fail:' + key;
  const fails = Number(cache.get(ck) || 0);
  if (fails >= 5) throw fail_('Too many wrong attempts. Wait 10 minutes and try again.');

  const u = findUser_(key);
  if (!u || !safeEq_(hashPw_(pw, u.salt), u.hash)) {
    cache.put(ck, String(fails + 1), 600);
    throw fail_('Wrong username or password.');
  }
  cache.remove(ck);
  return { ok: true, token: makeToken_(key), name: u.name };
}

function findUser_(key) {
  const sh = sheet_('Users');
  const last = sh.getLastRow();
  if (last < 2) return null;
  const vals = sh.getRange(2, 1, last - 1, 4).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === key) {
      return { row: i + 2, key: key, name: String(vals[i][1]), salt: String(vals[i][2]), hash: String(vals[i][3]) };
    }
  }
  return null;
}

function hashPw_(pw, salt) {
  let h = salt + pw;
  for (let i = 0; i < HASH_ROUNDS; i++) {
    h = toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt + pw));
  }
  return h;
}
function toHex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
function safeEq_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ---- sign-in tokens (stateless, signed with a secret kept in Script Properties) ---- */

function secret_() {
  const p = PropertiesService.getScriptProperties();
  let s = p.getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('TOKEN_SECRET', s); }
  return s;
}
function sign_(payload) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, secret_()));
}
function makeToken_(key) {
  const payload = key + '|' + (Date.now() + TOKEN_DAYS * 86400000);
  return Utilities.base64EncodeWebSafe(payload) + '.' + sign_(payload);
}
function authUser_(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) throw new Error('bad');
    const payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
    if (!safeEq_(sign_(payload), parts[1])) throw new Error('bad');
    const bits = payload.split('|');
    if (Date.now() > Number(bits[1])) throw new Error('expired');
    const u = findUser_(bits[0]);
    if (!u) throw new Error('gone');
    return u;
  } catch (e) {
    throw fail_('Please sign in again.', 'AUTH');
  }
}

/* ============================ data ============================ */

function load_(u) {
  const tz = tz_();
  const sh = sheet_('Expenses');
  const last = sh.getLastRow();
  const entries = [];
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 8).getValues().forEach(function (r) {
      if (String(r[1]) === u.key) entries.push(rowToEntry_(r, tz));
    });
  }
  const ls = sheet_('Lists');
  const lists = { categories: [], banks: [] };
  let cards = [];
  const legacyCards = [], legacyBilling = [];
  let any = false;
  if (ls.getLastRow() >= 2) {
    ls.getRange(2, 1, ls.getLastRow() - 1, 3).getValues().forEach(function (r) {
      if (String(r[0]) !== u.key) return;
      const type = String(r[1]), val = String(r[2]);
      if (type === 'card') {                       // name|bank|billDay
        const p = val.split('|');
        const day = parseInt(p[2], 10);
        cards.push({ name: p[0], bank: p[1] || '', day: day >= 1 && day <= 31 ? day : null });
        any = true;
      } else if (type === 'categories' || type === 'banks') { lists[type].push(val); any = true; }
      else if (type === 'cards') legacyCards.push(val);                 // older versions
      else if (type === 'billing') {                                    // older versions: bank|card|day
        const p = val.split('|'), day = parseInt(p[2], 10);
        if (p.length === 3 && day >= 1 && day <= 31) legacyBilling.push({ name: p[1], bank: p[0], day: day });
      }
    });
  }
  if (!cards.length && (legacyCards.length || legacyBilling.length)) {   // convert older data on the fly
    cards = legacyBilling.slice();
    legacyCards.forEach(function (n) {
      if (!cards.some(function (c) { return c.name.toLowerCase() === n.toLowerCase(); })) cards.push({ name: n, bank: '', day: null });
    });
    any = true;
  }
  return { ok: true, v: API_VERSION, name: u.name, entries: entries, lists: any ? lists : null, cards: cards };
}

function add_(u, list) {
  if (!Array.isArray(list) || !list.length) throw fail_('Nothing to add.');
  if (list.length > MAX_BATCH) throw fail_('Too many rows in one go. Maximum is ' + MAX_BATCH + '.');
  const tz = tz_();
  const cleaned = list.map(clean_);
  const rows = cleaned.map(function (e) {
    e.id = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    return [e.id, u.key, Utilities.parseDate(e.date, tz, 'yyyy-MM-dd'), e.note, e.category, e.amount, e.card, e.bank];
  });
  const sh = sheet_('Expenses');
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 8).setValues(rows);
  return { ok: true, entries: cleaned };
}

function update_(u, e) {
  const c = clean_(e);
  const row = findEntryRow_(u, e && e.id);
  sheet_('Expenses').getRange(row, 3, 1, 6)
    .setValues([[Utilities.parseDate(c.date, tz_(), 'yyyy-MM-dd'), c.note, c.category, c.amount, c.card, c.bank]]);
  c.id = String(e.id);
  return { ok: true, entry: c };
}

function remove_(u, id) {
  sheet_('Expenses').deleteRow(findEntryRow_(u, id));
  return { ok: true };
}

function findEntryRow_(u, id) {
  const sh = sheet_('Expenses');
  const last = sh.getLastRow();
  if (last >= 2 && id) {
    const vals = sh.getRange(2, 1, last - 1, 2).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][0]) === String(id) && String(vals[i][1]) === u.key) return i + 2;
    }
  }
  throw fail_('That entry was not found. It may already have been deleted.');
}

/**
 * Saves a user's settings.
 *   lists = { categories: [...], banks: [...] }
 *   cards = [{ name, bank, day }]   day = day of month the bill is generated (1-31), or empty for non-credit cards
 * Leaving either argument undefined keeps what is already saved for that part.
 */
function saveLists_(u, lists, cards) {
  const out = [];
  const clip = function (v, n) { return String(v == null ? '' : v).replace(/\|/g, '').trim().slice(0, n); };
  if (lists !== undefined) {
    ['categories', 'banks'].forEach(function (type) {
      const arr = lists && Array.isArray(lists[type]) ? lists[type] : [];
      arr.slice(0, 60).forEach(function (v) {
        const s = clip(v, 40);
        if (s) out.push([u.key, type, s]);
      });
    });
  }
  if (cards !== undefined) {
    const seen = {};
    (Array.isArray(cards) ? cards : []).slice(0, 60).forEach(function (c) {
      const name = clip(c && c.name, 40), bank = clip(c && c.bank, 40);
      const day = parseInt(c && c.day, 10);
      if (name && !seen[name.toLowerCase()]) {
        seen[name.toLowerCase()] = true;
        out.push([u.key, 'card', name + '|' + bank + '|' + (day >= 1 && day <= 31 ? day : '')]);
      }
    });
  }

  const sh = sheet_('Lists');
  const last = sh.getLastRow();
  const old = last >= 2 ? sh.getRange(2, 1, last - 1, 3).getValues() : [];
  const keep = old.filter(function (r) {
    if (String(r[0]) !== u.key) return true;                                   // other users' rows
    const t = String(r[1]);
    if (t === 'categories' || t === 'banks') return lists === undefined;
    return cards === undefined;                                                // card, and older cards/billing rows
  });
  const all = keep.concat(out);
  if (last >= 2) sh.getRange(2, 1, last - 1, 3).clearContent();
  if (all.length) sh.getRange(2, 1, all.length, 3).setValues(all);
  return { ok: true, v: API_VERSION };
}

function clean_(e) {
  e = e || {};
  const date = String(e.date || '');
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const t = m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  if (!t || t.getMonth() !== +m[2] - 1 || t.getDate() !== +m[3]) throw fail_('Enter a valid date.');
  const amount = Math.round(Number(e.amount) * 100) / 100;
  if (!(amount > 0) || amount >= 1e9) throw fail_('Enter an amount greater than 0.');
  const txt = function (v, n) { return String(v == null ? '' : v).trim().slice(0, n); };
  return {
    date: date, note: txt(e.note, 120), category: txt(e.category, 40) || 'Other',
    amount: amount, card: txt(e.card, 40), bank: txt(e.bank, 40)
  };
}

function rowToEntry_(r, tz) {
  const d = r[2] instanceof Date ? Utilities.formatDate(r[2], tz, 'yyyy-MM-dd') : String(r[2]);
  return { id: String(r[0]), date: d, note: String(r[3]), category: String(r[4]), amount: Number(r[5]), card: String(r[6]), bank: String(r[7]) };
}

/* ============================ helpers ============================ */

function fail_(msg, code) { const e = new Error(msg); e.userMessage = msg; e.code = code || ''; return e; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function tz_() { return SpreadsheetApp.getActive().getSpreadsheetTimeZone(); }
function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw fail_('The "' + name + '" sheet is missing. Run setup() once from the Apps Script editor.');
  return sh;
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ============================ one-time setup ============================ */

/** Run this once from the Apps Script editor (select setup, press Run). Safe to run again. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  const get = function (name) { return ss.getSheetByName(name) || ss.insertSheet(name); };

  const users = get('Users'), exp = get('Expenses'), lists = get('Lists'), sum = get('Summary');

  header_(users, ['Username', 'Display name', 'Salt', 'Password hash', 'Created']);
  users.getRange('A2:D').setNumberFormat('@');
  users.getRange('E2:E').setNumberFormat('dd-mmm-yyyy hh:mm');

  header_(exp, ['ID', 'Username', 'Date', 'Note', 'Category', 'Amount (₹)', 'Card', 'Bank']);
  ['A2:B', 'D2:E', 'G2:H'].forEach(function (a) { exp.getRange(a).setNumberFormat('@'); });
  exp.getRange('C2:C').setNumberFormat('dd-mmm-yyyy');
  exp.getRange('F2:F').setNumberFormat('"₹"#,##0.00');
  [90, 110, 110, 260, 130, 120, 130, 110].forEach(function (w, i) { exp.setColumnWidth(i + 1, w); });

  header_(lists, ['Username', 'Type', 'Value']);
  lists.getRange('A2:C').setNumberFormat('@');

  buildSummary_(sum);

  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  ss.setActiveSheet(sum);
  secret_();
  console.log('Setup finished. Next: Deploy > New deployment > Web app.');
}

function header_(sh, cols) {
  sh.getRange(1, 1, 1, cols.length).setValues([cols])
    .setFontWeight('bold').setBackground('#0E5C57').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
}

function buildSummary_(sh) {
  sh.clear();
  sh.getRange('A1').setValue('Username').setFontWeight('bold');
  sh.getRange('B1').setFormula('=IFERROR(INDEX(Users!A:A,2),"")')
    .setBackground('#FFFF00').setFontColor('#0000FF').setFontWeight('bold');
  sh.getRange('C1').setValue('<- type the username whose expenses you want to see');
  sh.getRange('A2').setValue('Year').setFontWeight('bold');
  sh.getRange('B2').setFormula('=YEAR(TODAY())')
    .setBackground('#FFFF00').setFontColor('#0000FF').setFontWeight('bold');
  sh.getRange('C2').setValue('<- change the year');
  summaryBlock_(sh, 4, 'By category (month-wise)', 'E');
  summaryBlock_(sh, 21, 'By bank (month-wise)', 'H');
  summaryBlock_(sh, 38, 'By card (month-wise)', 'G');
  sh.setColumnWidth(1, 110);
  sh.setFrozenColumns(1);
}

function summaryBlock_(sh, start, title, fc) {
  const hr = start + 1;
  const F = 'Expenses!$F$2:$F', U = 'Expenses!$B$2:$B', D = 'Expenses!$C$2:$C', X = 'Expenses!$' + fc + '$2:$' + fc;
  sh.getRange(start, 1).setValue(title).setFontWeight('bold').setFontSize(12);

  const heads = [];
  for (let i = 1; i <= 12; i++) {
    heads.push('=IFERROR(INDEX(SORT(UNIQUE(FILTER(' + X + ',' + U + '=$B$1,' + X + '<>""))),' + i + '),"")');
  }
  sh.getRange(hr, 1).setValue('Month');
  sh.getRange(hr, 2, 1, 12).setFormulas([heads]);
  sh.getRange(hr, 14).setValue('Total');
  sh.getRange(hr, 1, 1, 14).setFontWeight('bold').setBackground('#0E5C57').setFontColor('#FFFFFF').setHorizontalAlignment('center');

  const colL = function (n) { return String.fromCharCode(64 + n); };
  const body = [];
  for (let m = 0; m < 12; m++) {
    const r = hr + 1 + m;
    const row = [m === 0 ? '=DATE($B$2,1,1)' : '=EDATE(A' + (r - 1) + ',1)'];
    for (let c = 2; c <= 13; c++) {
      const L = colL(c);
      row.push('=IF(' + L + '$' + hr + '="","",SUMIFS(' + F + ',' + U + ',$B$1,' + D + ',">="&$A' + r + ',' + D + ',"<"&EDATE($A' + r + ',1),' + X + ',' + L + '$' + hr + '))');
    }
    row.push('=SUMIFS(' + F + ',' + U + ',$B$1,' + D + ',">="&$A' + r + ',' + D + ',"<"&EDATE($A' + r + ',1))');
    body.push(row);
  }
  sh.getRange(hr + 1, 1, 12, 14).setFormulas(body);
  sh.getRange(hr + 1, 1, 12, 1).setNumberFormat('mmm yyyy').setFontWeight('bold');
  sh.getRange(hr + 1, 2, 12, 13).setNumberFormat('"₹"#,##0.00;;-');

  const tot = ['Year total'];
  for (let c = 2; c <= 14; c++) tot.push('=SUM(' + colL(c) + (hr + 1) + ':' + colL(c) + (hr + 12) + ')');
  sh.getRange(hr + 13, 1, 1, 14).setFormulas([tot]).setFontWeight('bold').setBorder(true, null, null, null, null, null);
  sh.getRange(hr + 13, 2, 1, 13).setNumberFormat('"₹"#,##0.00');
}
