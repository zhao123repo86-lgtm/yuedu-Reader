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
  pageAnchors: [],      // 第 n 页的起始字符偏移（翻页模式）
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
const DEFAULTS = {
  fs: 17, lh: 188, pad: 28, font: 'system',
  theme: 'paper',     // auto | paper | warm | night | oled
  mode: 'scroll',     // scroll 滑动 ｜ page 翻页
  autoSpeed: 42,      // 自动滚动速度 px/秒
};
let settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS.settings) || '{}') };

const THEME_BG = { paper: '#F7F6F2', warm: '#F6F0E2', night: '#14130F', oled: '#000000' };
const mqDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

/** 跟随系统时，把 auto 解析成实际主题 */
function resolvedTheme() {
  if (settings.theme !== 'auto') return settings.theme;
  return (mqDark && mqDark.matches) ? 'night' : 'paper';
}

function applySettings() {
  const root = document.documentElement;
  root.style.setProperty('--fs', settings.fs + 'px');
  root.style.setProperty('--lh', settings.lh / 100);
  root.style.setProperty('--pad', settings.pad + 'px');
  root.style.setProperty('--read-font',
    settings.font === 'sans'   ? 'var(--font-ui)' :
    settings.font === 'kai'    ? 'var(--font-kai)' :
    settings.font === 'serif'  ? 'var(--font-read)' : 'var(--font-system)');

  const theme = resolvedTheme();
  root.dataset.theme = theme;
  if (theme === 'night' || theme === 'oled') root.setAttribute('data-dark', '1');
  else root.removeAttribute('data-dark');

  $('#fontVal').textContent = settings.fs;
  $('#lineRange').value = settings.lh;
  $('#padRange').value = settings.pad;
  $$('#fontSeg button').forEach(b => b.classList.toggle('on', b.dataset.font === settings.font));
  $$('#themeSeg button').forEach(b => b.classList.toggle('on', b.dataset.theme === settings.theme));
  $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === settings.mode));

  const bg = THEME_BG[theme] || THEME_BG.paper;
  $('meta[name=theme-color]').setAttribute('content', bg);
  try { window.NativeBridge?.setTheme(theme, bg, theme === 'night' || theme === 'oled'); } catch {}
  localStorage.setItem(LS.settings, JSON.stringify(settings));
}

/* ════════ 进度 ════════ */
const progress = JSON.parse(localStorage.getItem(LS.progress) || '{}');
const saveProgress = () => localStorage.setItem(LS.progress, JSON.stringify(progress));

/* ════════ 分章 ════════ */
const CH_TITLE = /^(?:第[0-9０-９零一二三四五六七八九十百千万两]+[章节回幕部篇卷]|Chapter\s*[0-9]+|序章|序幕|楔子|引子|尾声|终章|后记|番外|前传)/i;

/**
 * 这一行算不算标题。
 * 光看正则会把“第一章里……”这种正文句子也当成章名，
 * 所以再加两道：不能过长，不能带标点。
 */
function isHeading(s) {
  if (!s || s.length > 32) return false;
  if (/[。！？；：，、]/.test(s)) return false;
  return CH_TITLE.test(s);
}

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
    const match = s.length > 0 && isHeading(s);
    if (match) {
      if (cur) { cur.end = offsets[i]; chapters.push(cur); }
      cur = { title: s, start: offsets[i], end: text.length };
    }
  }
  if (cur) chapters.push(cur);
  if (!chapters.length) chapters.push({ title: '正文', start: 0, end: text.length });
  return chapters;
}

/**
 * 导入时一次性清洗：结果落库，之后字符偏移永远稳定。
 * 做四件事：去 BOM / 统一换行 / 去零宽字符 / 合并多余空行 + 去分隔线。
 * 缩进交给 CSS text-indent，不往正文里塞全角空格（那会污染偏移量）。
 */
function cleanText(raw) {
  const t = String(raw)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');

  const out = [];
  let pendingBlank = false;
  for (const line of t.split('\n')) {
    const s = line.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
    if (!s) { pendingBlank = true; continue; }
    if (/^[=\-*~·—─＿_#]{3,}$/.test(s)) continue;      // 分隔线
    if (pendingBlank && out.length) out.push('');
    pendingBlank = false;
    out.push(s);
  }
  return out.join('\n');
}

/** EPUB 章节列表 → 全书文本 + 章节偏移（偏移在拼接当场算好，之后不再变） */
function textFromEpubChapters(list) {
  let text = '';
  const chapters = [];
  for (const c of list) {
    const body = String(c.text || '').trim();
    if (!body) continue;
    const title = String(c.title || '').trim() || `第 ${chapters.length + 1} 节`;
    const start = text.length;
    text += title + '\n\n' + body + '\n\n';
    chapters.push({ title, start, end: text.length });
  }
  if (!chapters.length) chapters.push({ title: '正文', start: 0, end: text.length });
  return { text, chapters };
}

/* ════════ 视图模式：滑动 / 翻页 ════════ */
const isPaged = () => settings.mode === 'page';

function pageWidth() {
  const sc = $('#pageScroll');
  return sc.clientWidth || window.innerWidth || 1;
}

/**
 * 分页度量：column-width = 视口宽 − 2×边距，column-gap = 2×边距。
 * 这样每一栏的“周期”恰好等于视口宽，scrollLeft = 页号 × 视口宽 就是整页对齐。
 * 文字流、避头尾、字号重排全部交给浏览器，不自己算断页。
 */
function applyPagedMetrics() {
  const page = $('#page');
  if (!isPaged()) {
    page.style.columnWidth = '';
    page.style.columnGap = '';
    return;
  }
  const pad = settings.pad;
  page.style.columnWidth = Math.max(120, pageWidth() - pad * 2) + 'px';
  page.style.columnGap = (pad * 2) + 'px';
}

function pageCount() {
  if (!isPaged()) return 1;
  const W = pageWidth();
  return Math.max(1, Math.round($('#pageScroll').scrollWidth / W));
}

function currentPageIndex() {
  if (!isPaged()) return 0;
  return Math.max(0, Math.min(pageCount() - 1, Math.round($('#pageScroll').scrollLeft / pageWidth())));
}

/** 每页的起始字符偏移（重排后用，帧内 O(1) 取值） */
function buildPageAnchors() {
  state.pageAnchors = [];
  if (!isPaged()) return;
  const W = pageWidth();
  const origin = $('#page').getBoundingClientRect().left;
  for (const p of $$('#page p')) {
    const off = parseInt(p.dataset.off, 10) || 0;
    for (const r of p.getClientRects()) {
      const idx = Math.max(0, Math.round((r.left - origin) / W));
      if (state.pageAnchors[idx] == null || off < state.pageAnchors[idx]) state.pageAnchors[idx] = off;
    }
  }
}

const paraByOffset = (off) => {
  let target = null;
  for (const p of $$('#page p')) {
    const o = parseInt(p.dataset.off, 10) || 0;
    if (o <= off) target = p; else break;
  }
  return target;
};

/** 落回某个字符偏移：分页就翻到那一页，滑动就滚到那一段 */
function locateOffset(off) {
  const sc = $('#pageScroll');
  const target = paraByOffset(off);
  if (!target) { sc.scrollTop = 0; sc.scrollLeft = 0; return; }

  if (isPaged()) {
    const W = pageWidth();
    const rects = target.getClientRects();
    if (!rects.length) return;
    const idx = Math.max(0, Math.round((rects[0].left - $('#page').getBoundingClientRect().left) / W));
    sc.scrollLeft = idx * W;
  } else {
    const r = target.getBoundingClientRect();
    sc.scrollTop = Math.max(0, sc.scrollTop + r.top - sc.getBoundingClientRect().top - 96);
  }
}

/** 当前阅读位置对应的字符偏移（进度的唯一真相） */
let anchorMemo = { key: '', val: 0 };
function currentAnchor() {
  const sc = $('#pageScroll');
  // 同一帧里 updateProgressUI 和 refreshBmBtn 会各问一次，用位置做 key 记一下
  const key = `${state.idx}|${sc.scrollTop}|${sc.scrollLeft}|${sc.scrollHeight}|${sc.scrollWidth}`;
  if (anchorMemo.key === key) return anchorMemo.val;

  const fallback = state.chapters[state.idx]?.start || 0;
  let val;
  if (isPaged()) {
    const a = state.pageAnchors && state.pageAnchors[currentPageIndex()];
    val = a != null ? a : fallback;
  } else {
    const y = sc.scrollTop + sc.clientHeight * 0.28;
    const pageTop = $('#page').offsetTop;
    let best = null;
    for (const p of $$('#page p')) {
      if (p.offsetTop - pageTop <= y) best = p; else break;
    }
    val = best ? (parseInt(best.dataset.off, 10) || 0) : fallback;
  }
  anchorMemo.key = key;
  anchorMemo.val = val;
  return val;
}

/** 阅读进度比例（0–1），两种模式各有各的算法 */
function scrollRatio() {
  const sc = $('#pageScroll');
  if (isPaged()) {
    const n = pageCount();
    return n <= 1 ? 0 : currentPageIndex() / (n - 1);
  }
  const max = sc.scrollHeight - sc.clientHeight;
  return max > 0 ? Math.min(1, Math.max(0, sc.scrollTop / max)) : 0;
}

/** 打完这一章后把位置摆对：anchor 可以是字符偏移、0 或 'end' */
function layoutChapter(anchor) {
  const sc = $('#pageScroll');
  sc.scrollTop = 0;
  sc.scrollLeft = 0;

  const place = () => {
    if (isPaged()) {
      applyPagedMetrics();
      buildPageAnchors();
      if (anchor === 'end') sc.scrollLeft = (pageCount() - 1) * pageWidth();
      else if (anchor) locateOffset(anchor);
    } else if (anchor === 'end') {
      sc.scrollTop = sc.scrollHeight;
    } else if (anchor) {
      locateOffset(anchor);
    }
  };

  place();
  requestAnimationFrame(place);      // 字体/列宽落定后再校一次
}

/* ════════ 渲染正文 ════════ */
function renderChapter(i, anchor = 0) {
  const ch = state.chapters[i];
  if (!ch) return;
  state.idx = i;
  anchorMemo = { key: '', val: 0 };

  const body = state.text.slice(ch.start, ch.end);
  const frag = document.createDocumentFragment();

  let cursor = ch.start;              // 当前段在全书中的字符偏移
  for (const raw of body.split(/\r?\n/)) {
    const s = raw.trim();
    const lineStart = cursor;
    cursor += raw.length + 1;         // 换行符占 1
    if (!s) continue;
    if (isHeading(s)) {
      const h = document.createElement('div');
      h.className = 'ch-head';
      h.textContent = s;
      frag.appendChild(h);
      continue;
    }
    if (/^[=\-*~·\u2014]{3,}$/.test(s)) continue;
    const p = document.createElement('p');
    p.textContent = s;
    p.dataset.off = lineStart + raw.indexOf(s);   // 段首在全书中的偏移
    frag.appendChild(p);
  }

  const page = $('#page');
  const cap = $('#endCap');
  if (cap && cap.parentElement === page) page.after(cap);   // 先摘出来，否则会被 replaceChildren 吃掉
  page.replaceChildren(frag);
  if (isPaged() && cap) page.appendChild(cap);              // 翻页模式：章末并入最后一栅

  $('#rChapterTitle').textContent = ch.title;
  $('#rBookTitle').textContent = state.book.title || '';

  buildEndCap();

  // ── 时间引擎：本章起始字数 + 计时 ──
  state.chapStartChars = state.chapCharsBefore(i);
  Pace.resetChapter(state.chapChars(i));

  layoutChapter(anchor);

  updateProgressUI();
  renderTocCurrent();
  markLastRead();
  refreshBmBtn();
  maybeSleepNudge();
}

/** 章末那块：上次读完记录 + 下一章按钮 */
function buildEndCap() {
  const cap = $('#endCap');
  if (!cap) return;
  cap.replaceChildren();
  const i = state.idx;

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
}


/* ════════ 书签 ════════ */
let bookmarks = JSON.parse(localStorage.getItem(LS.bookmarks) || '{}');
// { bookId: [{ ch, off, quote, at }] }
function saveMarks() { localStorage.setItem(LS.bookmarks, JSON.stringify(bookmarks)); }
function marksOf(id) { return bookmarks[id] || (bookmarks[id] = []); }

/** 当前阅读位置对应的段落（书签锚点用） */
function currentPara() {
  return paraByOffset(currentAnchor());
}

function currentOffset() {
  return currentAnchor();
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
  goChapter(idx, isPaged() ? m.off : 0);
  requestAnimationFrame(() => {
    const ps = $$('#page p');
    let hit = paraByOffset(m.off);
    if (!hit) hit = ps.find(p => Math.abs((parseInt(p.dataset.off, 10) || 0) - m.off) < 200);
    if (!hit) return;

    if (isPaged()) {
      locateOffset(parseInt(hit.dataset.off, 10) || m.off);
    } else {
      const sc = $('#pageScroll');
      sc.scrollTop += hit.getBoundingClientRect().top - sc.getBoundingClientRect().top - 120;
      updateProgressUI();
    }

    hit.classList.add('bm-flash');
    setTimeout(() => hit.classList.remove('bm-flash'), 1700);
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

// 当前已读字符数（按滚动/翻页比例 × 本章字数）
function readCharsInChapter() {
  return chapChars(state.idx) * scrollRatio();
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

/* 翻到上一章：落在上一章末尾 */
function prevChapter(landAtEnd = false) {
  if (state.idx <= 0) { toast('已经是开头了', 1200); return; }
  Pace.flush(state.book?.id);
  goChapter(state.idx - 1, landAtEnd ? 'end' : 0);
}

/* ════════ 翻页 / 滚动推进 ════════ */
function nextPage() {
  const sc = $('#pageScroll');
  if (!isPaged()) {
    const max = sc.scrollHeight - sc.clientHeight;
    if (sc.scrollTop >= max - 2) return nextChapter();
    sc.scrollTop = Math.min(max, sc.scrollTop + sc.clientHeight * 0.88);
    return;
  }
  const i = currentPageIndex();
  if (i >= pageCount() - 1) return nextChapter();
  sc.scrollLeft = (i + 1) * pageWidth();
}

function prevPage() {
  const sc = $('#pageScroll');
  if (!isPaged()) {
    if (sc.scrollTop <= 2) return prevChapter(true);
    sc.scrollTop = Math.max(0, sc.scrollTop - sc.clientHeight * 0.88);
    return;
  }
  const i = currentPageIndex();
  if (i <= 0) return prevChapter(true);
  sc.scrollLeft = (i - 1) * pageWidth();
}

const toggleChrome = () => showChrome(!state.chromeOn);

/* ════════ 打开书 ════════ */
async function openBook(id) {
  const meta = state.books.find(b => b.id === id);
  if (!meta) return;
  if (auto.on) stopAuto(true);

  $('#shelf').hidden = true;
  $('#reader').hidden = false;
  $('#page').innerHTML = '<p style="text-indent:0;color:var(--text-3)">载入中…</p>';

  let text = '', storedChapters = meta.chapters || null;
  if (meta.text) text = meta.text;
  else {
    const rec = await DB.get(meta.id);
    if (rec) { text = rec.text; storedChapters = rec.chapters || null; }
    else if (window.NativeBridge?.readBook) text = await NativeBridge.readBook(meta.file);
    else {
      const res = await fetch(encodeURI(meta.file));
      text = await res.text();
    }
  }

  state.book = meta;
  state.text = text;
  state.chapters = storedChapters
    ? storedChapters.map(c => ({ title: c.title, start: c.start, end: c.end == null ? text.length : c.end }))
    : splitChapters(text);
  meta.chars = text.length;

  /* 恢复位置：优先字符偏移，兼容旧的章+比例记录 */
  const p = progress[meta.id];
  let startIdx = 0, anchor = 0;
  if (p) {
    if (p.off != null) {
      startIdx = offsetChapter(p.off);
      anchor = p.off;
    } else if (p.chapter != null && p.chapter < state.chapters.length) {
      startIdx = p.chapter;
      const c = state.chapters[p.chapter];
      anchor = Math.round(c.start + (c.end - c.start) * (p.ratio || 0));
    }
  }

  $('#rBookTitle').textContent = meta.title;
  buildToc();
  renderBookmarks();
  renderChapter(startIdx, anchor);
  showChrome(true);
}

function goChapter(i, anchor = 0) {
  if (i < 0 || i >= state.chapters.length) return;
  renderChapter(i, anchor);
}

/* ════════ 工具栏 ════════ */
function showChrome(on) {
  state.chromeOn = on;
  $('#chromeTop').classList.toggle('hide', !on);
  $('#chromeBottom').classList.toggle('hide', !on);
}

/* ════════ 视图模式切换 ════════ */
function applyMode(anchor) {
  const paged = isPaged();
  const sc = $('#pageScroll');
  sc.classList.toggle('paged', paged);

  const cap = $('#endCap'), page = $('#page');
  if (!paged && cap && cap.parentElement === page) page.after(cap);

  if (!state.book) return;
  renderChapter(state.idx, anchor == null ? currentAnchor() : anchor);
}

/** 切模式：先把旧模式下的位置取出来，再改，再重建 */
function setMode(mode) {
  if (settings.mode === mode) return;
  const anchor = state.book ? currentAnchor() : 0;
  if (auto.on) stopAuto(true);
  settings.mode = mode;
  applySettings();
  applyMode(anchor);
}

/** 改字号/行距/边距后重排，位置不丢 */
function changeLayout(mutate) {
  const anchor = state.book ? currentAnchor() : 0;
  mutate();
  applySettings();
  if (state.book) renderChapter(state.idx, anchor);
}

/* ════════ 自动滚动 ════════ */
const AUTO_MIN = 8, AUTO_MAX = 180;
const auto = {
  on: false, paused: false, flipping: false,
  speed: 42, acc: 0, last: 0, raf: 0, resumeTimer: 0,
};

/* Pace 只认 scrollTop/scrollHeight/clientHeight，这里给它一个横向适配的替身 */
const paceView = {
  get scrollTop()    { return isPaged() ? $('#pageScroll').scrollLeft : $('#pageScroll').scrollTop; },
  get scrollHeight() { return isPaged() ? $('#pageScroll').scrollWidth : $('#pageScroll').scrollHeight; },
  get clientHeight() { return isPaged() ? $('#pageScroll').clientWidth : $('#pageScroll').clientHeight; },
  get innerText()    { return $('#page').innerText; },
};

function setAutoSpeed(v) {
  auto.speed = Math.max(AUTO_MIN, Math.min(AUTO_MAX, Math.round(v)));
  settings.autoSpeed = auto.speed;
  localStorage.setItem(LS.settings, JSON.stringify(settings));
  $('#autoSpeed').textContent = auto.speed;
  const bar = $('#autoBar');
  bar.classList.add('bump');
  setTimeout(() => bar.classList.remove('bump'), 200);
}

function renderAutoBtn() {
  $('#autoBtn').classList.toggle('on', auto.on);
  $('#autoPause').classList.toggle('paused', auto.paused);
  $('#autoPause').setAttribute('aria-label', auto.paused ? '继续' : '暂停');
  $('#autoPause').innerHTML = auto.paused
    ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l11 7-11 7z"/></svg>'
    : '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/></svg>';
}

function startAuto() {
  if (isPaged()) {
    toast('自动读只对滑动模式有效，已替你切过来', 2400);
    setMode('scroll');
  }
  if (auto.on) return;
  auto.on = true;
  auto.paused = false;
  auto.flipping = false;
  auto.acc = 0;
  auto.last = 0;
  setAutoSpeed(settings.autoSpeed || 42);
  $('#autoBar').hidden = false;
  renderAutoBtn();
  auto.raf = requestAnimationFrame(tickAuto);
}

function stopAuto(silent) {
  if (!auto.on) return;
  auto.on = false;
  auto.paused = false;
  cancelAnimationFrame(auto.raf);
  clearTimeout(auto.resumeTimer);
  $('#autoBar').hidden = true;
  renderAutoBtn();
  if (!silent) toast('已停止自动滚动', 1400);
}

/** 手势干预：碰到屏幕就暂停，手离开 3 秒后自己回来 */
function pauseAuto() {
  if (!auto.on) return;
  if (!auto.paused) { auto.paused = true; renderAutoBtn(); }
  clearTimeout(auto.resumeTimer);
  auto.resumeTimer = setTimeout(() => {
    if (auto.on && auto.paused) { auto.paused = false; renderAutoBtn(); }
  }, 3000);
}

function resumeAuto() {
  clearTimeout(auto.resumeTimer);
  if (!auto.on) return;
  auto.paused = false;
  renderAutoBtn();
}

function tickAuto(t) {
  if (!auto.on) return;
  const now = t || performance.now();
  if (!auto.last) auto.last = now;
  const dt = Math.min(120, now - auto.last);   // 从后台回来不要一下跳一大段
  auto.last = now;
  const sc = $('#pageScroll');

  if (!auto.paused && !auto.flipping) {
    auto.acc += auto.speed * dt / 1000;
    const dy = Math.floor(auto.acc);
    if (dy > 0) { auto.acc -= dy; sc.scrollTop += dy; }

    const max = sc.scrollHeight - sc.clientHeight;
    if (sc.scrollTop >= max - 1) {
      if (state.idx >= state.chapters.length - 1) {
        stopAuto();
        toast('全书读完了', 1800);
        return;
      }
      auto.flipping = true;                     // 章末停一下再翻，不然太刀了
      setTimeout(() => {
        if (!auto.on) return;
        auto.flipping = false;
        auto.acc = 0;
        nextChapter();
      }, 1000);
    }
  }
  auto.raf = requestAnimationFrame(tickAuto);
}

/* 触摸 / 滚轮 → 暂停 */
for (const ev of ['pointerdown', 'touchstart', 'touchmove', 'wheel']) {
  $('#pageScroll').addEventListener(ev, pauseAuto, { passive: true });
}
$('#autoPause').onclick = () => { auto.paused ? resumeAuto() : pauseAuto(); };
$('#autoSlower').onclick = () => setAutoSpeed(auto.speed - 8);
$('#autoFaster').onclick = () => setAutoSpeed(auto.speed + 8);
$('#autoClose').onclick = () => stopAuto();
$('#autoBtn').onclick = () => { auto.on ? stopAuto() : startAuto(); };

/* ════════ 进度 UI ════════ */
function updateProgressUI() {
  const r = scrollRatio();
  const pct = Math.round(r * 100);
  const paged = isPaged();

  $('#progressLabel').textContent = paged
    ? `第 ${state.idx + 1}/${state.chapters.length} 章 · ${currentPageIndex() + 1}/${pageCount()} 页`
    : `${state.idx + 1} / ${state.chapters.length} 章`;
  $('#progressFill').style.width = pct + '%';
  renderEta();

  if (state.book) {
    progress[state.book.id] = {
      off: currentAnchor(),          // 字符偏移：字号、模式、边距怎么变都不会丢
      chapter: state.idx,
      ratio: r,
      page: paged ? currentPageIndex() : 0,
      at: Date.now(),
    };
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
let snapTimer = 0;
$('#pageScroll').addEventListener('scroll', () => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    updateProgressUI();
    refreshBmBtn();
    // 自动落是机速不是人速，不计入 WPM 样本，免得污染你自己的阅读速度
    if (state.book && !auto.on) Pace.onScroll(paceView, state.book.id);

    // 翻页模式：手指拖到半页时，停下来自己吸附到最近的页
    if (isPaged()) {
      clearTimeout(snapTimer);
      snapTimer = setTimeout(() => {
        const sc = $('#pageScroll');
        const W = pageWidth();
        const target = Math.round(sc.scrollLeft / W) * W;
        if (Math.abs(sc.scrollLeft - target) > 1) sc.scrollLeft = target;
      }, 170);
    }
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

$('#fontMinus').onclick = () => changeLayout(() => { settings.fs = Math.max(13, settings.fs - 1); });
$('#fontPlus').onclick  = () => changeLayout(() => { settings.fs = Math.min(28, settings.fs + 1); });
$('#lineRange').oninput = e => changeLayout(() => { settings.lh = +e.target.value; });
$('#padRange').oninput  = e => changeLayout(() => { settings.pad = +e.target.value; });
$$('#fontSeg button').forEach(b => b.onclick = () => changeLayout(() => { settings.font = b.dataset.font; }));
$$('#themeSeg button').forEach(b => b.onclick = () => { settings.theme = b.dataset.theme; applySettings(); });
$$('#modeSeg button').forEach(b => b.onclick = () => setMode(b.dataset.mode));

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
  applyMode();                      // 先按设置把滑动/翻页的骨架搭好

  // 跟随系统：系统明暗变了就重算
  if (mqDark) {
    const onScheme = () => { if (settings.theme === 'auto') applySettings(); };
    if (mqDark.addEventListener) mqDark.addEventListener('change', onScheme);
    else if (mqDark.addListener) mqDark.addListener(onScheme);
  }

  // 转屏 / 改窗口：重排并回到原位置
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    if (!state.book) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const anchor = currentAnchor();
      if (isPaged()) { applyPagedMetrics(); buildPageAnchors(); }
      locateOffset(anchor);
      updateProgressUI();
    }, 160);
  });

  // 内置书（字数在打开后回填）
  state.books = BUILTIN.map(b => ({ ...b }));
  renderShelf();

  // 导入过的书
  const imported = await DB.all().catch(() => []);
  for (const rec of imported) {
    state.books.push({
      id: rec.id, title: rec.title, author: rec.author || '导入',
      chars: rec.text.length, text: rec.text, chapters: rec.chapters || null,
    });
  }

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
  if (auto.on) stopAuto(true);      // 否则它会继续滚一个已经藏起来的容器
  Pace.flush(state.book?.id);
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

/* 老 WebView 没有 Blob.arrayBuffer()/text()，用 FileReader 兜底 */
function readAsArrayBuffer(f) {
  if (f.arrayBuffer) return f.arrayBuffer();
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('读取失败'));
    r.readAsArrayBuffer(f);
  });
}
function readAsText(f) {
  if (f.text) return f.text();
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error || new Error('读取失败'));
    r.readAsText(f, 'utf-8');
  });
}

$('#fileInput').onchange = async e => {
  const files = [...(e.target.files || [])];
  if (!files.length) return;
  setImporting(true);
  let ok = 0, bad = 0, lastError = '';
  for (const f of files) {
    try {
      const isEpub = /\.epub$/i.test(f.name) || f.type === 'application/epub+zip';
      const id = 'u-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      let title, author, text, chapters = null;

      if (isEpub) {
        const book = await Epub.parse(await readAsArrayBuffer(f));
        const built = textFromEpubChapters(book.chapters);
        text = built.text;
        chapters = built.chapters;
        title = book.title || f.name.replace(/\.[^.]+$/, '');
        author = book.author || 'EPUB';
      } else {
        text = cleanText(await readAsText(f));
        title = f.name.replace(/\.(txt|text)$/i, '');
        author = '本地导入';
      }

      if (!text.trim()) { bad++; lastError = '没有可读的正文'; continue; }

      const rec = { id, title, author, text };
      if (chapters) rec.chapters = chapters;
      await DB.put(rec);
      state.books.push({ id, title, author, chars: text.length, text, chapters });
      ok++;
    } catch (err) {
      console.warn('import failed', f.name, err);
      bad++;
      lastError = `${f.name}：${err.message || err}`;
    }
  }
  setImporting(false);
  renderShelf();
  e.target.value = '';

  if (ok && !bad) toast(`已导入 ${ok} 本`, 2400);
  else if (ok && bad) toast(`已导入 ${ok} 本，${bad} 本失败`, 3200);
  else toast(lastError ? `导入失败：${lastError}` : '导入失败，请确认为 UTF-8 的 .txt 或标准 .epub', 3600);
};

let importing = false;
function setImporting(on) {
  importing = on;
  const btn = $('#importBtn');
  const sub = btn?.querySelector('.dock-sub');
  if (sub) sub.textContent = on ? '导入中…' : '本地 TXT';
  btn?.classList.toggle('busy', on);
}

// 键盘：方向键 / 空格翻页
const keyTarget = () => document.activeElement;
document.addEventListener('keydown', e => {
  if ($('#reader').hidden) return;
  const tag = keyTarget()?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) {
    e.preventDefault(); nextPage(); return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) {
    e.preventDefault(); prevPage(); return;
  }
  if (e.key === 'Escape') {
    if (!$('#drawer').hidden) return closeDrawer();
    if (!$('#sheet').hidden || !$('#statsSheet').hidden) return closeSheet();
    return;
  }
});

/* ════════ 三分区点击 ════════ */
const ZONE_LEFT = 0.3, ZONE_RIGHT = 0.3;
let tapStart = null, tapMoved = false;
const scEl = $('#pageScroll');

scEl.addEventListener('pointerdown', e => {
  tapStart = { x: e.clientX, y: e.clientY };
  tapMoved = false;
}, { passive: true });

scEl.addEventListener('pointermove', e => {
  if (!tapStart) return;
  if (Math.abs(e.clientX - tapStart.x) > 10 || Math.abs(e.clientY - tapStart.y) > 10) tapMoved = true;
}, { passive: true });

scEl.addEventListener('click', e => {
  if (e.target.closest('.end-cap button')) return;      // 章末按钮自己管
  if (tapMoved) { tapMoved = false; return; }           // 滑动不是点击
  const sel = window.getSelection && String(window.getSelection());
  if (sel && sel.trim()) return;                       // 选了字就不当翻页

  const r = scEl.getBoundingClientRect();
  const x = (e.clientX - r.left) / Math.max(1, r.width);
  if (x < ZONE_LEFT) prevPage();
  else if (x > 1 - ZONE_RIGHT) nextPage();
  else toggleChrome();
});

/* 启动 */
init().catch(err => {
  console.error(err);
  $('#shelfSub').textContent = '载入失败：' + err.message;
});
