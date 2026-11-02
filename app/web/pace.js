/* ══════════════════════════════════════════
   阅读时间引擎  pace.js
   ──────────────────────────────────────────
   · 冷启动用 550 字/分钟 兜底
   · 样本 = 一次连续阅读的"停留量"，停读 >2 分钟作废
   · 平滑 = 最近 8 个样本的加权平均（越近权重越高）
   · 逐章统计耗时，读完给章末小结
   ══════════════════════════════════════════ */

const Pace = (() => {
  const LS_PACE = 'reader.pace.v1';
  const LS_STAT = 'reader.stats.v1';

  const FALLBACK_WPM = 550;   // 冷启动兜底
  const IDLE_MS = 120000;     // 停顿超过 2 分钟 → 该样本作废
  const MIN_MS = 2000;        // 少于 2 秒的样本不要（防误触）
  const MIN_CHARS = 120;      // 少于 120 字的样本不要（滚动抖动）
  const WINDOW = 8;           // 平滑窗口
  const BUCKET_MS = 5000;     // 停留量采集粒度

  /* ── 持久化 ── */
  let store = JSON.parse(localStorage.getItem(LS_PACE) || '{}');
  // { bookId: { samples: [[chars, ms], ...] } }
  let stats = JSON.parse(localStorage.getItem(LS_STAT) || '{"days":{}}');
  // { days: { "2026-11-02": { ms, chars, books:{id:ms}, best:{wpm,hour} } } }

  const save = () => localStorage.setItem(LS_PACE, JSON.stringify(store));
  const saveStats = () => localStorage.setItem(LS_STAT, JSON.stringify(stats));

  /* ── 每本书的 WPM ── */
  function wpm(bookId) {
    const s = (store[bookId]?.samples || []).slice(-WINDOW);
    if (!s.length) return FALLBACK_WPM;
    let wsum = 0, w = 0;
    s.forEach(([chars, ms], i) => {
      const weight = i + 1;                 // 越近权重越高
      const v = (chars / (ms / 60000));
      if (!isFinite(v) || v <= 0) return;
      wsum += v * weight;
      w += weight;
    });
    if (!w) return FALLBACK_WPM;
    const out = wsum / w;
    return Math.max(120, Math.min(2200, out));   // 夹在合理区间
  }

  function isCold(bookId) {
    return !(store[bookId]?.samples || []).length;
  }

  function push(bookId, chars, ms) {
    if (ms < MIN_MS || chars < MIN_CHARS) return false;
    const v = chars / (ms / 60000);
    if (v < 60 || v > 4000) return false;         // 明显异常丢弃
    store[bookId] = store[bookId] || { samples: [] };
    store[bookId].samples.push([chars, ms]);
    if (store[bookId].samples.length > 40) store[bookId].samples.shift();
    save();
    noteDaily(chars, ms);
    return true;
  }

  /* ── 每日统计（时光轨迹） ── */
  function dayKey(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function noteDaily(chars, ms, bookId) {
    const k = dayKey();
    const d = stats.days[k] || { ms: 0, chars: 0, books: {}, best: null, chapters: 0 };
    d.ms += ms;
    d.chars += chars;
    if (bookId) d.books[bookId] = (d.books[bookId] || 0) + ms;
    const v = Math.round(chars / (ms / 60000));
    if (v > 0 && (!d.best || v > d.best.wpm)) d.best = { wpm: v, hour: new Date().getHours() };
    stats.days[k] = d;
    saveStats();
  }

  function addChapterDone(bookId) {
    const k = dayKey();
    const d = stats.days[k] || { ms: 0, chars: 0, books: {}, best: null, chapters: 0 };
    d.chapters = (d.chapters || 0) + 1;
    if (bookId) d.books[bookId] = (d.books[bookId] || 0) + 0;
    stats.days[k] = d;
    saveStats();
  }

  /* ── 周报 / 轨迹 ── */
  function weekSummary() {
    const out = { ms: 0, chars: 0, chapters: 0, books: {}, best: null, days: 0 };
    const now = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date(now.getTime() - i * 864e5);
      const rec = stats.days[dayKey(d)];
      if (!rec) continue;
      out.days++;
      out.ms += rec.ms;
      out.chars += rec.chars;
      out.chapters += rec.chapters || 0;
      for (const [bid, ms] of Object.entries(rec.books || {})) out.books[bid] = (out.books[bid] || 0) + ms;
      if (rec.best && (!out.best || rec.best.wpm > out.best.wpm)) out.best = rec.best;
    }
    return out;
  }

  /* ── 本次会话样本采集 ── */
  const session = {
    bookId: null,
    t0: 0,          // 上次采样时间
    y0: 0,          // 上次滚动位置
    charsAcc: 0,    // 本次样本累计"停留字数"
    startedAt: 0,   // 本轮起始时间
    chapterChars: 0,     // 本章已读字数
    chapterStart: 0,     // 本章开始时间
    chapterDone: false,
    bucket: null,
  };

  function contentChars(el) {
    return (el.innerText || '').replace(/\s/g, '').length;
  }

  function resetChapter(chars) {
    const now = Date.now();
    session.chapterChars = chars;
    session.chapterStart = now;
    session.chapterDone = false;
    session.t0 = now;
    session.y0 = 0;
    session.charsAcc = 0;
    session.startedAt = now;
  }

  /**
   * 滚动事件 → 计算"停留量"
   * 只有向下并且页面停留过一段时间的滚动才计入
   */
  function onScroll(el, bookId) {
    const now = Date.now();
    const y = el.scrollTop;
    const dy = y - session.y0;
    const dt = now - session.t0;

    if (session.bookId !== bookId) {
      session.bookId = bookId;
      session.t0 = now; session.y0 = y; session.charsAcc = 0; session.startedAt = now;
      return;
    }

    // 停顿超过阈值 → 作废本轮，重新起算
    if (dt > IDLE_MS) {
      session.t0 = now; session.y0 = y; session.charsAcc = 0; session.startedAt = now;
      return;
    }

    if (dy <= 0) { session.y0 = y; return; }   // 回滚不算

    const total = Math.max(1, el.scrollHeight - el.clientHeight || 1);
    const visible = contentChars(el);
    const pageChars = Math.max(1, visible);
    const charsScrolled = (dy / total) * visible;

    session.charsAcc += charsScrolled;
    session.chapterChars += charsScrolled;
    session.y0 = y;

    // 攒够 1 分钟内有效数据才落一个样本
    if (now - session.startedAt >= 60000) {
      const ok = push(bookId, session.charsAcc, now - session.startedAt);
      if (ok) {
        session.charsAcc = 0;
        session.startedAt = now;
      }
    }
    session.t0 = now;
  }

  /** 切章时结算：把上一章剩余的停留量作为一个样本 */
  function flush(bookId) {
    const now = Date.now();
    const dt = now - session.startedAt;
    if (session.charsAcc > 0 && dt < IDLE_MS) push(bookId, session.charsAcc, dt);
    session.charsAcc = 0;
    session.startedAt = now;
  }

  function chapterElapsed() {
    return Date.now() - session.chapterStart;
  }

  return {
    FALLBACK_WPM, IDLE_MS,
    wpm, isCold, noteDaily, addChapterDone, weekSummary, resetChapter,
    onScroll, flush, chapterElapsed, contentChars,
    session, store, stats, dayKey,
    allStats: () => stats,
  };
})();

/* ── 时间格式化 ── */
function fmtMin(min) {
  if (!isFinite(min) || min <= 0) return '不到 1 分钟';
  if (min < 1) return '不到 1 分钟';
  if (min < 60) return `约 ${Math.round(min)} 分钟`;
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return m ? `约 ${h} 小时 ${m} 分` : `约 ${h} 小时`;
}

function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m} 分 ${String(r).padStart(2, '0')} 秒`;
}

function fmtHours(ms) {
  const h = ms / 3600000;
  if (h < 1) return `${Math.round(ms / 60000)} 分钟`;
  return `${h.toFixed(1).replace(/\.0$/, '')} 小时`;
}
