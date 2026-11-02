/* ══════════════════════════════════════════
   阅 · Reader  —  简约阅读器
   ══════════════════════════════════════════ */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ── 内置书目（打包时随 APK 分发） ── */
const BUILTIN = [
  { id: 'b-sample', title: '道德经（节选）', author: '老子 · 公版示例', file: 'books/sample.txt' },
];

const LS = {
  settings: 'reader.settings.v1',
  progress: 'reader.progress.v1',
  shelf:    'reader.shelf.v1',
  bookmarks:'reader.bookmarks.v1',
  chapRecs: 'reader.chaps.v1',
};

/* ── 状态 ── */
const state = {
  books: [],          // [{id,title,author,file?,text?}]
  book: null,         // 当前书
  chapters: [],       // [{title, start, end}]
  text: '',
  idx: 0,
  chromeOn: true,
  etaMode: 0,           // 0 本章 / 1 全书 / 2 速度
  chapStartChars: 0,    // 本章起始偏移（字数）
};

/* ════════ IndexedDB（导入的书） ════════ */
const DB = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    let done = false;
    const fail = e => { if (!done) { done = true; rej(e || new Error('idb')); } };
    setTimeout(() => fail(new Error('idb timeout')), 2500);
    const r = indexedDB.open('reader-db', 1);
    r.onupgradeneeded = () => { try { r.result.createObjectStore('books', { keyPath: 'id' }); } catch {} };
    r.onsuccess = () => { if (!done) { done = true; res(r.result); } };
    r.onerror = () => fail(r.error);
    r.onblocked = () => fail(new Error('idb blocked'));
  }));
  const tx = async (mode) => (await open()).transaction('books', mode).objectStore('books');
  return {
    async all() {
      try {
        const store = await tx('readonly');
        return await new Promise(r => {
          const q = store.getAll();
          q.onsuccess = () => r(q.result || []);
          q.onerror   = () => r([]);
        });
      } catch { return []; }
    },
    async get(id) {
      try {
        const store = await tx('readonly');
        return await new Promise(r => {
          const q = store.get(id);
          q.onsuccess = () => r(q.result);
          q.onerror   = () => r(null);
        });
      } catch { return null; }
    },
    async put(o) {
      try {
        const store = await tx('readwrite');
        return await new Promise(r => { const q = store.put(o); q.onsuccess = () => r(true); q.onerror = () => r(false); });
      } catch { return false; }
    },
    async del(id) {
      try { (await tx('readwrite')).delete(id); return true; } catch { return false; }
    },
  };
})();

/* ════════ 设置 ════════ */
const DEFAULTS = { fs: 17, lh: 188, pad: 28, font: 'system', theme: 'paper' };
let settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS.settings) || '{}') };

function applySettings() {
  const root = document.documentElement;
  root.style.setProperty('--fs', settings.fs + 'px');
  root.style.setProperty('--lh', settings.lh / 100);
  root.style.setProperty('--pad', settings.pad + 'px');
  root.style.setProperty('--read-font',
    settings.font === 'sans'   ? 'var(--font-ui)' :
    settings.font === 'kai'    ? 'var(--font-kai)' :
    settings.font === 'serif'  ? 'var(--font-read)' : 'var(--font-system)');
  root.dataset.theme = settings.theme;

  $('#fontVal').textContent = settings.fs;
  $('#lineRange').value = settings.lh;
  $('#padRange').value = settings.pad;
  $$('#fontSeg button').forEach(b => b.classList.toggle('on', b.dataset.font === settings.font));
  $$('#themeSeg button').forEach(b => b.classList.toggle('on', b.dataset.theme === settings.theme));

  const meta = { paper: '#F7F6F2', warm: '#F6F0E2', night: '#14130F' }[settings.theme];
  $('meta[name=theme-color]').setAttribute('content', meta);
  localStorage.setItem(LS.settings, JSON.stringify(settings));
}

/* ════════ 进度 ════════ */
const progress = JSON.parse(localStorage.getItem(LS.progress) || '{}');
const saveProgress = () => localStorage.setItem(LS.progress, JSON.stringify(progress));

/* ════════ 分章 ════════ */
const CH_TITLE = /^(?:第[0-9零一二三四五六七八九十百千万两]+[章节回幕部]|序幕|序章|楔子|尾声|后记|番外|前传|终章|番外篇)/;

function splitChapters(text) {
  const lines = text.split(/\r?\n/);
  const chapters = [];
  let cur = null;
  let offset = 0;
  const offsets = [];
  for (const l of lines) { offsets.push(offset); offset += l.length + 1; }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const s = raw.trim();
    const match = s.length > 0 && s.length <= 40 && CH_TITLE.test(s);
    if (match) {
      if (cur) { cur.end = offsets[i]; chapters.push(cur); }
      cur = { title: s, start: offsets[i], end: text.length };
    }
  }
  if (cur) chapters.push(cur);
  if (!chapters.length) chapters.push({ title: '正文', start: 0, end: text.length });
  return chapters;
}

/* ════════ 渲染正文 ════════ */
function renderChapter(i) {
  const ch = state.chapters[i];
  if (!ch) return;
  state.idx = i;

  const body = state.text.slice(ch.start, ch.end);
  const frag = document.createDocumentFragment();

  let cursor = ch.start;              // 当前段在全书中的字符偏移
  for (const raw of body.split(/\r?\n/)) {
    const s = raw.trim();
    const lineStart = cursor;
    cursor += raw.length + 1;         // 换行符占 1
    if (!s) continue;
    if (s.length <= 40 && CH_TITLE.test(s)) {
      const h = document.createElement('div');
      h.className = 'ch-head';
      h.textContent = s;
      frag.appendChild(h);
      continue;
    }
    if (/^[=\-*~·—]{3,}$/.test(s)) continue;
    const p = document.createElement('p');
    p.textContent = s;
    p.dataset.off = lineStart + raw.indexOf(s);   // 段首在全书中的偏移
    frag.appendChild(p);
  }

  const page = $('#page');
  page.replaceChildren(frag);

  $('#rChapterTitle').textContent = ch.title;
  $('#rBookTitle').textContent = state.book.title || '';

  // 章末按钮
  const cap = $('#endCap');
  cap.replaceChildren();

  // 章末小结（上次读完本章的记录）
  const rec = chapterRecs[`${state.book?.id}|${i}`];
  if (rec && rec.ms > 15000) {
    const note = document.createElement('div');
    note.className = 'end-note';
    note.innerHTML = `你用 <b>${fmtClock(rec.ms)}</b> 读完了本章`
      + (rec.delta ? `，比平常${rec.delta > 0 ? '快' : '慢'} <span class="tag">${Math.abs(rec.delta)}%</span>` : '')
      + (rec.cheer ? `<br>${rec.cheer}` : '');
    cap.appendChild(note);
  }

  const isLast = i >= state.chapters.length - 1;
  const btn = document.createElement('button');
  btn.textContent = isLast ? '全书完' : '下一章';
  if (!isLast) btn.onclick = () => nextChapter();
  cap.appendChild(btn);

  // ── 时间引擎：本章起始字数 + 计时 ──
  state.chapStartChars = state.chapCharsBefore(i);
  const chapChars = state.chapChars(i);
  Pace.resetChapter(chapChars);

  $('#pageScroll').scrollTop = 0;
  updateProgressUI();
  renderTocCurrent();
  markLastRead();
  refreshBmBtn();
  maybeSleepNudge();
}


/* ════════ 书签 ════════ */
let bookmarks = JSON.parse(localStorage.getItem(LS.bookmarks) || '{}');
// { bookId: [{ ch, off, quote, at }] }
function saveMarks() { localStorage.setItem(LS.bookmarks, JSON.stringify(bookmarks)); }
function marksOf(id) { return bookmarks[id] || (bookmarks[id] = []); }

/** 当前阅读位置对应的段落 */
function currentPara() {
  const sc = $('#pageScroll');
  const line = parseInt(getComputedStyle($('#page')).lineHeight) || 32;
  const y = sc.scrollTop + sc.clientHeight * 0.28;   // 取视野上三分之一处作为"当前位置"
  const ps = $$('#page p');
  let best = ps[0] || null;
  for (const p of ps) {
    const top = p.offsetTop - $('#page').offsetTop;
    if (top <= y) best = p; else break;
  }
  return best;
}

function currentOffset() {
  const p = currentPara();
  if (p) return parseInt(p.dataset.off, 10) || 0;
  const ch = state.chapters[state.idx];
  return ch ? ch.start : 0;
}

function offsetChapter(off) {
  let i = 0;
  for (let k = 0; k < state.chapters.length; k++) {
    if (off >= state.chapters[k].start) i = k; else break;
  }
  return i;
}

/** 当前段落是否已加书签 */
function isMarkedHere() {
  const p = currentPara();
  if (!p) return false;
  const off = parseInt(p.dataset.off, 10) || 0;
  return marksOf(state.book.id).some(m => m.off === off);
}

function refreshBmBtn() {
  const on = isMarkedHere();
  $('#bmBtn').classList.toggle('on', on);
  $('#bmBtn').setAttribute('aria-label', on ? '取消书签' : '加书签');
}

function toggleBookmark() {
  if (!state.book) return;
  const paraEl = currentPara();
  const off = paraEl ? (parseInt(paraEl.dataset.off, 10) || 0) : currentOffset();
  const list = marksOf(state.book.id);
  const hit = list.findIndex(m => m.off === off);

  if (hit >= 0) {
    list.splice(hit, 1);
    saveMarks();
    refreshBmBtn(); renderBmCount();
    toast('已取消书签', 1500);
    return;
  }

  const p = currentPara();
  const quote = (p?.textContent || '').slice(0, 48);
  list.push({
    off,
    ch: state.idx,
    chTitle: state.chapters[state.idx].title,
    quote,
    at: Date.now(),
  });
  list.sort((a, b) => a.off - b.off);
  saveMarks();
  refreshBmBtn(); renderBmCount();
  toast('已加入书签', 1500);
}

/** 跳到书签位置，并把命中的那一段闪一下 */
function gotoMark(m) {
  const idx = (m.ch != null && state.chapters[m.ch]) ? m.ch : offsetChapter(m.off);
  goChapter(idx);
  requestAnimationFrame(() => {
    const ps = $$('#page p');
    const hit = ps.find(p => (parseInt(p.dataset.off, 10) || 0) === m.off)
             || ps.find(p => Math.abs((parseInt(p.dataset.off, 10) || 0) - m.off) < 200);
    if (hit) {
      const sc = $('#pageScroll');
      sc.scrollTop += hit.getBoundingClientRect().top - sc.getBoundingClientRect().top - 120;
      hit.classList.add('bm-flash');
      setTimeout(() => hit.classList.remove('bm-flash'), 1700);
    }
  });
}

function renderBmCount() {
  const n = state.book ? marksOf(state.book.id).length : 0;
  $('#bmCount').textContent = n ? String(n) : '';
}

function fmtWhen(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `今天 ${hm}`;
  const yest = new Date(now.getTime() - 864e5);
  if (d.toDateString() === yest.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`;
}

function renderBookmarks() {
  const box = $('#bmList');
  const list = state.book ? marksOf(state.book.id) : [];
  box.replaceChildren();

  if (!list.length) {
    const em = document.createElement('li');
    em.className = 'bm-empty';
    em.innerHTML = '<b>还没有书签</b>阅读时点右上角的书签图标，标记你舍不得走的那一段。';
    box.appendChild(em);
    renderBmCount();
    return;
  }

  for (const m of list.slice().sort((a, b) => b.at - a.at)) {
    const li = document.createElement('li');
    li.className = 'bm-item';

    const mark = document.createElement('span');
    mark.className = 'bm-mark';
    mark.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4h10a1 1 0 011 1v15l-6-4-6 4V5a1 1 0 011-1z"/></svg>';

    const body = document.createElement('div');
    body.className = 'bm-body';

    const ch = document.createElement('div');
    ch.className = 'bm-ch';
    ch.textContent = m.chTitle || state.chapters[m.ch]?.title || '未命名章节';

    const q = document.createElement('div');
    q.className = 'bm-quote';
    q.textContent = m.quote || '';

    const t = document.createElement('div');
    t.className = 'bm-time';
    t.textContent = fmtWhen(m.at);

    body.append(ch, q, t);

    const del = document.createElement('button');
    del.className = 'bm-del';
    del.setAttribute('aria-label', '删除书签');
    del.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.onclick = (e) => {
      e.stopPropagation();
      const arr = marksOf(state.book.id);
      const i = arr.indexOf(m);
      if (i >= 0) arr.splice(i, 1);
      saveMarks();
      renderBookmarks(); refreshBmBtn();
    };

    li.append(mark, body, del);
    li.onclick = () => { gotoMark(m); closeDrawer(); };
    box.appendChild(li);
  }
  renderBmCount();
}

/* ════════ 字数与时间预估 ════════ */
const chapterRecs = JSON.parse(localStorage.getItem('reader.chaps.v1') || '{}');
function saveChapRecs() { localStorage.setItem('reader.chaps.v1', JSON.stringify(chapterRecs)); }

// 每章字符数缓存
const chapCharCache = new WeakMap();
function chapChars(i) {
  const ch = state.chapters[i];
  if (!ch) return 0;
  let arr = chapCharCache.get(state.chapters);
  if (arr && arr[i] != null) return arr[i];
  if (!arr) { arr = new Array(state.chapters.length); chapCharCache.set(state.chapters, arr); }
  arr[i] = (ch.end - ch.start);
  return arr[i];
}
state.chapChars = chapChars;
state.chapCharsBefore = (i) => {
  let n = 0;
  for (let k = 0; k < i; k++) n += chapChars(k);
  return n;
};

// 当前已读字符数（估算：按滚动比例 × 本章字数）
function readCharsInChapter() {
  const sc = $('#pageScroll');
  const max = sc.scrollHeight - sc.clientHeight;
  const r = max > 0 ? Math.min(1, Math.max(0, sc.scrollTop / max)) : 0;
  return chapChars(state.idx) * r;
}

function currentWpm() {
  return Pace.wpm(state.book?.id || 'x');
}

/** 本章剩余分钟 */
function etaChapter() {
  const left = Math.max(0, chapChars(state.idx) - readCharsInChapter());
  return left / currentWpm();
}

/** 全书剩余分钟：后续章节总字数 / 速度 + 本章剩余 */
function etaBook() {
  const total = state.text.length;
  const done = state.chapStartChars + readCharsInChapter();
  return Math.max(0, total - done) / currentWpm();
}

/** 读完需不需要提醒（深夜） */
function maybeSleepNudge() {
  const now = new Date();
  const h = now.getHours();
  const deep = h >= 1 && h < 5;
  const el = $('#sleepNudge');
  if (!deep) { el.hidden = true; return; }
  const m = etaChapter();
  if (m >= 10) {
    el.textContent = `本章较长（还需 ${Math.round(m)} 分钟），注意休息哦`;
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 9000);
  } else {
    el.hidden = true;
  }
}

/* 轻提示 */
let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

/* 翻到下一章：结算上一章 */
function nextChapter() {
  const i = state.idx;
  const ms = Pace.chapterElapsed();
  const chars = Math.max(1, readCharsInChapter());
  if (ms > 15000 && chars > 200) {
    const speed = chars / (ms / 60000);
    const base = currentWpm();
    const delta = Math.round(((speed - base) / base) * 100);
    const cheer = speed > base * 1.25 ? '高能章节真上头'
      : speed < base * 0.7 ? '这段看得慢，值得回味'
      : '';
    chapterRecs[`${state.book.id}|${i}`] = { ms, delta, cheer, at: Date.now() };
    saveChapRecs();
    Pace.addChapterDone(state.book.id);
  }
  Pace.flush(state.book.id);
  goChapter(i + 1, 0);
}

/* ════════ 打开书 ════════ */
async function openBook(id) {
  const meta = state.books.find(b => b.id === id);
  if (!meta) return;

  $('#shelf').hidden = true;
  $('#reader').hidden = false;
  $('#page').innerHTML = '<p style="text-indent:0;color:var(--text-3)">载入中…</p>';

  let text = '';
  if (meta.text) text = meta.text;
  else {
    const rec = await DB.get(meta.id);
    if (rec) text = rec.text;
    else if (window.NativeBridge?.readBook) text = await NativeBridge.readBook(meta.file);
    else {
      const res = await fetch(encodeURI(meta.file));
      text = await res.text();
    }
  }

  state.book = meta;
  state.text = text;
  state.chapters = splitChapters(text);
  meta.chars = text.length;

  const p = progress[meta.id];
  const startIdx = p && p.chapter < state.chapters.length ? p.chapter : 0;

  $('#rBookTitle').textContent = meta.title;
  buildToc();
  renderBookmarks();
  renderChapter(startIdx);
  showChrome(true);
}

function goChapter(i, ratio = 0) {
  if (i < 0 || i >= state.chapters.length) return;
  renderChapter(i);
  const sc = $('#pageScroll');
  if (ratio) requestAnimationFrame(() => { sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * ratio; });
}

/* ════════ 工具栏 ════════ */
function showChrome(on) {
  state.chromeOn = on;
  $('#chromeTop').classList.toggle('hide', !on);
  $('#chromeBottom').classList.toggle('hide', !on);
}

/* ════════ 进度 UI ════════ */
function updateProgressUI() {
  const sc = $('#pageScroll');
  const max = sc.scrollHeight - sc.clientHeight;
  const r = max > 0 ? Math.min(1, sc.scrollTop / max) : 0;

  const pct = Math.round(r * 100);
  $('#progressLabel').textContent = `${state.idx + 1} / ${state.chapters.length} 章`;
  $('#progressFill').style.width = pct + '%';
  renderEta();

  if (state.book) {
    progress[state.book.id] = { chapter: state.idx, ratio: r, at: Date.now() };
    saveProgress();
    markLastRead();
  }
}

function renderEta() {
  if (!state.book) return;
  const el = $('#etaLabel');
  const cold = Pace.isCold(state.book.id);
  el.classList.toggle('cold', cold);

  const m = etaChapter();
  const mb = etaBook();
  const v = Math.round(currentWpm());

  if (state.etaMode === 1) {
    el.textContent = `全书 ${fmtMin(mb)}`;
  } else if (state.etaMode === 2) {
    el.textContent = `${v} 字/分`;
  } else {
    el.textContent = m < 1 ? '本章快读完了' : `本章还需 ${Math.round(m)} 分钟`;
  }
  el.dataset.hint = cold ? '默认速度估算，读几页后会校准' : '点一下切换：本章 / 全书 / 速度';
}

$('#etaLabel').onclick = (e) => {
  e.stopPropagation();
  state.etaMode = (state.etaMode + 1) % 3;
  renderEta();
  toast(['本章剩余时间', '全书剩余时间', '当前阅读速度'][state.etaMode], 1400);
};

let rafPending = false;
$('#pageScroll').addEventListener('scroll', () => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    updateProgressUI();
    refreshBmBtn();
    if (state.book) Pace.onScroll($('#pageScroll'), state.book.id);
  });
}, { passive: true });

/* ════════ 目录 ════════ */
function buildToc() {
  const list = $('#tocList');
  const frag = document.createDocumentFragment();
  state.chapters.forEach((ch, i) => {
    const li = document.createElement('li');
    li.className = 'toc-item';
    li.dataset.i = i;
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = i + 1;
    const t = document.createElement('span');
    t.className = 'toc-label';
    t.textContent = ch.title;
    const tm = document.createElement('span');
    tm.className = 'toc-time';
    li.append(idx, t, tm);
    li.onclick = () => { goChapter(i); closeDrawer(); };
    frag.appendChild(li);
  });
  list.replaceChildren(frag);
  renderTocCurrent();
}

function renderTocCurrent() {
  $$('#tocList .toc-item').forEach(el => el.classList.toggle('on', +el.dataset.i === state.idx));
  const on = $('#tocList .toc-item.on');
  if (on) on.scrollIntoView({ block: 'center' });
}

function fillTocTimes() {
  const wpm = currentWpm();
  $$('#tocList .toc-item').forEach(el => {
    const i = +el.dataset.i;
    const tm = el.querySelector('.toc-time');
    if (!tm || tm.dataset.done === String(Math.round(wpm))) return;
    const m = chapChars(i) / wpm;
    tm.textContent = m < 1 ? '<1m' : `${Math.round(m)}m`;
    tm.dataset.done = String(Math.round(wpm));
  });
}

function openDrawer() {
  fillTocTimes();
  $('#drawer').hidden = false;
  $('#drawerMask').hidden = false;
  $('#tocSearch').value = '';
  $$('#tocList .toc-item').forEach(el => el.hidden = false);
  renderTocCurrent();
}
function closeDrawer() {
  const d = $('#drawer');
  d.classList.add('closing');
  setTimeout(() => {
    d.hidden = true; d.classList.remove('closing');
    $('#drawerMask').hidden = true;
  }, 200);
}

$('#tocSearch').addEventListener('input', e => {
  const q = e.target.value.trim();
  $$('#tocList .toc-item').forEach(el => {
    el.hidden = q ? !el.textContent.includes(q) : false;
  });
  fillTocTimes();
});

/* ════════ 设置面板 ════════ */
function openSheet() {
  $('#sheet').hidden = false;
  $('#sheetMask').hidden = false;
}
function closeSheet() {
  const s = $('#sheet');
  s.classList.add('closing');
  setTimeout(() => { s.hidden = true; s.classList.remove('closing'); $('#sheetMask').hidden = true; }, 220);
}

$('#fontMinus').onclick = () => { settings.fs = Math.max(13, settings.fs - 1); applySettings(); };
$('#fontPlus').onclick  = () => { settings.fs = Math.min(28, settings.fs + 1); applySettings(); };
$('#lineRange').oninput = e => { settings.lh = +e.target.value; applySettings(); };
$('#padRange').oninput  = e => { settings.pad = +e.target.value; applySettings(); };
$$('#fontSeg button').forEach(b => b.onclick = () => { settings.font = b.dataset.font; applySettings(); });
$$('#themeSeg button').forEach(b => b.onclick = () => { settings.theme = b.dataset.theme; applySettings(); });

/* ════════ 书架 ════════ */
function fmtChars(n) {
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + ' 万字';
  return n + ' 字';
}

function markLastRead() {
  const id = state.book?.id;
  if (!id) return;
  const el = $(`[data-book="${id}"] .book-meta`);
  if (!el) return;
  const p = progress[id];
  if (!p) return;
  const pct = Math.round(((p.chapter + (p.ratio || 0)) / (state.chapters.length || 1)) * 100);
  let tag = el.querySelector('.book-prog');
  if (!tag) { tag = document.createElement('span'); tag.className = 'book-prog'; el.appendChild(tag); }
  tag.textContent = `读至 ${pct}%`;
}

function renderShelf() {
  const list = $('#bookList');
  const frag = document.createDocumentFragment();

  if (!state.books.length) {
    const empty = document.createElement('div');
    empty.className = 'shelf-empty';
    empty.innerHTML = `
      <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" style="opacity:.45">
        <path d="M4 5.5A1.5 1.5 0 015.5 4H10a2 2 0 012 2v13a1.6 1.6 0 00-1.6-1.6H4z"/>
        <path d="M20 5.5A1.5 1.5 0 0018.5 4H14a2 2 0 00-2 2v13a1.6 1.6 0 011.6-1.6H20z"/>
      </svg>
      <b>暂无书籍</b>
      <p>点击下方 <em>导入</em>，选择手机里的 .txt 文件<br>导入后永远不会上传，全部留在本机</p>`;
    list.replaceChildren(empty);
    $('#shelfSub').textContent = '0 本 · 本地';
    refreshDock();
    return;
  }

  for (const b of state.books) {
    const li = document.createElement('li');
    li.className = 'book';
    li.dataset.book = b.id;

    const body = document.createElement('div');
    body.className = 'book-body';

    const name = document.createElement('div');
    name.className = 'book-name';
    name.textContent = b.title;

    const meta = document.createElement('div');
    meta.className = 'book-meta';
    if (b.author) meta.append(b.author);
    if (b.chars) { if (b.author) meta.append(Object.assign(document.createElement('span'), { className: 'dot', textContent: '·' })); meta.append(fmtChars(b.chars)); }

    body.append(name, meta);

    const chev = document.createElement('span');
    chev.className = 'book-chev';
    chev.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';

    li.append(body, chev);
    li.onclick = () => openBook(b.id);

    if (b.id.startsWith('u-')) {
      let timer = null;
      const start = () => { timer = setTimeout(async () => {
        if (confirm(`从书架移除《${b.title}》？`)) {
          await DB.del(b.id);
          state.books = state.books.filter(x => x.id !== b.id);
          delete progress[b.id]; saveProgress();
          renderShelf();
        }
      }, 600); };
      const cancel = () => clearTimeout(timer);
      li.addEventListener('pointerdown', start);
      li.addEventListener('pointerup', cancel);
      li.addEventListener('pointerleave', cancel);
      li.addEventListener('contextmenu', e => { e.preventDefault(); start(); });
    }

    frag.appendChild(li);

    const p = progress[b.id];
    if (p) {
      const tag = document.createElement('span');
      tag.className = 'book-prog';
      tag.textContent = `第 ${p.chapter + 1} 章`
      body.querySelector('.book-meta').append(tag);
    }
  }

  list.replaceChildren(frag);
  $('#shelfSub').textContent = `${state.books.length} 本 · 本地`;
  refreshDock();
}

/* ════════ 初始化 ════════ */
async function init() {
  applySettings();

  // 内置书（字数在打开后回填）
  state.books = BUILTIN.map(b => ({ ...b }));
  renderShelf();

  // 导入过的书
  const imported = await DB.all().catch(() => []);
  for (const rec of imported) {
    state.books.push({ id: rec.id, title: rec.title, author: rec.author || '导入', chars: rec.text.length, text: rec.text });
  }

  renderShelf();

  renderShelf();
}

/* ════════ 书架：滚动玻璃 + 动态高光 ════════ */
const shelfEl = $('#shelf');
shelfEl.addEventListener('scroll', () => {
  $('#shelfNav').classList.toggle('scrolled', shelfEl.scrollTop > 6);
}, { passive: true });

// 指针移动 → 玻璃高光跟随（鼠标 / 拖动）
for (const el of $$('.glass').filter(x => x.id === 'dock')) {
  el.addEventListener('pointermove', e => {
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
    el.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
    el.classList.add('lit');
  });
  el.addEventListener('pointerleave', () => el.classList.remove('lit'));
}

// 滚动时玻璃坞轻微回弹
let dockTick = 0;
shelfEl.addEventListener('scroll', () => {
  const d = $('#dock');
  d.classList.add('pressed');
  clearTimeout(dockTick);
  dockTick = setTimeout(() => d.classList.remove('pressed'), 140);
}, { passive: true });

/* ════════ 继续阅读 ════════ */
function refreshDock() {
  const entries = Object.entries(progress).filter(([id]) => state.books.some(b => b.id === id));
  entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  const last = entries[0];
  const sub = $('#continueSub');
  if (last) {
    const book = state.books.find(b => b.id === last[0]);
    sub.textContent = `${book.title} · 第 ${last[1].chapter + 1} 章`;
  } else if (state.books.length) {
    sub.textContent = state.books[0].title;
  } else {
    sub.textContent = '书架为空';
  }
}

$('#continueBtn').onclick = () => {
  const entries = Object.entries(progress).filter(([id]) => state.books.some(b => b.id === id));
  entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  if (entries[0]) return openBook(entries[0][0]);
  if (state.books[0]) return openBook(state.books[0].id);
  $('#fileInput').click();
};

/* ════════ 事件绑定 ════════ */
$('#backBtn').onclick = () => {
  $('#reader').hidden = true;
  $('#shelf').hidden = false;
  state.book = null;
  renderShelf();
};

/* ════════ 阅读时光 ════════ */
function openStats() {
  const s = Pace.weekSummary();
  $('#statsTotal').textContent = fmtHours(s.ms);
  $('#statsBars').replaceChildren();

  const days = [];
  const now = new Date();
  let maxMs = 1;
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 864e5);
    const k = Pace.dayKey(d);
    const rec = Pace.stats.days[k];
    const ms = rec ? rec.ms : 0;
    maxMs = Math.max(maxMs, ms);
    days.push({ label: '日一二三四五六'[d.getDay()], ms, today: i === 0 });
  }
  for (const d of days) {
    const bar = document.createElement('div');
    bar.className = 'stats-bar' + (d.today ? ' today' : '');
    const i = document.createElement('i');
    i.style.height = Math.max(2, (d.ms / maxMs) * 74) + 'px';
    const sp = document.createElement('span');
    sp.textContent = d.label;
    bar.append(i, sp);
    $('#statsBars').appendChild(bar);
  }

  const lines = [];
  if (s.ms > 0) {
    lines.push(`本周共 <b>${fmtHours(s.ms)}</b>，读完 <b>${s.chars.toLocaleString()}</b> 字。`);
  } else {
    lines.push('还没有记录。随便读几页，这里就会长出你的轨迹。');
  }

  // 最沉迷的一本
  const entries = Object.entries(s.books).sort((a, b) => b[1] - a[1]);
  if (entries.length) {
    const top = entries[0];
    const book = state.books.find(b => b.id === top[0]);
    if (book) lines.push(`在《<b>${book.title}</b>》待得最久：<b>${fmtHours(top[1])}</b>`);
  }

  if (s.best) {
    const h = s.best.hour;
    const when = h >= 18 ? '晚上' : h >= 12 ? '下午' : h >= 6 ? '上午' : '深夜';
    lines.push(`<b>${when}</b>读得最快，<b>${s.best.wpm}</b> 字/分钟`);
  }

  if (s.chapters) lines.push(`一共读完 <b>${s.chapters}</b> 章。`);

  $('#statsLines').replaceChildren(...lines.map(t => {
    const d = document.createElement('div');
    d.className = 'stats-line';
    d.innerHTML = t;
    return d;
  }));

  $('#statsSheet').hidden = false;
  $('#statsMask').hidden = false;
}

function closeStats() {
  const s = $('#statsSheet');
  s.classList.add('closing');
  setTimeout(() => { s.hidden = true; s.classList.remove('closing'); $('#statsMask').hidden = true; }, 220);
}

$('#statsBtn').onclick = openStats;
$('#statsMask').onclick = closeStats;

$('#bmBtn').onclick = toggleBookmark;

/* 目录 / 书签 切换 */
function setDrawerTab(which) {
  const isBm = which === 'bm';
  $('#tabToc').classList.toggle('on', !isBm);
  $('#tabBm').classList.toggle('on', isBm);
  $('#tocList').hidden = isBm;
  $('#bmList').hidden = !isBm;
  $('.drawer-search').style.display = isBm ? 'none' : '';
  if (isBm) renderBookmarks();
  else { $('#tocSearch').value = ''; $$('#tocList .toc-item').forEach(el => el.hidden = false); fillTocTimes(); renderTocCurrent(); }
}
$('#tabToc').onclick = () => setDrawerTab('toc');
$('#tabBm').onclick = () => setDrawerTab('bm');

$('#tocBtn').onclick = () => { setDrawerTab('toc'); openDrawer(); };
$('#formatBtn').onclick = openSheet;
$('#drawerClose').onclick = closeDrawer;
$('#statsBtn').addEventListener('click', () => closeDrawer());
$('#drawerMask').onclick  = closeDrawer;
$('#sheetMask').onclick   = closeSheet;

// 底栏空白处点击打开设置（点时间标签不触发）
$('#chromeBottom').onclick = (e) => {
  if (e.target.id === 'etaLabel') return;
  openSheet();
};

$('#importBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = async e => {
  const files = [...(e.target.files || [])];
  if (!files.length) return;
  setImporting(true);
  let ok = 0;
  for (const f of files) {
    try {
      const raw = await f.text();
      // 去掉 BOM，统一换行
      const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
      if (!text.trim()) continue;
      const id = 'u-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      const title = f.name.replace(/\.(txt|text)$/i, '');
      await DB.put({ id, title, author: '本地导入', text });
      state.books.push({ id, title, author: '本地导入', chars: text.length, text });
      ok++;
    } catch (err) {
      console.warn('import failed', f.name, err);
    }
  }
  setImporting(false);
  renderShelf();
  e.target.value = '';
  toast(ok ? `已导入 ${ok} 本` : '导入失败，请确认为 UTF-8 编码的 .txt', 2200);
};

let importing = false;
function setImporting(on) {
  importing = on;
  const btn = $('#importBtn');
  const sub = btn?.querySelector('.dock-sub');
  if (sub) sub.textContent = on ? '导入中…' : '本地 TXT';
  btn?.classList.toggle('busy', on);
}

// 键盘：← → 切章
document.addEventListener('keydown', e => {
  if ($('#reader').hidden) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') goChapter(state.idx + 1);
  if (e.key === 'ArrowLeft'  || e.key === 'PageUp')   goChapter(state.idx - 1);
  if (e.key === 'Escape') closeDrawer() || closeSheet();
});

// 轻触隐藏/显示工具栏（点击正文区域）
$('#pageScroll').addEventListener('click', e => {
  if (e.target.closest('.end-cap button')) return;
  showChrome(!state.chromeOn);
});

/* 启动 */
init().catch(err => {
  console.error(err);
  $('#shelfSub').textContent = '载入失败：' + err.message;
});
