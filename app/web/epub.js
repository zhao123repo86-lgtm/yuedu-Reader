/* ══════════════════════════════════════════
   EPUB 解析  epub.js
   ──────────────────────────────────────────
   零依赖：自带 zip 目录解析 + raw DEFLATE 解压，
   不依赖 DecompressionStream（老 WebView 没有）。

   输出统一成纯文本章节：
     { title, author, chapters: [{ title, text }] }
   这样排版、进度、WPM、自动滚动全部复用原有逻辑。
   ══════════════════════════════════════════ */

const Epub = (() => {

  /* ─────────── 长度 / 距离表（RFC 1951） ─────────── */
  const LEN_BASE  = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  const LEN_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const DIST_BASE  = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  const DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  const CL_ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

  /* ─────────── raw DEFLATE 解压 ─────────── */
  function inflateRaw(src) {
    let pos = 0, bitBuf = 0, bitCnt = 0;
    let out = new Uint8Array(Math.max(4096, (src.length * 4) | 0));
    let olen = 0;

    const grow = n => {
      if (olen + n <= out.length) return;
      let cap = out.length;
      while (cap < olen + n) cap *= 2;
      const bigger = new Uint8Array(cap);
      bigger.set(out.subarray(0, olen));
      out = bigger;
    };
    const bits = n => {
      while (bitCnt < n) {
        if (pos >= src.length) throw new Error('解压数据不完整');
        bitBuf |= src[pos++] << bitCnt;
        bitCnt += 8;
      }
      const v = bitBuf & ((1 << n) - 1);
      bitBuf >>>= n;
      bitCnt -= n;
      return v;
    };

    /* 规范哈夫曼表 */
    function makeHuff(lengths) {
      let maxBits = 15;
      const counts = new Uint16Array(16);
      for (let i = 0; i < lengths.length; i++) if (lengths[i]) counts[lengths[i]]++;
      while (maxBits > 0 && !counts[maxBits]) maxBits--;
      if (maxBits === 0) return null;
      const offs = new Uint16Array(17);
      for (let b = 1; b <= 15; b++) offs[b + 1] = offs[b] + counts[b];
      const symbols = new Uint16Array(lengths.length);
      for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
      return { counts, symbols, maxBits };
    }
    function decodeSym(h) {
      let code = 0, first = 0, index = 0;
      for (let len = 1; len <= h.maxBits; len++) {
        code |= bits(1);
        const count = h.counts[len];
        if (count && code - first < count) return h.symbols[index + (code - first)];
        index += count;
        first = (first + count) << 1;
        code <<= 1;
      }
      throw new Error('无效的哈夫曼编码');
    }

    /* 固定表 */
    let FIXED_LIT = null, FIXED_DIST = null;
    function fixedTables() {
      if (FIXED_LIT) return;
      const lit = new Uint8Array(288);
      for (let i = 0; i < 144; i++) lit[i] = 8;
      for (let i = 144; i < 256; i++) lit[i] = 9;
      for (let i = 256; i < 280; i++) lit[i] = 7;
      for (let i = 280; i < 288; i++) lit[i] = 8;
      FIXED_LIT = makeHuff(lit);
      const dist = new Uint8Array(30).fill(5);
      FIXED_DIST = makeHuff(dist);
    }

    let last = 0;
    do {
      last = bits(1);
      const type = bits(2);

      if (type === 0) {
        /* 存储块：丢弃当前字节剩余位 */
        bitBuf = 0; bitCnt = 0;
        const len  = src[pos] | (src[pos + 1] << 8);
        const nlen = src[pos + 2] | (src[pos + 3] << 8);
        pos += 4;
        if (((len ^ 0xFFFF) & 0xFFFF) !== nlen) throw new Error('存储块长度校验失败');
        grow(len);
        out.set(src.subarray(pos, pos + len), olen);
        olen += len;
        pos += len;
        continue;
      }

      let lit, dist;
      if (type === 1) {
        fixedTables();
        lit = FIXED_LIT; dist = FIXED_DIST;
      } else if (type === 2) {
        const hlit = bits(5) + 257;
        const hdist = bits(5) + 1;
        const hclen = bits(4) + 4;
        const clLens = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) clLens[CL_ORDER[i]] = bits(3);
        const clHuff = makeHuff(clLens);
        if (!clHuff) throw new Error('码长表为空');

        const lens = new Uint8Array(hlit + hdist);
        let i = 0;
        while (i < lens.length) {
          const sym = decodeSym(clHuff);
          if (sym < 16) lens[i++] = sym;
          else if (sym === 16) {
            if (i === 0) throw new Error('重复码缺少前值');
            const prev = lens[i - 1];
            let r = 3 + bits(2);
            while (r-- && i < lens.length) lens[i++] = prev;
          } else if (sym === 17) {
            let r = 3 + bits(3);
            while (r-- && i < lens.length) lens[i++] = 0;
          } else {
            let r = 11 + bits(7);
            while (r-- && i < lens.length) lens[i++] = 0;
          }
        }
        lit  = makeHuff(lens.subarray(0, hlit));
        dist = makeHuff(lens.subarray(hlit));
        if (!lit) throw new Error('字面量表为空');
      } else {
        throw new Error('未知的压缩块类型');
      }

      for (;;) {
        const sym = decodeSym(lit);
        if (sym === 256) break;
        if (sym < 256) {
          grow(1);
          out[olen++] = sym;
        } else {
          const li = sym - 257;
          if (li >= 29) throw new Error('无效的长度码');
          const len = LEN_BASE[li] + (LEN_EXTRA[li] ? bits(LEN_EXTRA[li]) : 0);
          if (!dist) throw new Error('缺少距离表');
          const ds = decodeSym(dist);
          if (ds >= 30) throw new Error('无效的距离码');
          const d = DIST_BASE[ds] + (DIST_EXTRA[ds] ? bits(DIST_EXTRA[ds]) : 0);
          if (d > olen) throw new Error('距离超出已解压范围');
          grow(len);
          for (let k = 0; k < len; k++, olen++) out[olen] = out[olen - d];
        }
      }
    } while (!last);

    return out.subarray(0, olen);
  }

  /* ─────────── UTF-8 ─────────── */
  const TD = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  function utf8(bytes) {
    if (TD) return TD.decode(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    try { return decodeURIComponent(escape(s)); } catch { return s; }
  }

  /* ─────────── zip 目录 ─────────── */
  function unzip(bin) {
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    let eocd = -1;
    const floor = Math.max(0, bin.length - 65558);
    for (let i = bin.length - 22; i >= floor; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 EPUB（找不到 zip 目录）');

    const total = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const files = new Map();

    for (let n = 0; n < total; n++) {
      if (off + 46 > bin.length || dv.getUint32(off, true) !== 0x02014b50) break;
      const flags  = dv.getUint16(off + 8, true);
      const method = dv.getUint16(off + 10, true);
      const csize  = dv.getUint32(off + 20, true);
      const nlen   = dv.getUint16(off + 28, true);
      const elen   = dv.getUint16(off + 30, true);
      const clen   = dv.getUint16(off + 32, true);
      const lho    = dv.getUint32(off + 42, true);
      const name   = utf8(bin.subarray(off + 46, off + 46 + nlen));
      off += 46 + nlen + elen + clen;
      if (!name || name.endsWith('/')) continue;

      let csizeFinal = csize;
      if (flags & 0x08 || csizeFinal === 0) csizeFinal = bin.length - lho;
      if (lho + 30 > bin.length) continue;
      const lnlen = dv.getUint16(lho + 26, true);
      const lelen = dv.getUint16(lho + 28, true);
      const dataStart = lho + 30 + lnlen + lelen;
      files.set(name, { method, data: bin.subarray(dataStart, Math.min(bin.length, dataStart + csizeFinal)) });
    }

    return {
      names: [...files.keys()],
      has: n => files.has(n),
      find: re => [...files.keys()].find(n => re.test(n)),
      bytes(n) {
        const f = files.get(n);
        if (!f) return null;
        if (f.method === 0) return f.data;
        if (f.method === 8) return inflateRaw(f.data);
        throw new Error('不支持的压缩方式：' + f.method);
      },
      text(n) { const b = this.bytes(n); return b ? utf8(b) : null; },
    };
  }

  /* ─────────── 路径工具 ─────────── */
  const dirOf = p => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); };
  function resolve(base, href) {
    if (!href) return '';
    href = href.split('#')[0];
    try { href = decodeURIComponent(href); } catch { /* 保留原样 */ }
    if (href.startsWith('/')) return href.slice(1);
    const stack = (base + href).split('/');
    const out = [];
    for (const seg of stack) {
      if (!seg || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return out.join('/');
  }
  const xml = s => (typeof DOMParser !== 'undefined')
    ? new DOMParser().parseFromString(s, 'application/xml')
    : null;

  /* ─────────── XHTML → 段落数组 ─────────── */
  const BLOCK = /^(p|div|br|h[1-6]|li|ul|ol|blockquote|section|article|tr|td|th|table|hr|pre|figure|figcaption|dd|dt|center)$/;

  function htmlToBlocks(html) {
    if (typeof DOMParser === 'undefined') {
      /* 兜底：没有 DOM 时按标签切段 */
      return html
        .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|section)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,head,title,svg,img,audio,video,iframe,math').forEach(n => n.remove());

    const blocks = [];
    let cur = '';
    const flush = () => {
      const s = cur.replace(/[\s\u00a0]+/g, ' ').trim();
      if (s) blocks.push(s);
      cur = '';
    };
    const walk = node => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {                 // 文本
          cur += child.nodeValue.replace(/[\s\u00a0]+/g, ' ');
        } else if (child.nodeType === 1) {          // 元素
          const tag = child.tagName.toLowerCase();
          if (tag === 'br') { flush(); continue; }
          if (tag === 'hr') { flush(); continue; }
          if (BLOCK.test(tag)) { flush(); walk(child); flush(); }
          else walk(child);
        }
      }
    };
    if (doc.body) walk(doc.body);
    flush();
    return blocks;
  }

  function firstHeading(html) {
    const m = /<h[1-3][^>]*>([\s\S]{0,200}?)<\/h[1-3]>/i.exec(html);
    if (!m) return '';
    return m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  /* ─────────── 目录（ncx / nav） ─────────── */
  function tocMap(zip, opfDoc, opfPath) {
    const map = {};
    const add = (src, label) => {
      if (!src || !label) return;
      const key = resolve(dirOf(opfPath), src);
      if (key && !map[key]) map[key] = label.replace(/\s+/g, ' ').trim().slice(0, 60);
    };

    /* EPUB2: toc.ncx */
    const ncxPath = zip.find(/\.ncx$/i);
    if (ncxPath) {
      const doc = xml(zip.text(ncxPath));
      if (doc) {
        doc.querySelectorAll('navPoint').forEach(np => {
          const label = np.querySelector('navLabel > text');
          const content = np.querySelector('content');
          if (label && content) add(content.getAttribute('src'), label.textContent);
        });
      }
    }

    /* EPUB3: nav.xhtml */
    if (!Object.keys(map).length) {
      const navPath = zip.find(/(^|\/)nav\.x?html$/i) || zip.find(/toc\.x?html$/i);
      if (navPath) {
        const doc = xml(zip.text(navPath));
        if (doc) {
          doc.querySelectorAll('nav a, a').forEach(a => {
            const href = a.getAttribute('href');
            if (href) add(href, a.textContent);
          });
        }
      }
    }
    return map;
  }

  /* ─────────── 主入口 ─────────── */
  async function parse(input) {
    const bin = input instanceof Uint8Array ? input : new Uint8Array(input);
    const zip = unzip(bin);

    /* 1. container.xml → OPF */
    let opfPath = null;
    const container = zip.text('META-INF/container.xml');
    if (container) {
      const m = /full-path\s*=\s*"([^"]+)"/i.exec(container)
             || /full-path\s*=\s*'([^']+)'/i.exec(container);
      if (m) opfPath = m[1];
    }
    if (!opfPath) opfPath = zip.find(/\.opf$/i);
    if (!opfPath) throw new Error('EPUB 缺少 OPF 文件');

    const opfText = zip.text(opfPath);
    if (!opfText) throw new Error('无法读取 OPF：' + opfPath);

    /* 2. 元数据 + manifest + spine */
    const meta = {
      title: (/(?:dc:)?title[^>]*>([\s\S]*?)<\/(?:dc:)?title>/i.exec(opfText) || [, ''])[1],
      author: (/(?:dc:)?creator[^>]*>([\s\S]*?)<\/(?:dc:)?creator>/i.exec(opfText) || [, ''])[1],
    };
    const strip = s => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

    const manifest = {};
    const itemRe = /<(?:\w+:)?item\b([^>]*)\/?>/gi;
    let m;
    while ((m = itemRe.exec(opfText))) {
      const attrs = m[1];
      const id   = (/\bid\s*=\s*"([^"]*)"/i.exec(attrs) || [, ''])[1];
      const href = (/\bhref\s*=\s*"([^"]*)"/i.exec(attrs) || [, ''])[1];
      const type = (/\bmedia-type\s*=\s*"([^"]*)"/i.exec(attrs) || [, ''])[1];
      if (id && href) manifest[id] = { href, type };
    }

    const order = [];
    const refRe = /<(?:\w+:)?itemref\b([^>]*)\/?>/gi;
    while ((m = refRe.exec(opfText))) {
      const idref = (/\bidref\s*=\s*"([^"]*)"/i.exec(m[1]) || [, ''])[1];
      if (idref && manifest[idref]) order.push(manifest[idref]);
    }
    if (!order.length) {
      /* 没有 spine：退回 manifest 里所有 xhtml */
      for (const it of Object.values(manifest)) {
        if (/html/i.test(it.type)) order.push(it);
      }
    }
    if (!order.length) throw new Error('EPUB 里没有可读的正文');

    /* 3. 目录表 */
    const labels = tocMap(zip, xml(opfText), opfPath);

    /* 4. 逐篇取文本 */
    const chapters = [];
    const base = dirOf(opfPath);
    for (const item of order) {
      const path = resolve(base, item.href);
      const html = zip.text(path);
      if (!html) continue;
      const blocks = htmlToBlocks(html);
      if (!blocks.length) continue;

      const title = labels[path] || firstHeading(html) || `第 ${chapters.length + 1} 节`;
      /* 若首段就是标题本身，去掉重复 */
      if (blocks.length > 1 && blocks[0].replace(/\s+/g, '') === title.replace(/\s+/g, '')) blocks.shift();

      chapters.push({ title: title.slice(0, 60), text: blocks.join('\n') });
    }
    if (!chapters.length) throw new Error('EPUB 正文为空');

    return {
      title: strip(meta.title) || '未命名',
      author: strip(meta.author) || 'EPUB',
      chapters,
    };
  }

  return { parse, unzip, inflateRaw };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Epub;
