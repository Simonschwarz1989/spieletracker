'use strict';
/* =====================================================================
   Spieletracker – Daten liegen lokal (ein Gerät) oder in Firebase (Gruppe)
   ===================================================================== */
const CFG = window.FIREBASE_CONFIG || null;
const LS = { me: 'st.me', group: 'st.group', local: 'st.local.v2' };
const DEL = { __del: true };
const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => (b % 36).toString(36)).join('');
const clone = o => JSON.parse(JSON.stringify(o));
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

const db = { games: {}, players: {}, plays: {} };
const games = () => Object.values(db.games);
const players = () => Object.values(db.players);
const plays = () => Object.values(db.plays);
const G = id => db.games[id];
const P = id => db.players[id];
const me = () => { const id = localStorage.getItem(LS.me); return id && db.players[id] ? id : null; };

function seedGames() {
  const list = SEED.map(s => ({ id: uid(), name: s.n, type: s.t, _p: s.p || null, loc: s.l || '', note: s.a || '', ratings: {}, overall: {}, lowWins: false, ...infoFrom(s) }));
  const byName = Object.fromEntries(list.map(g => [g.name, g.id]));
  list.forEach(g => { g.parent = (g._p && byName[g._p]) || null; delete g._p; });
  return list;
}
const INFO_V = 4; // erhöhen, wenn die Sammlung neue Felder bekommt
function infoFrom(s) {
  return { desc: s.d || '', minP: s.min ?? null, maxP: s.max ?? null, time: s.dur || null, weight: s.w ?? null, tags: s.tags || [], year: s.y ?? null, bgg: s.bgg ?? null, img: s.img || null, thumb: s.th || null, infoV: INFO_V };
}
// Spiel-Infos aus der Sammlung nachtragen (nur leere Felder, nur einmal pro Spiel)
function fillInfo() {
  const byName = Object.fromEntries(SEED.map(x => [x.n, x]));
  for (const g of games()) {
    // Reparatur: eine frühere Version hatte die Art (Grundspiel/Erweiterung) mit der Spieldauer überschrieben
    if (typeof g.type !== 'string') { const src = byName[g.name]; const fix = { type: src ? src.t : 'base' }; if (Array.isArray(g.type)) { fix.infoV = 0; } store === Local ? applyPatch(g, fix) : store.update('games', g.id, fix); if (fix.infoV === 0) g.infoV = 0; }
    if ((g.infoV || 0) >= INFO_V) continue;
    const src = byName[g.name], info = src ? infoFrom(src) : { infoV: INFO_V };
    const patch = {};
    for (const [k, v] of Object.entries(info)) if (k === 'infoV' || g[k] == null || g[k] === '' || (Array.isArray(g[k]) && !g[k].length)) patch[k] = v;
    if (store === Local) applyPatch(g, patch); else store.update('games', g.id, patch);
  }
  if (store === Local) Local.persist();
}
function applyPatch(obj, patch) {
  for (const [k, v] of Object.entries(patch)) {
    const path = k.split('.'); let o = obj;
    for (const seg of path.slice(0, -1)) o = (o[seg] && typeof o[seg] === 'object') ? o[seg] : (o[seg] = {});
    const last = path[path.length - 1];
    if (v === DEL) delete o[last]; else o[last] = clone(v);
  }
}

/* ---------- Cover-Bilder ---------- */
const coverURL = {};            // gameId -> object-URL
function setCover(gid, blob) {
  if (coverURL[gid]) URL.revokeObjectURL(coverURL[gid]);
  if (blob) coverURL[gid] = URL.createObjectURL(blob); else delete coverURL[gid];
}
const dataToBlob = d => { const [h, b] = d.split(','), bin = atob(b), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: h.slice(5).split(';')[0] }); };
const blobToData = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
const IDB = {
  open() { return this.p ||= new Promise((res, rej) => { const r = indexedDB.open('spieletracker', 1); r.onupgradeneeded = () => r.result.createObjectStore('covers'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async tx(mode, fn) { const d = await this.open(); return new Promise((res, rej) => { const t = d.transaction('covers', mode); const out = fn(t.objectStore('covers')); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); }); },
  async all() { const d = await this.open(); return new Promise(res => { const out = {}; d.transaction('covers').objectStore('covers').openCursor().onsuccess = e => { const c = e.target.result; if (c) { out[c.key] = c.value; c.continue(); } else res(out); }; }); },
  put(k, v) { return this.tx('readwrite', st => st.put(v, k)); },
  del(k) { return this.tx('readwrite', st => st.delete(k)); },
};
async function resizeImage(file, max = 640) {
  const bmp = await createImageBitmap(file);
  const sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
}
async function saveCover(gid, blob) {
  if (CFG) Cloud.set('covers', gid, { data: await blobToData(blob) });
  else { await IDB.put(gid, blob); setCover(gid, blob); changed(); }
}
async function removeCover(gid) {
  if (CFG) Cloud.del('covers', gid); else { await IDB.del(gid); setCover(gid, null); changed(); }
}
function pickPhoto(gid) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = async () => { const f = inp.files[0]; if (!f) return; try { await saveCover(gid, await resizeImage(f)); toast('Cover gespeichert 📸'); } catch (e) { console.error(e); toast('Bild konnte nicht gelesen werden'); } };
  inp.click();
}

/* ---------- Lokal ---------- */
const Local = {
  async start() {
    let d = null; try { d = JSON.parse(localStorage.getItem(LS.local)); } catch (e) {}
    if (d) Object.assign(db, { games: d.games || {}, players: d.players || {}, plays: d.plays || {} });
    else { seedGames().forEach(g => db.games[g.id] = g); this.persist(); }
    try { const all = await IDB.all(); for (const [k, v] of Object.entries(all)) setCover(k, v); } catch (e) { console.warn('Keine Cover-Datenbank', e); }
  },
  persist() { localStorage.setItem(LS.local, JSON.stringify({ games: db.games, players: db.players, plays: db.plays })); changed(); },
  set(c, id, d) { db[c][id] = { ...clone(d), id }; this.persist(); },
  update(c, id, p) { if (db[c][id]) { applyPatch(db[c][id], p); this.persist(); } },
  del(c, id) { delete db[c][id]; this.persist(); },
};

/* ---------- Cloud (Firebase Firestore) ---------- */
const FB = 'https://www.gstatic.com/firebasejs/12.6.0/';
const Cloud = {
  async connect() {
    if (this.fs) return;
    const [A, Au, F] = await Promise.all([import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js'), import(FB + 'firebase-firestore.js')]);
    this.F = F;
    const app = A.initializeApp(CFG);
    const auth = Au.getAuth(app);
    const user = await new Promise(r => { const u = Au.onAuthStateChanged(auth, x => { u(); r(x); }); });
    if (!user) await Au.signInAnonymously(auth);
    this.fs = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  },
  ref(c, id) { return this.F.doc(this.fs, 'groups', this.code, c, id); },
  async exists(code) { await this.connect(); return (await this.F.getDoc(this.F.doc(this.fs, 'groups', code))).exists(); },
  async create(code) {
    await this.connect(); this.code = code;
    await this.F.setDoc(this.F.doc(this.fs, 'groups', code), { created: new Date().toISOString() });
    const list = seedGames();
    for (let i = 0; i < list.length; i += 400) {
      const b = this.F.writeBatch(this.fs);
      list.slice(i, i + 400).forEach(g => b.set(this.ref('games', g.id), g));
      await b.commit();
    }
  },
  async start(code) {
    await this.connect(); this.code = code;
    await Promise.all(['games', 'players', 'plays', 'covers'].map(c => new Promise(res => {
      let first = true;
      this.F.onSnapshot(this.F.collection(this.fs, 'groups', code, c), snap => {
        snap.docChanges().forEach(ch => {
          if (c === 'covers') { setCover(ch.doc.id, ch.type === 'removed' ? null : dataToBlob(ch.doc.data().data)); return; }
          if (ch.type === 'removed') delete db[c][ch.doc.id]; else db[c][ch.doc.id] = { ...ch.doc.data(), id: ch.doc.id };
        });
        if (first) { first = false; res(); }
        changed();
      }, err => { console.error(err); toast('Sync-Fehler: ' + err.code); res(); });
    })));
  },
  fail(e) { console.error(e); toast('Speichern fehlgeschlagen: ' + (e.code || e.message)); },
  set(c, id, d) { const x = clone(d); delete x.id; this.F.setDoc(this.ref(c, id), x).catch(this.fail); },
  update(c, id, p) {
    const args = [];
    for (const [k, v] of Object.entries(p)) args.push(new this.F.FieldPath(...k.split('.')), v === DEL ? this.F.deleteField() : clone(v));
    this.F.updateDoc(this.ref(c, id), ...args).catch(this.fail);
  },
  del(c, id) { this.F.deleteDoc(this.ref(c, id)).catch(this.fail); },
};
const store = CFG ? Cloud : Local;

/* ================= Helfer ================= */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const fmtDate = d => new Date(d + 'T12:00').toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtShort = d => new Date(d + 'T12:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
const monthName = d => new Date(d + 'T12:00').toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
const daysAgo = d => (Date.now() - new Date(d + 'T12:00')) / 864e5;
const hue = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const avatar = p => p ? `<span class="av" style="background:hsl(${hue(p.name)} 62% 52%)">${esc(p.name.trim()[0] || '?').toUpperCase()}</span>` : '<span class="av">?</span>';
const rColor = v => v == null ? 'var(--surface2)' : `hsl(${Math.round((Math.min(10, Math.max(1, v)) - 1) / 9 * 130)} 68% ${v >= 5 ? 42 : 50}%)`;
const num = v => (v === '' || v == null || isNaN(+v)) ? null : +v;
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const r1 = v => Math.round(v * 10) / 10;
const fR = v => v == null ? '–' : String(v).replace('.', ',');
const pname = pid => P(pid)?.name || '?';
const ICON = {
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  crown: '<svg viewBox="0 0 24 24"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  share: '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.9l7.6-4.3M8.2 13.1l7.6 4.3"/></svg>',
};
const initials = name => { const w = String(name || '?').replace(/[:–\-()]/g, ' ').split(/\s+/).filter(x => /[\p{L}\d]/u.test(x) && !/^(the|der|die|das|of|a)$/i.test(x)); return ((w[0] || '?')[0] + ((w[1] || '')[0] || '')).toUpperCase(); };
// eigenes Foto > selbst eingefügter Link > Cover aus der Sammlung (klein: Vorschaubild)
const coverSrc = (g, small = false) => g ? (coverURL[g.id] || (small && g.thumb) || g.img || null) : null;
const cover = (g, cls = '') => { const src = coverSrc(g, true);
  return src ? `<span class="cover img ${cls}" style="--h:${hue(g.name)};background-image:url('${esc(src)}')"></span>`
             : `<span class="cover ${cls}" style="--h:${hue(g?.name || '?')}">${esc(initials(g?.name))}</span>`; };
const rng = (a, b) => a == null ? null : (b == null || a === b ? `${a}` : `${a}–${b}`);
const weightWord = w => w == null ? '' : w < 1.8 ? 'leicht' : w < 2.6 ? 'eingängig' : w < 3.4 ? 'mittel' : w < 4.1 ? 'anspruchsvoll' : 'Brocken';
function facts(g, { long = false } = {}) {
  const f = [];
  if (g.minP != null) f.push(`👥 ${rng(g.minP, g.maxP)}`);
  if (g.time) f.push(`⏱ ${rng(g.time[0], g.time[1])} Min`);
  if (g.weight != null) f.push(long ? `🧠 ${fR(g.weight)}/5 · ${weightWord(g.weight)}` : `🧠 ${weightWord(g.weight)}`);
  if (long && g.year) f.push(`📅 ${g.year}`);
  return f;
}
const avMini = pid => { const p = P(pid); return p ? `<span class="av" style="background:hsl(${hue(p.name)} 62% 52%)">${esc(p.name.trim()[0].toUpperCase())}</span>` : ''; };
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2400); }
function keepFocus(fn) {
  const a = document.activeElement, id = a && a.id; let ss = null;
  try { ss = a.selectionStart; } catch (e) {}
  fn();
  if (id) { const n = document.getElementById(id); if (n && n !== a) { n.focus(); try { if (ss != null) n.setSelectionRange(ss, ss); } catch (e) {} } }
}

/* ---------- Partien & Bewertungen ---------- */
const sortPlays = arr => arr.slice().sort((a, b) => (b.date + (b.created || '')).localeCompare(a.date + (a.created || '')));
const playsOf = gid => plays().filter(p => p.gameId === gid);
const parts = play => Object.entries(play.p || {}).map(([pid, x]) => ({ pid, ...x })).sort((a, b) => (a.o ?? 0) - (b.o ?? 0));
const nOf = play => Object.keys(play.p || {}).length;
function winSet(play, rows = parts(play), manual = play.winManual) {
  if (manual) return new Set(rows.filter(x => x.win).map(x => x.pid));
  const sc = rows.filter(x => num(x.score) != null);
  if (!sc.length) return new Set();
  const vals = sc.map(x => num(x.score));
  const best = G(play.gameId)?.lowWins ? Math.min(...vals) : Math.max(...vals);
  return new Set(sc.filter(x => num(x.score) === best).map(x => x.pid));
}
function avgN(g, n) {
  const v = Object.values(g.ratings || {}).map(r => r && r[n]).filter(x => x != null);
  return v.length ? { v: r1(mean(v)), c: v.length } : null;
}
function ratedCounts(g) { const ok = new Set(possibleCounts(g)), s = new Set(); Object.values(g.ratings || {}).forEach(r => Object.keys(r || {}).forEach(n => ok.has(+n) && s.add(+n))); return [...s]; }
// Spielerzahlen, für die ein Spiel bewertet werden kann: laut Schachtel (min–max)
// plus Besetzungen, in denen ihr es tatsächlich gespielt habt (z. B. mit Erweiterung)
function possibleCounts(g, ps = playsOf(g.id)) {
  const s = new Set(ps.map(nOf));
  if (g.minP != null) for (let n = g.minP; n <= (g.maxP ?? g.minP); n++) s.add(n);
  else for (let n = 1; n <= 6; n++) s.add(n);
  return [...s].filter(n => n > 0).sort((a, b) => a - b);
}
function bestWith(g) {
  const e = ratedCounts(g).map(n => [n, avgN(g, n).v]);
  if (!e.length) return null;
  const max = Math.max(...e.map(x => x[1]));
  return { n: e.filter(x => x[1] === max).map(x => x[0]).sort((a, b) => a - b), v: max };
}
function gameScore(g) {
  const ov = Object.values(g.overall || {}).filter(x => x != null);
  if (ov.length) return r1(mean(ov));
  const ok = new Set(possibleCounts(g));
  const all = Object.values(g.ratings || {}).flatMap(r => Object.entries(r || {}).filter(([n]) => ok.has(+n)).map(([, v]) => v)).filter(x => x != null);
  return all.length ? r1(mean(all)) : null;
}
const myRating = (g, pid, n) => g?.ratings?.[pid]?.[n] ?? null;
function openForMe() {
  const m = me(); if (!m) return [];
  return sortPlays(plays()).filter(p => {
    const x = p.p?.[m]; if (!x || x.skip || daysAgo(p.date) > 21) return false;
    const othersScored = parts(p).some(y => y.pid !== m && y.score != null);
    return x.rating == null || (othersScored && x.score == null);
  });
}

/* ================= Sheets (mit Android-Zurück) ================= */
const stack = [];
function openSheet(render) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="back"></div><div class="sheet"><div class="grab"></div><div class="body"></div></div>`;
  $('#sheets').appendChild(wrap);
  const s = { wrap, body: $('.body', wrap) };
  stack.push(s);
  $('.back', wrap).onclick = () => closeSheet();
  history.pushState({ sheet: stack.length }, '');
  s.refresh = () => { const el = $('.sheet', wrap), sc = el.scrollTop; keepFocus(() => render(s)); el.scrollTop = sc; };
  render(s);
  return s;
}
function popSheets(keep) {
  if (stack.length <= keep) return;
  while (stack.length > keep) stack.pop().wrap.remove();
  rerender();
}
function closeSheet(n = 1) { n = Math.min(n, stack.length); if (!n) return; popSheets(stack.length - n); history.go(-n); }
window.addEventListener('popstate', () => popSheets((history.state && history.state.sheet) || 0));
const sheetHead = (title, extra = '') => `<div class="head"><h2>${title}</h2>${extra}<button class="iconbtn" data-close>${ICON.x}</button></div>`;
document.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(); });

/* ================= Tabs & Rendering ================= */
let tab = 'plays', ready = false, raf = 0;
const ui = { gq: '', gsort: 'az', pick: { who: null, guests: 0, time: 0, tags: new Set(), more: false } };
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  tab = b.dataset.tab;
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  render(); window.scrollTo(0, 0);
  const v = $('#view'); v.classList.add('anim'); clearTimeout(v._a); v._a = setTimeout(() => v.classList.remove('anim'), 600);
});
$('#fab').onclick = () => playForm();
function changed() { if (ready && !raf) raf = requestAnimationFrame(() => { raf = 0; rerender(); }); }
function rerender() { render(); stack.forEach(s => s.refresh()); }
function render() {
  if (!ready) return;
  document.body.classList.remove('setup');
  $('#title').textContent = { plays: 'Partien', games: 'Spiele', pick: 'Was spielen wir?', players: 'Spieler' }[tab];
  const hr = new Date().getHours(), gruss = hr < 11 ? 'Guten Morgen' : hr < 18 ? 'Hallo' : 'Guten Abend';
  $('#sub').textContent = tab === 'plays' ? `${gruss}, ${pname(me())} 👋` : tab === 'games' ? `${games().filter(g => g.type === 'base').length} Spiele im Regal` : tab === 'pick' ? 'Spieleabend planen 🎲' : `${players().length} Mitspieler`;
  $('#fab').classList.toggle('hide', tab === 'players' || tab === 'pick');
  keepFocus(() => { $('#view').innerHTML = tab === 'plays' ? viewPlays() : tab === 'games' ? viewGames() : tab === 'pick' ? viewPick() : viewPlayers(); });
  bindView();
}

/* ---------- Partien ---------- */
function playCard(p, showGame = true) {
  const g = G(p.gameId) || { name: 'Gelöschtes Spiel' };
  const rows = parts(p), wins = winSet(p);
  const hasScore = rows.some(x => x.score != null);
  const rs = rows.map(x => x.rating).filter(x => x != null);
  const avg = rs.length ? r1(mean(rs)) : null;
  rows.sort((a, b) => (wins.has(b.pid) - wins.has(a.pid)) || ((b.score ?? -1e9) - (a.score ?? -1e9)) * (G(p.gameId)?.lowWins ? -1 : 1));
  return `<div class="card tap" data-play="${p.id}">
    <div class="row">${showGame ? cover(g) : ''}<div class="grow"><div class="name ell">${showGame ? esc(g.name) : fmtDate(p.date)}</div>
      <div class="small muted">${showGame ? fmtDate(p.date) + ' · ' : ''}${rows.length} Spieler${p.duration ? ' · ' + p.duration + ' min' : ''}${rs.length ? ' · ' + rs.length + '× bewertet' : ''}</div></div>
      ${avg != null ? `<span class="rbadge" style="background:${rColor(avg)}">${fR(avg)}</span>` : ''}</div>
    <div class="pl">${rows.map(x => `<span class="${wins.has(x.pid) ? 'win' : ''}">${avMini(x.pid)}${wins.has(x.pid) ? '👑 ' : ''}${esc(pname(x.pid))}${hasScore && x.score != null ? ` <span class="score">${x.score}</span>` : ''}</span>`).join('')}</div>
  </div>`;
}
function viewPlays() {
  const open = openForMe();
  let html = open.length ? `<div class="sec">Für dich offen</div>${open.map(p => `<div class="card tap todo" data-mine="${p.id}"><div class="row">${cover(G(p.gameId), 'sm')}
      <div class="grow"><div class="name ell">${esc(G(p.gameId)?.name || '?')}</div><div class="small muted">${fmtDate(p.date)} · trag deine ${p.p[me()].rating == null ? 'Bewertung' : 'Punkte'} ein</div></div>
      <span class="chip on">Eintragen</span></div></div>`).join('')}` : '';
  if (!plays().length) return html + `<div class="empty"><div class="big">🎲</div><h3>Noch keine Partien</h3>
    <p>Tippe unten auf <b>+ Partie</b>, um eure erste Runde einzutragen.<br>${games().filter(g => g.type === 'base').length} Spiele aus der Sammlung sind schon drin.</p></div>`;
  const y = String(new Date().getFullYear());
  const m = me(), mine = m ? playerStats(m) : null;
  const top = Object.entries(plays().reduce((a, p) => (a[p.gameId] = (a[p.gameId] || 0) + 1, a), {})).sort((a, b) => b[1] - a[1])[0];
  html += `<div class="hero-card"><div class="lbl">Partien in ${y}</div><div class="big">${plays().filter(p => p.date.startsWith(y)).length}</div>
    <div class="mini"><div><b>${plays().length}</b><span>gesamt</span></div>
      <div><b>${mine ? mine.rate + '%' : '–'}</b><span>deine Siege</span></div>
      <div><b class="ell">${top ? esc(initials(G(top[0])?.name)) + ' · ' + top[1] + '×' : '–'}</b><span class="ell" style="display:block">${top ? esc(G(top[0])?.name || '') : 'Top-Spiel'}</span></div></div></div>`;
  let cur = '';
  for (const p of sortPlays(plays())) {
    const m = p.date.slice(0, 7);
    if (m !== cur) { cur = m; html += `<div class="sec">${monthName(p.date)}</div>`; }
    html += playCard(p);
  }
  return html;
}

/* ---------- Spiele ---------- */
function gameMeta(g) { const ps = playsOf(g.id); return { count: ps.length, last: ps.length ? sortPlays(ps)[0].date : null }; }
function viewGames() {
  const q = ui.gq.trim().toLowerCase();
  let list = games().filter(g => q ? (g.name.toLowerCase().includes(q) || (g.tags || []).some(t => t.toLowerCase().includes(q))) : (g.type === 'base' || !g.parent));
  const meta = new Map(list.map(g => [g.id, gameMeta(g)]));
  const s = ui.gsort, az = (a, b) => a.name.localeCompare(b.name, 'de');
  list.sort((a, b) => {
    const A = meta.get(a.id), B = meta.get(b.id);
    if (s === 'last') return (B.last || '').localeCompare(A.last || '') || az(a, b);
    if (s === 'most') return B.count - A.count || az(a, b);
    if (s === 'rate') return (gameScore(b) ?? -1) - (gameScore(a) ?? -1) || az(a, b);
    return az(a, b);
  });
  if (s === 'never') list = list.filter(g => meta.get(g.id).count === 0);
  const sorts = [['az', 'A–Z'], ['last', 'Zuletzt gespielt'], ['most', 'Meistgespielt'], ['rate', 'Beste Bewertung'], ['never', 'Nie gespielt']];
  let html = `<div class="search">${ICON.search}<input id="gq" placeholder="Spiel oder Kategorie suchen …" value="${esc(ui.gq)}" autocomplete="off"></div>
    <div class="chips">${sorts.map(([k, l]) => `<button class="chip ${s === k ? 'on' : ''}" data-sort="${k}">${l}</button>`).join('')}</div>
    <div class="small muted" style="margin:4px 4px 10px">${list.length} ${list.length === 1 ? 'Spiel' : 'Spiele'}</div>`;
  for (const g of list) {
    const m = meta.get(g.id), sc = gameScore(g), bw = bestWith(g);
    const exps = games().filter(x => x.parent === g.id).length;
    html += `<div class="card tap row" data-game="${g.id}">${cover(g)}<div class="grow">
      <div class="name ell">${esc(g.name)}</div>
      <div class="small muted ell">${facts(g).slice(0, 2).join('  ') || (g.type !== 'base' ? (g.type === 'exp' ? 'Erweiterung' : 'Zubehör') : '')}</div>
      <div class="small muted ell">${[m.count ? m.count + '× gespielt' : 'noch nie gespielt', m.last ? 'zuletzt ' + fmtShort(m.last) : '', exps ? '+' + exps + ' Erw.' : ''].filter(Boolean).join(' · ')}</div></div>
      ${sc != null ? `<div><span class="rbadge" style="background:${rColor(sc)};display:block">${fR(sc)}</span>${bw ? `<div class="best">am besten zu ${bw.n.join('/')}</div>` : ''}</div>` : ''}</div>`;
  }
  html += `<button class="btn" id="newGame" style="margin-top:14px">${ICON.plus} Spiel hinzufügen</button>`;
  return html;
}

/* ---------- Spieler ---------- */
function playerStats(pid) {
  const ps = plays().filter(p => p.p && p.p[pid]);
  const wins = ps.filter(p => winSet(p).has(pid)).length;
  return { n: ps.length, wins, rate: ps.length ? Math.round(wins / ps.length * 100) : 0, plays: ps };
}
function inviteLink() { return location.origin + location.pathname + '?g=' + Cloud.code; }
function viewPlayers() {
  const m = me();
  const list = players().map(p => ({ p, s: playerStats(p.id) })).sort((a, b) => b.s.n - a.s.n || a.p.name.localeCompare(b.p.name));
  const ms = m ? playerStats(m) : { n: 0, wins: 0 };
  let html = `<div class="me-card">${avatar(P(m))}<div class="grow"><div class="small" style="opacity:.85;font-weight:600">Du bist</div><div class="name" style="font-size:20px">${esc(pname(m))}</div>
    <div class="small" style="opacity:.85">${ms.n} Partien · ${ms.wins} Siege</div></div><button class="chip" id="switchMe">Wechseln</button></div>`;
  html += CFG ? `<div class="card"><div class="row"><div class="grow"><div class="small muted">Eure Gruppe</div><div class="name" style="letter-spacing:.12em">${esc(Cloud.code)}</div></div>
      <button class="chip on" id="invite">${'Einladen'}</button></div>
      <p class="small muted" style="margin:8px 0 0">Schick den Link an deine Mitspieler. Sie öffnen ihn, wählen ihren Namen – fertig. Alles wird live geteilt.</p></div>`
    : `<div class="card small muted">Nur auf diesem Gerät gespeichert. Mitspieler können hier reihum eintragen. Für eigene Handys: Cloud einrichten (siehe Anleitung).</div>`;
  html += `<div class="sec">Alle Spieler</div>` + list.map(({ p, s }) => `<div class="card tap row" data-player="${p.id}">${avatar(p)}
    <div class="grow"><div class="name">${esc(p.name)}${p.id === m ? ' <span class="tag acc">du</span>' : ''}</div><div class="small muted">${s.n} Partien · ${s.wins} Siege</div>
    ${s.n ? `<div class="bar"><i style="width:${s.rate}%"></i></div>` : ''}</div>
    ${s.n ? `<div class="score" style="font-size:18px">${s.rate}%</div>` : ''}</div>`).join('');
  html += `<button class="btn" id="addPlayer" style="margin-top:6px">${ICON.plus} Spieler hinzufügen</button>
    <div class="sec">Daten</div>
    <div class="card">${CFG ? '' : '<p class="small muted" style="margin:0 0 12px">Sichere deine Daten ab und zu – z. B. in Google Drive.</p>'}
    <button class="btn ${CFG ? '' : 'pri'}" id="exp">Backup speichern</button>
    ${CFG ? '' : '<button class="btn" id="imp">Backup laden</button><input type="file" id="impFile" accept=".json,application/json" hidden>'}</div>
    <p class="small muted" style="text-align:center;margin-top:18px">${games().length} Spiele · ${plays().length} Partien · ${players().length} Spieler</p>`;
  return html;
}
function addPlayer(name) {
  name = (name || '').trim(); if (!name) return null;
  const ex = players().find(x => x.name.toLowerCase() === name.toLowerCase());
  if (ex) return ex.id;
  const id = uid(); store.set('players', id, { name }); return id;
}

function bindView() {
  const v = $('#view');
  v.onclick = e => {
    const t = e.target.closest('[data-play],[data-mine],[data-game],[data-player],[data-sort],#newGame,#addPlayer,#exp,#imp,#switchMe,#invite,[data-who],[data-time],[data-tag],#gm,#gp,#rand,#more');
    if (!t) return;
    if (tab === 'pick' && pickClick(t)) return;
    if (t.dataset.play) playForm(t.dataset.play);
    else if (t.dataset.mine) myEntry(t.dataset.mine);
    else if (t.dataset.game) gameSheet(t.dataset.game, tab === 'pick' ? { pids: [...pickWho()] } : {});
    else if (t.dataset.player) playerSheet(t.dataset.player);
    else if (t.dataset.sort) { ui.gsort = t.dataset.sort; render(); }
    else if (t.id === 'newGame') gameEdit();
    else if (t.id === 'addPlayer') addPlayer(prompt('Name des Spielers'));
    else if (t.id === 'exp') exportData();
    else if (t.id === 'imp') $('#impFile').click();
    else if (t.id === 'switchMe') whoAmI();
    else if (t.id === 'invite') invite();
  };
  const gq = $('#gq'); if (gq) gq.oninput = () => { ui.gq = gq.value; render(); };
  const f = $('#impFile'); if (f) f.onchange = () => importData(f.files[0]);
}
async function invite() {
  const url = inviteLink(), text = `Komm in unsere Spielegruppe! Code: ${Cloud.code}`;
  if (navigator.share) { try { await navigator.share({ title: 'Spieletracker', text, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(url); toast('Link kopiert'); } catch (e) { prompt('Link kopieren:', url); }
}

/* ================= Bewertungsbalken ================= */
function rateRow(label, val, key, { big = false, avg = null } = {}) {
  return `<div class="rate ${big ? 'big' : ''}"><label class="ell">${label}</label><div class="seg" data-rate="${key}">
    ${Array.from({ length: 10 }, (_, i) => `<button data-v="${i + 1}" aria-label="${i + 1}" style="${val != null && i < val ? 'background:' + rColor(val) : ''}"></button>`).join('')}
    </div><span class="val">${val ?? '–'}</span>${avg !== null ? `<span class="avg">${avg ? 'Ø ' + fR(avg.v) + '<i>' + avg.c + '</i>' : ''}</span>` : ''}</div>`;
}
function bindRates(root, onSet) {
  root.querySelectorAll('.seg').forEach(seg => seg.onclick = e => {
    const b = e.target.closest('button'); if (b) onSet(seg.dataset.rate, +b.dataset.v);
  });
}

/* ================= Partie eintragen / bearbeiten ================= */
function playForm(playId, presetGame, presetPids) {
  const old = playId ? db.plays[playId] : null;
  const f = old
    ? { gameId: old.gameId, date: old.date, exp: [...(old.exp || [])], duration: old.duration ?? null, note: old.note || '', winManual: !!old.winManual,
        rows: parts(old).map(x => ({ pid: x.pid, score: x.score ?? '', win: !!x.win, rating: x.rating ?? null, rt: false, skip: !!x.skip })) }
    : { gameId: presetGame || null, date: today(), exp: [], duration: null, note: '', winManual: false, rows: [] };
  if (!old) (presetPids && presetPids.length ? presetPids : me() ? [me()] : []).forEach(pid => P(pid) && f.rows.push({ pid, score: '', win: false, rating: null, rt: false }));
  let q = '', picking = !f.gameId;
  const freq = {}; plays().forEach(p => Object.keys(p.p || {}).forEach(pid => freq[pid] = (freq[pid] || 0) + 1));
  const shownRating = (row, g, n) => row.rt ? row.rating : (row.rating ?? myRating(g, row.pid, n));

  openSheet(s => {
    const g = f.gameId && G(f.gameId);
    const n = f.rows.length;
    const recent = [...new Set(sortPlays(plays()).map(p => p.gameId))].map(G).filter(Boolean).slice(0, 8);
    const ql = q.trim().toLowerCase();
    const found = ql ? games().filter(x => x.name.toLowerCase().includes(ql)).sort((a, b) => (a.type !== 'base') - (b.type !== 'base') || a.name.localeCompare(b.name)).slice(0, 30)
      : recent.length ? recent : games().filter(x => x.type === 'base').sort((a, b) => a.name.localeCompare(b.name, 'de'));
    const exps = g ? games().filter(x => x.parent === g.id) : [];
    const pl = players().sort((a, b) => (b.id === me()) - (a.id === me()) || (freq[b.id] || 0) - (freq[a.id] || 0) || a.name.localeCompare(b.name));
    const wins = winSet({ gameId: f.gameId }, f.rows, f.winManual);

    s.body.innerHTML = sheetHead(old ? 'Partie bearbeiten' : 'Neue Partie') + `
      <div class="field"><span>Spiel</span>
        ${g && !picking ? `<div class="row">${cover(g, 'sm')}<div class="grow name">${esc(g.name)}</div><button class="chip" id="chg">Ändern</button></div>` :
        `<input id="q" placeholder="Spiel suchen …" value="${esc(q)}" autocomplete="off">
         ${!ql && recent.length ? '<div class="small muted" style="margin-top:6px">Zuletzt gespielt</div>' : ''}
         <div class="pick">${found.map(x => `<button data-g="${x.id}">${cover(x, 'sm')}<span class="grow">${esc(x.name)}</span>${x.type !== 'base' ? ' <span class="tag">' + (x.type === 'exp' ? 'Erweiterung' : 'Zubehör') + '</span>' : ''}</button>`).join('')}
         ${ql && !found.some(x => x.name.toLowerCase() === ql) ? `<button data-newg>＋ „${esc(q.trim())}“ als neues Spiel anlegen</button>` : ''}</div>`}
      </div>
      ${exps.length ? `<div class="field"><span>Mit Erweiterungen</span><div class="chips wrap" style="margin-top:6px">
        ${exps.map(x => `<button class="chip ${f.exp.includes(x.id) ? 'on' : ''}" data-exp="${x.id}">${esc(x.name.replace(g.name + ':', '').trim() || x.name)}</button>`).join('')}</div></div>` : ''}
      <div class="two"><label class="field"><span>Datum</span><input type="date" id="date" value="${f.date}"></label>
        <label class="field"><span>Dauer (Min.)</span><input type="number" inputmode="numeric" id="dur" placeholder="optional" value="${f.duration ?? ''}"></label></div>
      <div class="field"><span>Wer hat mitgespielt?</span>
        <div class="chips wrap" style="margin-top:6px">${pl.map(p => `<button class="chip ${f.rows.some(x => x.pid === p.id) ? 'on' : ''}" data-p="${p.id}">${esc(p.name)}</button>`).join('')}
        <button class="chip ghost" id="np">＋ Neu</button></div>
      </div>
      ${n ? `<div class="field"><span>Punkte & Sieger <span style="font-weight:500">(leer lassen geht auch – die anderen können ihre Punkte selbst eintragen)</span></span>
        ${f.rows.map((x, i) => `<div class="prow">${avatar(P(x.pid))}<div class="grow name ell">${esc(pname(x.pid))}</div>
          <input type="number" inputmode="decimal" placeholder="Punkte" id="sc-${x.pid}" data-sc="${i}" value="${x.score}">
          <button class="cr ${wins.has(x.pid) ? 'on' : ''}" data-win="${i}" aria-label="Sieger">${ICON.crown}</button></div>`).join('')}
      </div>` : ''}
      ${g && n ? `<div class="field"><span>Wie gut ist ${esc(g.name)} zu ${n}? – jeder bewertet selbst</span>
        ${f.rows.map((x, i) => rateRow(esc(pname(x.pid)), shownRating(x, g, n), i)).join('')}</div>` : ''}
      <label class="field"><span>Notiz</span><textarea id="note" rows="2" placeholder="optional">${esc(f.note)}</textarea></label>
      <button class="btn pri" id="save">Speichern</button>
      ${old ? '<button class="btn danger" id="del">Partie löschen</button>' : ''}`;
    bind(s);
  });

  function bind(s) {
    const b = s.body;
    const qi = $('#q', b);
    if (qi) { qi.oninput = () => { q = qi.value; s.refresh(); }; if (!f.gameId && !old && document.activeElement !== qi) setTimeout(() => qi.focus(), 300); }
    $('#date', b).onchange = e => f.date = e.target.value || today();
    $('#dur', b).oninput = e => f.duration = num(e.target.value);
    $('#note', b).oninput = e => f.note = e.target.value;
    b.querySelectorAll('[data-sc]').forEach(inp => inp.oninput = () => {
      f.rows[+inp.dataset.sc].score = inp.value;
      const w = winSet({ gameId: f.gameId }, f.rows, f.winManual);
      b.querySelectorAll('[data-win]').forEach(c => c.classList.toggle('on', w.has(f.rows[+c.dataset.win].pid)));
    });
    bindRates(b, (i, v) => {
      const row = f.rows[+i], g = G(f.gameId), cur = shownRating(row, g, f.rows.length);
      row.rating = cur === v ? null : v; row.rt = true; s.refresh();
    });
    b.onclick = e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.id === 'chg') { picking = true; q = ''; s.refresh(); setTimeout(() => $('#q', s.body)?.focus(), 50); }
      else if (t.dataset.g) { f.gameId = t.dataset.g; f.exp = []; picking = false; q = ''; s.refresh(); }
      else if ('newg' in t.dataset) { const id = uid(); store.set('games', id, { name: q.trim(), type: 'base', parent: null, loc: '', note: '', ratings: {}, overall: {}, lowWins: false }); f.gameId = id; picking = false; q = ''; s.refresh(); }
      else if (t.dataset.exp) { const i = f.exp.indexOf(t.dataset.exp); i < 0 ? f.exp.push(t.dataset.exp) : f.exp.splice(i, 1); s.refresh(); }
      else if (t.dataset.p) { togglePlayer(t.dataset.p); s.refresh(); }
      else if (t.id === 'np') { const id = addPlayer(prompt('Name des Spielers')); if (id && !f.rows.some(x => x.pid === id)) { f.rows.push({ pid: id, score: '', win: false, rating: null, rt: false }); } setTimeout(s.refresh, 50); }
      else if (t.dataset.win != null) {
        if (!f.winManual) { const w = winSet({ gameId: f.gameId }, f.rows, false); f.rows.forEach(x => x.win = w.has(x.pid)); f.winManual = true; }
        const x = f.rows[+t.dataset.win]; x.win = !x.win; s.refresh();
      }
      else if (t.id === 'save') doSave();
      else if (t.id === 'del') { if (confirm('Diese Partie wirklich löschen?')) { store.del('plays', old.id); closeSheet(); toast('Partie gelöscht'); } }
    };
  }
  function togglePlayer(pid) {
    const i = f.rows.findIndex(x => x.pid === pid);
    if (i < 0) f.rows.push({ pid, score: '', win: false, rating: null, rt: false }); else f.rows.splice(i, 1);
  }
  function doSave() {
    if (!f.gameId) return toast('Bitte ein Spiel wählen');
    if (!f.rows.length) return toast('Wer hat mitgespielt?');
    const g = G(f.gameId), n = f.rows.length;
    const entry = (x, i) => {
      const e = { o: i, score: num(x.score), win: !!x.win, rating: shownRating(x, g, n) };
      if (x.skip && e.rating == null) e.skip = true;
      return e;
    };
    const top = { gameId: f.gameId, date: f.date, exp: f.exp, duration: f.duration, note: f.note.trim(), winManual: f.winManual };
    if (!old) {
      const p = {}; f.rows.forEach((x, i) => p[x.pid] = entry(x, i));
      store.set('plays', uid(), { ...top, created: new Date().toISOString(), by: me(), p });
    } else {
      const patch = { ...top };
      f.rows.forEach((x, i) => patch['p.' + x.pid] = entry(x, i));
      Object.keys(old.p || {}).forEach(pid => { if (!f.rows.some(x => x.pid === pid)) patch['p.' + pid] = DEL; });
      store.update('plays', old.id, patch);
    }
    // persönliche Bewertung je Spielerzahl am Spiel merken
    const gp = {};
    f.rows.forEach(x => { if (x.rt) gp[`ratings.${x.pid}.${n}`] = x.rating == null ? DEL : x.rating; });
    if (Object.keys(gp).length) store.update('games', g.id, gp);
    closeSheet(); toast(old ? 'Gespeichert' : 'Partie eingetragen 🎉');
  }
}

/* ---------- Schnell-Eintrag: eigene Punkte & Bewertung ---------- */
function myEntry(playId) {
  const m = me();
  let score = null, rating = null, init = false;
  openSheet(s => {
    const p = db.plays[playId]; if (!p || !p.p?.[m]) { s.body.innerHTML = sheetHead('Nicht mehr verfügbar'); return; }
    const g = G(p.gameId), n = nOf(p), mine = p.p[m];
    if (!init) { init = true; score = mine.score ?? ''; rating = mine.rating ?? myRating(g, m, n); }
    const others = parts(p).filter(x => x.pid !== m);
    s.body.innerHTML = sheetHead(esc(g?.name || '?')) + `
      <p class="muted" style="margin:0 4px 12px">${fmtDate(p.date)} · ${n} Spieler · mit ${others.map(x => esc(pname(x.pid))).join(', ') || 'niemandem'}</p>
      ${others.some(x => x.score != null) ? `<div class="card small">${others.map(x => `<div class="row" style="padding:3px 0"><span class="grow">${esc(pname(x.pid))}</span><span class="score">${x.score ?? '–'}</span></div>`).join('')}</div>` : ''}
      <label class="field"><span>Deine Punkte</span><input type="number" inputmode="decimal" id="ms" placeholder="z. B. 87" value="${score ?? ''}"></label>
      <div class="field"><span>Wie gut ist ${esc(g?.name || 'das Spiel')} zu ${n}?</span>${rateRow('Du', rating, 'me', { big: true })}</div>
      <button class="btn pri" id="sv">Speichern</button>
      <button class="btn" id="skip">Nicht bewerten</button>`;
    $('#ms', s.body).oninput = e => score = e.target.value;
    bindRates(s.body, (k, v) => { rating = rating === v ? null : v; s.refresh(); });
    $('#sv', s.body).onclick = () => {
      store.update('plays', playId, { [`p.${m}.score`]: num(score), [`p.${m}.rating`]: rating, [`p.${m}.skip`]: DEL });
      if (g) store.update('games', g.id, { [`ratings.${m}.${n}`]: rating == null ? DEL : rating });
      closeSheet(); toast('Danke! 🎲');
    };
    $('#skip', s.body).onclick = () => { store.update('plays', playId, { [`p.${m}.skip`]: true, [`p.${m}.score`]: num(score) }); closeSheet(); };
  });
}

/* ================= Spiel-Detail ================= */
function gameSheet(gid, { pids = null } = {}) {
  let rp = me(), more = false;
  openSheet(s => {
    const g = G(gid);
    if (!g) { s.body.innerHTML = sheetHead('Spiel gelöscht'); return; }
    const ps = sortPlays(playsOf(g.id));
    const parent = g.parent && G(g.parent);
    const exps = games().filter(x => x.parent === g.id);
    const counts = possibleCounts(g, ps);
    const bw = bestWith(g);
    const scores = ps.flatMap(p => parts(p).filter(x => x.score != null).map(x => ({ ...x, date: p.date })));
    const top = scores.length ? scores.reduce((a, b) => (g.lowWins ? b.score < a.score : b.score > a.score) ? b : a) : null;
    const avg = scores.length ? Math.round(mean(scores.map(x => x.score))) : null;
    const durs = ps.map(p => p.duration).filter(Boolean);
    const winC = {}; ps.forEach(p => winSet(p).forEach(pid => winC[pid] = (winC[pid] || 0) + 1));
    const winList = Object.entries(winC).sort((a, b) => b[1] - a[1]);
    const countN = {}; ps.forEach(p => countN[nOf(p)] = (countN[nOf(p)] || 0) + 1);
    // Wer kann hier bewerten: du zuerst, dann wer das Spiel gespielt/bewertet hat, dann der Rest
    const involved = new Set([...ps.flatMap(p => Object.keys(p.p || {})), ...Object.keys(g.ratings || {}), ...Object.keys(g.overall || {})]);
    const raters = players().sort((a, b) => (b.id === me()) - (a.id === me()) || involved.has(b.id) - involved.has(a.id) || a.name.localeCompare(b.name));
    if (!rp || !P(rp)) rp = raters[0]?.id;
    const ov = Object.values(g.overall || {}).filter(x => x != null);

    const gs = gameScore(g), src = coverSrc(g);
    s.body.innerHTML = sheetHead('', `<button class="iconbtn" id="edit">${ICON.edit}</button>`) + `
      <div class="banner ${src ? 'has-img' : ''}" style="--h:${hue(g.name)}" data-ini="${esc(initials(g.name))}">
        ${src ? `<div class="banner-bg" style="background-image:url('${esc(src)}')"></div>` : ''}
        <div class="row" style="align-items:flex-end;gap:14px">
          <button class="banner-cover" id="photo" style="${src ? `background-image:url('${esc(src)}')` : ''}" aria-label="Cover ändern">${src ? '' : '<span>📷</span><small>Cover</small>'}</button>
          <div class="grow"><h2 style="margin:0 0 6px;font-size:24px;letter-spacing:-.03em;line-height:1.15">${esc(g.name)}</h2>
            ${gs != null ? `<div class="row" style="gap:8px"><span class="score-big">${fR(gs)}</span><span class="score-lbl">von 10${bw ? `<br>★ am besten zu ${bw.n.join('/')}` : ''}</span></div>` : '<div class="score-lbl">noch nicht bewertet</div>'}</div>
        </div>
      <div class="chips wrap" style="padding:0;margin:0">
        ${g.type !== 'base' ? `<span class="tag acc">${g.type === 'exp' ? 'Erweiterung' : 'Zubehör'}</span>` : ''}
        ${parent ? `<span class="tag">zu ${esc(parent.name)}</span>` : ''}
        ${g.loc ? `<span class="tag">📍 ${esc(g.loc)}</span>` : ''}
        ${g.lowWins ? '<span class="tag">wenig Punkte gewinnt</span>' : ''}
        <span class="tag">${ps.length}× gespielt</span>
      </div></div>
      ${facts(g, { long: true }).length || g.desc || (g.tags || []).length ? `<div class="card info">
        ${facts(g, { long: true }).length ? `<div class="facts">${facts(g, { long: true }).map(x => `<span>${x}</span>`).join('')}</div>` : ''}
        ${g.desc ? `<p class="desc ${more ? '' : 'clamp'}" id="desc">${esc(g.desc)}</p>` : ''}
        ${(g.tags || []).length ? `<div class="chips wrap" style="padding:0;margin-top:8px">${g.tags.map(t => `<span class="tag acc">${esc(t)}</span>`).join('')}</div>` : ''}
      </div>` : `<button class="btn" id="edit2" style="margin-bottom:12px">✏️ Beschreibung & Infos ergänzen</button>`}
      ${g.note ? `<p class="small muted" style="margin:0 4px 10px">📝 ${esc(g.note)}</p>` : ''}
      <button class="btn pri" id="play">${ICON.plus} ${pids ? 'Los geht’s – Partie starten' : 'Partie eintragen'}</button>
      <div class="sec">Bewertung</div>
      <div class="card">
        <div class="small muted" style="margin-bottom:6px">Bewertung von</div>
        <div class="chips" style="margin-bottom:6px">${raters.map(p => `<button class="chip ${p.id === rp ? 'on' : ''}" data-rp="${p.id}">${esc(p.name)}</button>`).join('')}</div>
        ${rateRow('Gesamt', g.overall?.[rp] ?? null, 'overall', { big: true, avg: ov.length ? { v: r1(mean(ov)), c: ov.length } : false })}
        <div style="height:1px;background:var(--line);margin:6px 0"></div>
        ${g.minP == null ? '<p class="small muted" style="margin:4px 0">Spielerzahl unbekannt – trag sie über den Stift oben ein, dann erscheinen nur die passenden Zeilen.</p>' : ''}
        ${counts.map(n => rateRow(`${n} Spieler${countN[n] ? ` <span class="muted" style="font-weight:500">·${countN[n]}</span>` : ''}`, myRating(g, rp, n), n, { avg: avgN(g, n) || false })).join('')}
        <p class="small muted" style="margin:8px 0 0">Balken = Note von <b>${esc(pname(rp))}</b> (1–10, nochmal tippen entfernt sie). Ø = Schnitt aller, kleine Zahl = wie viele bewertet haben. ·N = so oft in der Besetzung gespielt.</p>
      </div>
      ${ps.length ? `<div class="sec">Statistik</div>
      <div class="stats"><div class="stat"><b>${ps.length}</b><span>Partien</span></div>
        <div class="stat"><b>${fmtShort(ps[0].date)}</b><span>zuletzt</span></div>
        <div class="stat"><b>${durs.length ? Math.round(mean(durs)) + '′' : '–'}</b><span>Ø Dauer</span></div>
        ${top ? `<div class="stat" style="grid-column:span 2"><b>${top.score} <span class="small muted">${esc(pname(top.pid))}</span></b><span>Rekord · ${fmtShort(top.date)}</span></div>
        <div class="stat"><b>${avg}</b><span>Ø Punkte</span></div>` : ''}
      </div>
      ${winList.length ? `<div class="card list">${winList.map(([pid, c]) => `<div class="li">${avatar(P(pid))}<div class="grow name">${esc(pname(pid))}</div><span class="score">${c} ${c === 1 ? 'Sieg' : 'Siege'}</span></div>`).join('')}</div>` : ''}` : ''}
      ${exps.length ? `<div class="sec">Erweiterungen & Zubehör</div><div class="card list">${exps.map(x => `<div class="li tap" data-gg="${x.id}"><div class="grow"><div class="name ell">${esc(x.name)}</div>${x.loc ? `<div class="small muted">${esc(x.loc)}</div>` : ''}</div>${gameScore(x) != null ? `<span class="rbadge" style="background:${rColor(gameScore(x))}">${fR(gameScore(x))}</span>` : ''}</div>`).join('')}</div>` : ''}
      ${ps.length ? `<div class="sec">Partien</div>${ps.map(p => playCard(p, false)).join('')}` : ''}`;

    bindRates(s.body, (k, v) => {
      if (!rp) return toast('Lege erst einen Spieler an');
      const path = k === 'overall' ? `overall.${rp}` : `ratings.${rp}.${k}`;
      const cur = k === 'overall' ? g.overall?.[rp] : myRating(g, rp, k);
      store.update('games', g.id, { [path]: cur === v ? DEL : v });
    });
    s.body.onclick = e => {
      const t = e.target.closest('#play,#edit,#edit2,#photo,#desc,[data-play],[data-gg],[data-rp]'); if (!t) return;
      if (t.id === 'play') playForm(null, g.id, pids);
      else if (t.id === 'edit' || t.id === 'edit2') gameEdit(g.id);
      else if (t.id === 'photo') coverMenu(g.id);
      else if (t.id === 'desc') { more = !more; s.refresh(); }
      else if (t.dataset.play) playForm(t.dataset.play);
      else if (t.dataset.gg) gameSheet(t.dataset.gg);
      else if (t.dataset.rp) { rp = t.dataset.rp; s.refresh(); }
    };
  });
}

function gameEdit(gid) {
  const g = gid ? G(gid) : null;
  openSheet(s => {
    if (s.body.childElementCount) return; // Formular nicht bei Live-Updates überschreiben
    const bases = games().filter(x => x.type === 'base' && x.id !== gid).sort((a, b) => a.name.localeCompare(b.name));
    s.body.innerHTML = sheetHead(g ? 'Spiel bearbeiten' : 'Neues Spiel') + `
      <label class="field"><span>Name</span><input id="n" value="${esc(g?.name || '')}"></label>
      <label class="field"><span>Art</span><select id="t">
        ${[['base', 'Grundspiel'], ['exp', 'Erweiterung'], ['acc', 'Zubehör']].map(([k, l]) => `<option value="${k}" ${(g?.type || 'base') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field" id="pf"><span>Gehört zu</span><select id="p"><option value="">–</option>
        ${bases.map(b => `<option value="${b.id}" ${g?.parent === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Beschreibung</span><textarea id="d" rows="3" placeholder="Worum geht es?">${esc(g?.desc || '')}</textarea></label>
      <div class="two"><label class="field"><span>Spieler von</span><input type="number" inputmode="numeric" id="mi" value="${g?.minP ?? ''}"></label>
        <label class="field"><span>bis</span><input type="number" inputmode="numeric" id="ma" value="${g?.maxP ?? ''}"></label></div>
      <div class="two"><label class="field"><span>Dauer von (Min.)</span><input type="number" inputmode="numeric" id="t0" value="${g?.time?.[0] ?? ''}"></label>
        <label class="field"><span>bis (Min.)</span><input type="number" inputmode="numeric" id="t1" value="${g?.time?.[1] ?? ''}"></label></div>
      <div class="two"><label class="field"><span>Komplexität (1–5)</span><input type="number" inputmode="decimal" step="0.1" min="1" max="5" id="w" value="${g?.weight ?? ''}"></label>
        <label class="field"><span>Erscheinungsjahr</span><input type="number" inputmode="numeric" id="y" value="${g?.year ?? ''}"></label></div>
      <label class="field"><span>Kategorien (mit Komma getrennt)</span><input id="tg" value="${esc((g?.tags || []).join(', '))}" placeholder="z. B. Strategie, Koop"></label>
      <label class="field"><span>Cover-Bild als Link (optional)</span><input id="im" type="url" value="${esc(g?.img || '')}" placeholder="https://…"></label>
      <label class="field"><span>Standort</span><input id="l" value="${esc(g?.loc || '')}" placeholder="z. B. Regal 1"></label>
      <label class="field row" style="cursor:pointer"><input type="checkbox" id="lw" style="width:22px;height:22px" ${g?.lowWins ? 'checked' : ''}><b class="grow">Wenig Punkte gewinnt</b></label>
      <label class="field"><span>Anmerkung</span><textarea id="a" rows="2">${esc(g?.note || '')}</textarea></label>
      <button class="btn pri" id="sv">Speichern</button>
      ${g ? '<button class="btn danger" id="dl">Spiel löschen</button>' : ''}`;
    const upd = () => $('#pf', s.body).style.display = $('#t', s.body).value === 'base' ? 'none' : '';
    $('#t', s.body).onchange = upd; upd();
    $('#sv', s.body).onclick = () => {
      const name = $('#n', s.body).value.trim(); if (!name) return toast('Bitte einen Namen eingeben');
      const type = $('#t', s.body).value;
      const v = id => $('#' + id, s.body).value.trim(), n = id => num(v(id));
      const t0 = n('t0'), t1 = n('t1');
      const rec = { name, type, parent: type === 'base' ? null : ($('#p', s.body).value || null), loc: v('l'), note: v('a'), lowWins: $('#lw', s.body).checked,
        desc: v('d'), minP: n('mi'), maxP: n('ma') ?? n('mi'), time: t0 == null && t1 == null ? null : [t0 ?? t1, t1 ?? t0], weight: n('w'), year: n('y'),
        tags: v('tg').split(',').map(x => x.trim()).filter(Boolean), img: v('im') || null, thumb: v('im') === (g?.img || '') ? (g?.thumb ?? null) : null, infoV: INFO_V };
      if (g) store.update('games', g.id, rec); else store.set('games', uid(), { ...rec, ratings: {}, overall: {} });
      closeSheet(); toast('Gespeichert');
    };
    const dl = $('#dl', s.body);
    if (dl) dl.onclick = () => {
      const ps = playsOf(g.id);
      if (!confirm(ps.length ? `${g.name} und ${ps.length} Partien löschen?` : `${g.name} löschen?`)) return;
      ps.forEach(p => store.del('plays', p.id));
      games().filter(x => x.parent === g.id).forEach(x => store.update('games', x.id, { parent: null }));
      store.del('games', g.id);
      closeSheet(2); toast('Spiel gelöscht');
    };
  });
}

function coverMenu(gid) {
  const g = G(gid);
  openSheet(s => {
    const src = coverSrc(g);
    s.body.innerHTML = sheetHead('Cover') + `
      ${src ? `<div class="cover-preview" style="background-image:url('${esc(src)}')"></div>` : `<p class="muted" style="margin:0 4px 14px">Fotografiere die Schachtel – oder nimm ein Bild aus deiner Galerie.</p>`}
      <button class="btn pri" id="cp">📷 Foto aufnehmen / auswählen</button>
      <button class="btn" id="cs">🔎 Cover bei BoardGameGeek suchen</button>
      <button class="btn" id="cu">🔗 Bild-Link einfügen</button>
      <p class="small muted" style="margin:10px 4px 0">Tipp: Bei BoardGameGeek das Spiel öffnen, auf das Cover tippen, Bild lange drücken → „Bildadresse kopieren“ und hier bei „Bild-Link einfügen“ einsetzen.</p>
      ${coverURL[gid] || g.img ? '<button class="btn danger" id="cd">Cover entfernen</button>' : ''}`;
    $('#cp', s.body).onclick = () => { closeSheet(); pickPhoto(gid); };
    $('#cs', s.body).onclick = () => window.open(g.bgg ? `https://boardgamegeek.com/boardgame/${g.bgg}` : `https://boardgamegeek.com/geeksearch.php?action=search&objecttype=boardgame&q=${encodeURIComponent(g.name)}`, '_blank');
    $('#cu', s.body).onclick = () => { const u = prompt('Link zum Bild (z. B. von BoardGameGeek: Bild lange drücken → „Bildadresse kopieren“)', g.img || ''); if (u != null) { store.update('games', gid, { img: u.trim() || null, thumb: null }); closeSheet(); } };
    const cd = $('#cd', s.body); if (cd) cd.onclick = async () => { if (coverURL[gid]) await removeCover(gid); if (g.img) store.update('games', gid, { img: null, thumb: null }); closeSheet(); };
  });
}

/* ---------- Was spielen wir? ---------- */
function pickWho() { const pk = ui.pick; if (!pk.who) pk.who = new Set(me() ? [me()] : []); return pk.who; }
function pickResults() {
  const pk = ui.pick, who = [...pickWho()], n = who.length + pk.guests;
  const freqTags = {};
  const pool = games().filter(g => g.type === 'base' || !g.parent);
  pool.forEach(g => (g.tags || []).forEach(t => freqTags[t] = (freqTags[t] || 0) + 1));
  const list = pool.filter(g =>
    n > 0 && (g.minP == null || (g.minP <= n && n <= (g.maxP ?? g.minP))) &&
    (!pk.time || !g.time || g.time[0] <= pk.time) &&
    (!pk.tags.size || (g.tags || []).some(t => pk.tags.has(t)))
  ).map(g => {
    const own = who.map(pid => myRating(g, pid, n)).filter(x => x != null);
    let score = null, why = '';
    if (own.length) { score = r1(mean(own)); why = `Ø ${fR(score)} von euch zu ${n}`; }
    else if (avgN(g, n)) { score = avgN(g, n).v; why = `Ø ${fR(score)} zu ${n}`; }
    else if (gameScore(g) != null) { score = gameScore(g); why = `Ø ${fR(score)} gesamt`; }
    const m = gameMeta(g);
    return { g, score, why, m, fit: g.minP == null ? 0 : 1 };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.fit - a.fit || (a.m.last || '').localeCompare(b.m.last || '') || a.g.name.localeCompare(b.g.name));
  const tags = Object.entries(freqTags).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  return { list, n, tags };
}
function viewPick() {
  const pk = ui.pick, who = pickWho(), { list, n, tags } = pickResults();
  const times = [[0, 'Egal'], [30, '≤ 30 Min'], [60, '≤ 1 Std'], [90, '≤ 1,5 Std'], [120, '≤ 2 Std'], [180, '≤ 3 Std']];
  const shown = pk.more ? list : list.slice(0, 20);
  let html = `<div class="card">
      <div class="pick-h">Wer ist dabei?</div>
      <div class="chips wrap">${players().sort((a, b) => (b.id === me()) - (a.id === me()) || a.name.localeCompare(b.name)).map(p => `<button class="chip ${who.has(p.id) ? 'on' : ''}" data-who="${p.id}">${esc(p.name)}</button>`).join('')}</div>
      <div class="row" style="margin-top:4px"><span class="grow small muted">+ Gäste ohne Profil</span>
        <button class="iconbtn" id="gm">–</button><b style="width:26px;text-align:center">${pk.guests}</b><button class="iconbtn" id="gp">+</button></div>
    </div>
    <div class="card">
      <div class="pick-h">Wie viel Zeit habt ihr?</div>
      <div class="chips">${times.map(([v, l]) => `<button class="chip ${pk.time === v ? 'on' : ''}" data-time="${v}">${l}</button>`).join('')}</div>
      ${tags.length ? `<div class="pick-h" style="margin-top:8px">Worauf habt ihr Lust?</div>
      <div class="chips">${tags.map(t => `<button class="chip ${pk.tags.has(t) ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
    </div>
    <div class="pick-sum"><div><b>${n ? list.length : 0}</b> ${list.length === 1 ? 'Spiel passt' : 'Spiele passen'}<br><span class="small muted">für ${n} ${n === 1 ? 'Person' : 'Personen'}</span></div>
      ${list.length ? '<button class="btn pri" id="rand" style="width:auto;padding:13px 18px">🎲 Zufall</button>' : ''}</div>`;
  if (!n) html += `<div class="empty"><p>Wähle aus, wer mitspielt.</p></div>`;
  html += shown.map(({ g, score, why, m }) => `<div class="pcard tap" data-game="${g.id}">
      ${coverSrc(g) ? `<div class="pc-img" style="background-image:url('${esc(coverSrc(g))}')"></div>` : `<div class="pc-img grad" style="--h:${hue(g.name)}"><span>${esc(initials(g.name))}</span></div>`}
      <div class="pc-body">
        <div class="row" style="align-items:flex-start;gap:8px"><div class="grow name" style="line-height:1.2">${esc(g.name)}</div>
          ${score != null ? `<span class="rbadge sm" style="background:${rColor(score)}">${fR(score)}</span>` : ''}</div>
        <div class="small muted" style="margin:3px 0 5px">${facts(g).join('  ')}</div>
        ${g.desc ? `<div class="small clamp2">${esc(g.desc)}</div>` : ''}
        <div class="pc-meta">${why ? `<span class="tag acc">${why}</span>` : '<span class="tag">noch unbewertet</span>'}<span class="tag">${m.count ? 'zuletzt ' + fmtShort(m.last) : '✨ noch nie gespielt'}</span></div>
      </div></div>`).join('');
  if (!pk.more && list.length > shown.length) html += `<button class="btn" id="more">Alle ${list.length} anzeigen</button>`;
  return html;
}
function pickClick(t) {
  const pk = ui.pick;
  if (t.dataset.who) { const w = pickWho(); w.has(t.dataset.who) ? w.delete(t.dataset.who) : w.add(t.dataset.who); }
  else if (t.dataset.time != null) pk.time = +t.dataset.time;
  else if (t.dataset.tag != null) pk.tags.has(t.dataset.tag) ? pk.tags.delete(t.dataset.tag) : pk.tags.add(t.dataset.tag);
  else if (t.id === 'gm') pk.guests = Math.max(0, pk.guests - 1);
  else if (t.id === 'gp') pk.guests = Math.min(12, pk.guests + 1);
  else if (t.id === 'more') pk.more = true;
  else if (t.id === 'rand') {
    const { list } = pickResults(); const top = list.slice(0, Math.min(8, list.length));
    const weights = top.map(x => Math.max(1, (x.score ?? 5) - 3) ** 2); let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    const hit = top.find((x, i) => (r -= weights[i]) < 0) || top[0];
    toast(`🎲 Wie wär’s mit ${hit.g.name}?`); gameSheet(hit.g.id, { pids: [...pickWho()] }); return true;
  }
  else return false;
  render(); return true;
}

/* ================= Spieler-Detail ================= */
function playerSheet(pid) {
  openSheet(s => {
    const p = P(pid); if (!p) { s.body.innerHTML = sheetHead('Gelöscht'); return; }
    const st = playerStats(pid);
    const per = {};
    st.plays.forEach(pl => { const e = per[pl.gameId] ||= { n: 0, w: 0, best: null }; e.n++; const x = pl.p[pid]; if (winSet(pl).has(pid)) e.w++; if (x.score != null && (e.best == null || x.score > e.best)) e.best = x.score; });
    const rows = Object.entries(per).sort((a, b) => b[1].n - a[1].n);
    const favs = games().map(g => { const own = [g.overall?.[pid], ...Object.values(g.ratings?.[pid] || {})].filter(x => x != null); return own.length ? { g, v: g.overall?.[pid] ?? Math.max(...own) } : null; })
      .filter(Boolean).sort((a, b) => b.v - a.v).slice(0, 5);
    s.body.innerHTML = sheetHead(esc(p.name), `<button class="iconbtn" id="ren">${ICON.edit}</button>`) + `
      <div class="stats"><div class="stat"><b>${st.n}</b><span>Partien</span></div><div class="stat"><b>${st.wins}</b><span>Siege</span></div><div class="stat"><b>${st.rate}%</b><span>Siegquote</span></div></div>
      ${favs.length ? `<div class="sec">Lieblingsspiele</div><div class="card list">${favs.map(x => `<div class="li"><div class="grow name ell">${esc(x.g.name)}</div><span class="rbadge" style="background:${rColor(x.v)}">${x.v}</span></div>`).join('')}</div>` : ''}
      ${rows.length ? `<div class="sec">Nach Spiel</div><div class="card list">${rows.map(([gid, e]) => `<div class="li"><div class="grow"><div class="name ell">${esc(G(gid)?.name || '?')}</div>
        <div class="small muted">${e.n}× gespielt · ${e.w} ${e.w === 1 ? 'Sieg' : 'Siege'}${e.best != null ? ' · Bestwert ' + e.best : ''}</div></div></div>`).join('')}</div>` : '<p class="muted" style="text-align:center">Noch keine Partien.</p>'}
      <button class="btn danger" id="dl" style="margin-top:10px">Spieler löschen</button>`;
    $('#ren', s.body).onclick = () => { const n = prompt('Neuer Name', p.name); if (n && n.trim()) store.update('players', pid, { name: n.trim() }); };
    $('#dl', s.body).onclick = () => {
      if (st.n) return alert(`${p.name} steckt in ${st.n} Partien und kann nicht gelöscht werden. Umbenennen geht aber.`);
      if (confirm(p.name + ' löschen?')) { store.del('players', pid); closeSheet(); }
    };
  });
}

/* ================= Start: Gruppe & „Wer bist du?“ ================= */
function setupScreen(html) {
  document.body.classList.add('setup');
  $('#title').textContent = 'Spieletracker';
  $('#view').innerHTML = html;
}
function groupSetup(prefill) {
  setupScreen(`<div class="hero"><div class="big">🎲</div><h2>Willkommen!</h2><p class="muted">Tracke eure Partien und bewertet eure Spiele – jeder auf seinem eigenen Handy.</p></div>
    <div class="card"><div class="name">Einer Gruppe beitreten</div><p class="small muted" style="margin:2px 0 10px">Code von deinen Mitspielern eingeben oder einfach ihren Einladungslink öffnen.</p>
      <div class="row"><input id="code" class="codein" maxlength="6" placeholder="CODE" value="${esc(prefill || '')}" autocomplete="off" autocapitalize="characters"><button class="btn pri" id="join" style="width:auto;padding:14px 20px">Beitreten</button></div></div>
    <div class="sec" style="text-align:center">oder</div>
    <button class="btn" id="create">Neue Gruppe gründen</button>
    <p class="small muted" style="text-align:center;margin-top:10px">Eine neue Gruppe startet mit deiner Spielesammlung (${SEED.length} Einträge).</p>`);
  const busy = (on) => document.querySelectorAll('#view button').forEach(b => b.disabled = on);
  $('#join').onclick = async () => {
    const code = $('#code').value.trim().toUpperCase(); if (code.length < 4) return toast('Bitte den Code eingeben');
    busy(true);
    try { if (!(await Cloud.exists(code))) { toast('Diese Gruppe gibt es nicht'); busy(false); return; } await enterGroup(code); }
    catch (e) { console.error(e); toast('Keine Verbindung – bist du online?'); busy(false); }
  };
  $('#create').onclick = async () => {
    busy(true);
    try {
      const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code;
      do { code = Array.from(crypto.getRandomValues(new Uint8Array(6)), b => abc[b % abc.length]).join(''); } while (await Cloud.exists(code));
      await Cloud.create(code); await enterGroup(code);
    } catch (e) { console.error(e); toast('Fehler: ' + (e.code || e.message)); busy(false); }
  };
}
async function enterGroup(code) {
  localStorage.setItem(LS.group, code);
  history.replaceState(null, '', location.pathname);
  await Cloud.start(code);
  me() ? (ready = true, render()) : whoAmI();
}
function whoAmI() {
  ready = false;
  const draw = () => setupScreen(`<div class="hero"><div class="big">👋</div><h2>Wer bist du?</h2><p class="muted">Damit deine Punkte und Bewertungen dir zugeordnet werden.</p></div>
    ${players().length ? `<div class="chips wrap whochips" style="justify-content:center;margin-bottom:16px">${players().sort((a, b) => a.name.localeCompare(b.name)).map(p => `<button class="chip" data-who="${p.id}">${esc(p.name)}</button>`).join('')}</div>
    <div class="sec" style="text-align:center">Nicht dabei?</div>` : ''}
    <div class="card row"><input id="newName" class="codein" style="letter-spacing:0;text-transform:none;text-align:left" placeholder="Dein Name" autocomplete="given-name"><button class="btn pri" id="go" style="width:auto;padding:14px 20px">Los</button></div>`);
  draw();
  const done = pid => { localStorage.setItem(LS.me, pid); ready = true; tab = 'plays'; render(); };
  $('#view').onclick = e => {
    const t = e.target.closest('[data-who],#go'); if (!t) return;
    if (t.dataset.who) done(t.dataset.who);
    else { const name = $('#newName').value.trim(); if (!name) return toast('Bitte deinen Namen eingeben'); done(addPlayer(name)); }
  };
}
async function boot() {
  const urlG = (new URLSearchParams(location.search).get('g') || '').toUpperCase();
  if (CFG) {
    const g = localStorage.getItem(LS.group);
    if (!g || (urlG && urlG !== g)) {
      if (g && urlG && !confirm(`Zur Gruppe ${urlG} wechseln? (Bisher: ${g})`)) { history.replaceState(null, '', location.pathname); }
      else { if (urlG) { try { if (await Cloud.exists(urlG)) return enterGroup(urlG); } catch (e) {} } return groupSetup(urlG); }
    }
    try { await Cloud.start(localStorage.getItem(LS.group)); }
    catch (e) { console.error(e); setupScreen(`<div class="empty"><div class="big">📡</div><h3>Keine Verbindung</h3><p>Beim ersten Start braucht die App Internet.</p><button class="btn pri" onclick="location.reload()">Nochmal versuchen</button></div>`); return; }
  } else await Local.start();
  fillInfo();
  if (!me()) return whoAmI();
  ready = true; render();
}

/* ================= Backup ================= */
async function exportData() {
  const name = `spieletracker-backup-${today()}.json`;
  const blob = new Blob([JSON.stringify({ v: 2, ...db }, null, 1)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Spieletracker-Backup' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Backup gespeichert');
}
function importData(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (d.v !== 2 || !d.games || !d.plays || !d.players) throw 0;
      if (!confirm(`Backup laden? (${Object.keys(d.games).length} Spiele, ${Object.keys(d.plays).length} Partien)\nDie aktuellen Daten auf diesem Gerät werden ersetzt.`)) return;
      db.games = d.games; db.players = d.players; db.plays = d.plays; Local.persist(); toast('Backup geladen');
    } catch (e) { alert('Das ist keine gültige Backup-Datei.'); }
  };
  r.readAsText(file);
}

if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
boot();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
