#!/usr/bin/env node
/* ══════════════════════════════════════════
   epub.js 单测：零依赖，只用 Node 自带模块
   运行：node tests/epub.test.js
   ──────────────────────────────────────────
   重点守两件事：
   1. 自己写的 raw inflate 与 zlib 结果逐字节一致
   2. zip 目录解析取出来的文件与写入时一致
   ══════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const Epub = require(path.join(__dirname, '..', 'app', 'web', 'epub.js'));

let pass = 0, fail = 0;
const ok = n => { pass++; console.log('  ✓ ' + n); };
const bad = (n, e) => { fail++; console.log('  ✗ ' + n + (e ? '  → ' + e : '')); };

/* ── 极简 zip 写入器（只为造样本） ── */
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content, method] of entries) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const raw = Buffer.from(content);
    const data = method === 8 ? zlib.deflateRawSync(raw, { level: 9 }) : raw;
    const crc = zlib.crc32 ? zlib.crc32(raw) : crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const cenBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, cenBuf, eocd]);
}

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/* ══════════ 1. inflate ══════════ */
console.log('\n[1] raw inflate 对照 zlib');
const samples = {
  '短文本': Buffer.from('hello 世界'),
  '中文长文': Buffer.from('春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。\n'.repeat(400)),
  '全零 64KB': Buffer.alloc(65536, 0),
  '高重复 200KB': Buffer.from('A'.repeat(200000)),
  '随机 100KB': Buffer.from(Array.from({ length: 100000 }, (_, i) => (i * 2654435761) & 0xFF)),
};

for (const [name, raw] of Object.entries(samples)) {
  for (const level of [0, 1, 6, 9]) {
    let out;
    try {
      out = Buffer.from(Epub.inflateRaw(new Uint8Array(zlib.deflateRawSync(raw, { level }))));
    } catch (e) {
      bad(`${name} level=${level}`, e.message);
      continue;
    }
    out.equals(raw)
      ? ok(`${name} level=${level} (${raw.length}B)`)
      : bad(`${name} level=${level}`, `长度 ${out.length} vs ${raw.length}`);
  }
}

/* ══════════ 2. zip ══════════ */
console.log('\n[2] zip 目录与解包');
const entries = [
  ['mimetype', 'application/epub+zip', 0],
  ['META-INF/container.xml', '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>', 8],
  ['OEBPS/content.opf', '<?xml version="1.0"?><package><metadata><dc:title>书</dc:title></metadata></package>', 8],
  ['OEBPS/text/ch1.xhtml', '<html><body><p>正文一</p></body></html>', 8],
  ['OEBPS/text/空.txt', '', 8],
];
const zipBuf = makeZip(entries);
let zip;
try {
  zip = Epub.unzip(new Uint8Array(zipBuf));
  ok(`解开 ${zip.names.length} 个条目`);
} catch (e) {
  bad('unzip 抛错', e.message);
}

if (zip) {
  for (const [name, content] of entries) {
    let got;
    try {
      got = Buffer.from(zip.bytes(name)).toString('utf-8');
    } catch (e) {
      bad(name, e.message);
      continue;
    }
    got === content ? ok(`${name} 内容一致`) : bad(name, JSON.stringify(got.slice(0, 40)));
  }
  zip.find(/\.opf$/i) === 'OEBPS/content.opf' ? ok('find() 能定位 OPF') : bad('find() 定位 OPF');
  zip.has('不存在的文件') === false ? ok('has() 对缺失文件返回 false') : bad('has()');
}

/* ══════════ 3. 异常输入 ══════════ */
console.log('\n[3] 异常输入');
try {
  Epub.unzip(new Uint8Array([1, 2, 3, 4, 5]));
  bad('垃圾数据应当抛错');
} catch (e) {
  ok('垃圾数据抛出可读错误：' + e.message);
}

try {
  Epub.inflateRaw(new Uint8Array([0xFF, 0xFF, 0xFF]));
  bad('损坏的 deflate 应当抛错');
} catch (e) {
  ok('损坏数据抛出可读错误');
}

/* ══════════ 4. 源码约束 ══════════ */
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'web', 'epub.js'), 'utf-8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/const Epub = \(\(\) =>/.test(src) ? ok('浏览器端以 const Epub 全局暴露') : bad('全局暴露形式');
!/DecompressionStream\s*\(/.test(code) ? ok('不调用 DecompressionStream（老 WebView 可用）') : bad('调用了 DecompressionStream');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
