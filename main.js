// 玻璃水印 v2 —— 胶囊版型 + 真折射 + 机型参数
// 玻璃不是叠一层模糊：按胶囊的 SDF 梯度对背后每个像素做位移采样，
// RGB 各自偏移一点做色散，再叠表面染色、边缘高光和文字。

import { createGlassRenderer } from './glass-gl.js';
import { createEnhancer } from './enhance-gl.js';
import { attachSpringPress } from './spring.js';

const $ = (s) => document.querySelector(s);

// GPU 玻璃：拿不到 WebGL2 就退回 CPU 版本
let glassGL = null;
try { glassGL = createGlassRenderer(); } catch { glassGL = null; }

let enhancer = null;
try { enhancer = createEnhancer(); } catch { enhancer = null; }


const MAX_EDGE = 2560;
const DESIGN_W = 1290;
const FONT = 'system-ui, -apple-system, "SF Pro Display", "SF Pro Text", "PingFang SC", sans-serif';
const SPACING_SUPPORTED = (() => {
  try { return 'letterSpacing' in document.createElement('canvas').getContext('2d'); } catch { return false; }
})();

// iOS 的字距是收着的：大字号用负字距，小字几乎为零
function setFont(ctx, weight, size, tight = 0) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  if (SPACING_SUPPORTED) ctx.letterSpacing = `${(-size * tight).toFixed(2)}px`;
}
const APPLE_GLYPH = '\uF8FF';

// ---------------------------------------------------------------- 机型

const MODELS = [
  {
    id: '15pm', name: 'iPhone 15 Pro Max', note: '5× 四棱镜长焦',
    lenses: [
      { zoom: '0.5×', focal: 13, f: 2.2 },
      { zoom: '1×', focal: 24, f: 1.78 },
      { zoom: '5×', focal: 120, f: 2.8 },
    ],
    def: 2,
  },
  {
    id: '16pm', name: 'iPhone 16 Pro Max', note: '5× 四棱镜长焦',
    lenses: [
      { zoom: '0.5×', focal: 13, f: 2.2 },
      { zoom: '1×', focal: 24, f: 1.78 },
      { zoom: '5×', focal: 120, f: 2.8 },
    ],
    def: 2,
  },
  {
    id: '17pm', name: 'iPhone 17 Pro Max', note: '4× 100mm，8× 200mm',
    lenses: [
      { zoom: '0.5×', focal: 13, f: 2.2 },
      { zoom: '1×', focal: 24, f: 1.78 },
      { zoom: '2×', focal: 48, f: 1.78 },
      { zoom: '4×', focal: 100, f: 2.8 },
      { zoom: '8×', focal: 200, f: 2.8 },
    ],
    def: 3,
  },
  {
    id: '18pm', name: 'iPhone 18 Pro Max', note: '主摄可变光圈 ƒ/1.48–4.0',
    lenses: [
      { zoom: '0.5×', focal: 13, f: 2.2 },
      { zoom: '1×', focal: 24, f: 1.48 },
      { zoom: '2×', focal: 48, f: 1.48 },
      { zoom: '4×', focal: 100, f: 2.8 },
      { zoom: '8×', focal: 200, f: 2.8 },
    ],
    def: 3,
  },
];

// ---------------------------------------------------------------- 状态

const state = {
  model: 'auto',
  lens: 0,
  showGps: true,
  enhance: true,
  glass: {
    refract: 45,    // 折射强度 0–200
    thickness: 90,  // 厚度 / 弯折边带宽度 0–200
    blur: 30,       // 模糊 0–200
    disp: 100,      // 色散 0–200（库是开关）
    tint: 18,       // 浓度（表面色）0–200
    scale: 100,     // 大小 60–140
    dx: 0,          // 左右 −80–80
    dy: 0,          // 上下 −120–120
  },
};

const STORE_KEY = 'watermark.v8';

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      model: state.model, lens: state.lens, showGps: state.showGps, enhance: state.enhance, glass: state.glass,
    }));
  } catch { /* 存不下就算了 */ }
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (!saved) return;
    if (saved.model) state.model = saved.model;
    if (typeof saved.lens === 'number') state.lens = saved.lens;
    if (typeof saved.showGps === 'boolean') state.showGps = saved.showGps;
    if (typeof saved.enhance === 'boolean') state.enhance = saved.enhance;
    if (saved.glass) {
      for (const c of CTRLS) {
        const v = Number(saved.glass[c.key]);
        if (Number.isFinite(v)) state.glass[c.key] = Math.min(c.max, Math.max(c.min, v));
      }
    }
  } catch { /* 用默认值 */ }
}

const stage = {
  empty: $('#empty'),
  edit: $('#edit'),
  sheet: $('#sheet'),
  modelSheet: $('#modelSheet'),
  adjSheet: $('#adjSheet'),
  wrap: $('#photoWrap'),
  result: $('#result'),
  toast: $('#toast'),
};

let photo = null;
let outCanvas = null;
let toastTimer = 0;

// ---------------------------------------------------------------- EXIF

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function readValues(dv, off, type, count, le) {
  if (type === 2) {
    let s = '';
    for (let i = 0; i < count; i++) {
      const c = dv.getUint8(off + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    if (type === 1 || type === 7) out.push(dv.getUint8(off + i));
    else if (type === 3) out.push(dv.getUint16(off + i * 2, le));
    else if (type === 4) out.push(dv.getUint32(off + i * 4, le));
    else if (type === 9) out.push(dv.getInt32(off + i * 4, le));
    else if (type === 5) out.push([dv.getUint32(off + i * 8, le), dv.getUint32(off + i * 8 + 4, le)]);
    else if (type === 10) out.push([dv.getInt32(off + i * 8, le), dv.getInt32(off + i * 8 + 4, le)]);
    else return undefined;
  }
  return out;
}

function readIfd(dv, ifd, tiffStart, le) {
  const u16 = (o) => dv.getUint16(o, le);
  const u32 = (o) => dv.getUint32(o, le);
  const out = {};
  if (ifd + 2 > dv.byteLength) return out;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > dv.byteLength) break;
    const tag = u16(e);
    const type = u16(e + 2);
    const n = u32(e + 4);
    const size = (TYPE_SIZE[type] || 1) * n;
    const vOff = size <= 4 ? e + 8 : tiffStart + u32(e + 8);
    if (vOff + size > dv.byteLength) continue;
    const v = readValues(dv, vOff, type, n, le);
    if (v !== undefined) out[tag] = v;
  }
  return out;
}

function readTiff(dv, start) {
  const le = dv.getUint16(start) === 0x4949;
  const u32 = (o) => dv.getUint32(o, le);
  if (dv.getUint16(start + 2, le) !== 0x002a) return {};
  const t0 = readIfd(dv, start + u32(start + 4), start, le);
  const exifPtr = Array.isArray(t0[0x8769]) ? t0[0x8769][0] : null;
  const gpsPtr = Array.isArray(t0[0x8825]) ? t0[0x8825][0] : null;
  const t1 = exifPtr ? readIfd(dv, start + exifPtr, start, le) : {};
  const tg = gpsPtr ? readIfd(dv, start + gpsPtr, start, le) : {};

  const num = (v) => (Array.isArray(v) && v.length ? (Array.isArray(v[0]) ? v[0][0] / v[0][1] : v[0]) : null);
  const str = (v) => (typeof v === 'string' ? v : null);

  let gps = null;
  const latRef = str(tg[1]);
  const lonRef = str(tg[3]);
  if (latRef && tg[2] && tg[2].length === 3 && lonRef && tg[4] && tg[4].length === 3) {
    gps = { lat: dms(tg[2]), lon: dms(tg[4]), latRef, lonRef };
  }

  return {
    make: str(t0[0x010f]),
    model: str(t0[0x0110]),
    date: str(t1[0x9003]) || str(t0[0x0132]),
    fNumber: num(t1[0x829d]),
    exposure: num(t1[0x829a]),
    iso: num(t1[0x8827]),
    focal: num(t1[0x920a]),
    focal35: num(t1[0xa405]),
    gps,
  };
}

function parseExif(buffer) {
  const dv = new DataView(buffer);
  if (dv.byteLength < 32 || dv.getUint16(0) !== 0xffd8) return {};
  let off = 2;
  const len = dv.byteLength;
  while (off + 4 <= len) {
    if (dv.getUint8(off) !== 0xff) { off++; continue; }
    const marker = dv.getUint8(off + 1);
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    if (marker === 0xda) break;
    const size = dv.getUint16(off + 2);
    if (marker === 0xe1 && off + 10 <= len && dv.getUint32(off + 4) === 0x45786966) {
      return readTiff(dv, off + 10);
    }
    if (size < 2) break;
    off += 2 + size;
  }
  return {};
}

function dms(parts) {
  return {
    deg: parts[0][0] / parts[0][1] || 0,
    min: parts[1][0] / parts[1][1] || 0,
    sec: parts[2][0] / parts[2][1] || 0,
  };
}

// ---------------------------------------------------------------- 格式化

function fmtDate(raw) {
  if (!raw) return '';
  const m = String(raw).match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (m) return `${m[1]}.${m[2]}.${m[3]} ${m[4]}`;
  const d = new Date(raw);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtNumber(v, digits) {
  return v.toFixed(digits).replace(/\.?0+$/, '');
}

function fmtExposure(v) {
  if (!v) return '';
  if (v >= 1) return `${fmtNumber(v, 1)}s`;
  return `1/${Math.round(1 / v)}s`;
}

function fmtCoord(c, ref) {
  if (!c) return '';
  let sec = Math.round(c.sec);
  let min = Math.floor(c.min);
  if (sec === 60) { sec = 0; min += 1; }
  return `${Math.floor(c.deg)}°${min}'${sec}"${ref}`;
}

function currentLens() {
  const m = MODELS.find((x) => x.id === state.model);
  if (!m) return null;
  return m.lenses[state.lens] || m.lenses[m.def];
}

function buildMeta() {
  const exif = (photo && photo.exif) || {};
  let device = exif.model || exif.make || 'iPhone';
  let focal = exif.focal35 || exif.focal || 0;
  let fnum = exif.fNumber || 0;

  if (state.model !== 'auto') {
    const m = MODELS.find((x) => x.id === state.model);
    const lens = currentLens();
    if (m && lens) {
      device = m.name;
      focal = lens.focal;
      fnum = lens.f;
    }
  }

  const parts = [];
  if (focal) parts.push(`${Math.round(focal)}mm`);
  if (fnum) parts.push(`f/${fmtNumber(fnum, 2)}`);
  const ex = fmtExposure(exif.exposure);
  if (ex) parts.push(ex);
  if (exif.iso) parts.push(`ISO${Math.round(exif.iso)}`);

  let gps = '';
  if (exif.gps) gps = `${fmtCoord(exif.gps.lat, exif.gps.latRef)} ${fmtCoord(exif.gps.lon, exif.gps.lonRef)}`;

  return { device, date: fmtDate(exif.date) || fmtDate(new Date().toISOString()), params: parts.join(' '), gps };
}

// ---------------------------------------------------------------- 画布缓存

const cache = { key: null, blurKey: null, W: 0, H: 0, base: null, bctx: null, blur: null };

function ensureBase() {
  if (!photo) return;
  if (cache.key === photo) return;
  const img = photo.img;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const s = Math.min(1, MAX_EDGE / Math.max(iw, ih));
  const W = Math.max(1, Math.round(iw * s));
  const H = Math.max(1, Math.round(ih * s));

  const base = document.createElement('canvas');
  base.width = W; base.height = H;
  const bctx = base.getContext('2d', { willReadFrequently: true });
  bctx.drawImage(img, 0, 0, W, H);

  cache.key = photo;
  cache.W = W; cache.H = H;
  cache.raw = base; cache.bctx = bctx;
  rebuildBase();
}

// 增强画质：在原始像素上跑一遍 unsharp + 局部对比，再作为新的底图
function rebuildBase() {
  if (!cache.raw) return;
  cache.base = cache.raw;
  if (state.enhance && enhancer) {
    try {
      const out = enhancer.run(cache.raw, { amount: 0.85, contrast: 0.06 });
      const copy = document.createElement('canvas');
      copy.width = out.width;
      copy.height = out.height;
      copy.getContext('2d').drawImage(out, 0, 0);
      cache.base = copy;
    } catch {
      cache.base = cache.raw;
    }
  }
  cache.blur = null;
  cache.blurKey = null;
}

// 三次 box blur 近似 Gaussian。ctx.filter 在这个 WebKit 里是"接受但无效"，
// 所以只能自己算：先在缩小图上模糊，再放大回来（省一个数量级的时间）。
function boxBlur(src, w, h, r) {
  if (r < 1) return;
  const tmp = new Float32Array(w * h * 4);
  const scale = 1 / (r * 2 + 1);

  // 横向
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += src[(row + Math.min(w - 1, Math.max(0, x))) * 4 + c];
      for (let x = 0; x < w; x++) {
        tmp[(row + x) * 4 + c] = sum * scale;
        const add = Math.min(w - 1, x + r + 1);
        const sub = Math.max(0, x - r);
        sum += src[(row + add) * 4 + c] - src[(row + sub) * 4 + c];
      }
    }
  }

  // 纵向
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += tmp[(Math.min(h - 1, Math.max(0, y)) * w + x) * 4 + c];
      for (let y = 0; y < h; y++) {
        src[(y * w + x) * 4 + c] = sum * scale;
        const add = Math.min(h - 1, y + r + 1);
        const sub = Math.max(0, y - r);
        sum += tmp[(add * w + x) * 4 + c] - tmp[(sub * w + x) * 4 + c];
      }
    }
  }
}

function ensureBlur(radiusPx) {
  const key = Math.max(0, Math.round(radiusPx));
  if (cache.blur && cache.blurKey === key) return cache.blur;
  const { W, H, base } = cache;

  const blur = document.createElement('canvas');
  blur.width = W; blur.height = H;
  const bc = blur.getContext('2d', { willReadFrequently: true });
  bc.imageSmoothingQuality = 'high';

  if (key < 1) {
    bc.drawImage(base, 0, 0, W, H);
  } else {
    // 缩小倍数：半径越大越激进，保证模糊核在低分辨率上足够大
    const f = Math.max(2, Math.min(8, Math.round(key / 2) + 1));
    const sw = Math.max(1, Math.round(W / f));
    const sh = Math.max(1, Math.round(H / f));
    const small = document.createElement('canvas');
    small.width = sw; small.height = sh;
    const sc = small.getContext('2d', { willReadFrequently: true });
    sc.imageSmoothingQuality = 'high';
    sc.drawImage(base, 0, 0, sw, sh);

    const img = sc.getImageData(0, 0, sw, sh);
    const r = Math.max(1, Math.round(key / f));
    boxBlur(img.data, sw, sh, r);
    boxBlur(img.data, sw, sh, r);
    boxBlur(img.data, sw, sh, r);
    sc.putImageData(img, 0, 0);

    bc.drawImage(small, 0, 0, W, H);
  }

  cache.blur = blur;
  cache.blurKey = key;
  return blur;
}

// ---------------------------------------------------------------- 玻璃

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function sdRound(px, py, hw, hh, r) {
  const qx = Math.abs(px) - hw + r;
  const qy = Math.abs(py) - hh + r;
  const ax = qx > 0 ? qx : 0;
  const ay = qy > 0 ? qy : 0;
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function gradRound(px, py, hw, hh, r) {
  const qx = Math.abs(px) - (hw - r);
  const qy = Math.abs(py) - (hh - r);
  if (qx < 0 && qy < 0) {
    return qx > qy
      ? { x: Math.sign(px) || 1, y: 0 }
      : { x: 0, y: Math.sign(py) || 1 };
  }
  const vx = Math.max(qx, 0);
  const vy = Math.max(qy, 0);
  const len = Math.hypot(vx, vy) || 1;
  return { x: (Math.sign(px) || 1) * (vx / len), y: (Math.sign(py) || 1) * (vy / len) };
}

function samplePx(data, sw, sh, x, y, ch) {
  if (x < 0) x = 0; else if (x > sw - 1) x = sw - 1;
  if (y < 0) y = 0; else if (y > sh - 1) y = sh - 1;
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = x0 + 1 < sw ? x0 + 1 : x0;
  const y1 = y0 + 1 < sh ? y0 + 1 : y0;
  const fx = x - x0;
  const fy = y - y0;
  const a = data[(y0 * sw + x0) * 4 + ch] * (1 - fx) + data[(y0 * sw + x1) * 4 + ch] * fx;
  const b = data[(y1 * sw + x0) * 4 + ch] * (1 - fx) + data[(y1 * sw + x1) * 4 + ch] * fx;
  return a * (1 - fy) + b * fy;
}

// 把胶囊覆盖的那块画面按 SDF 折射，返回一张带透明边的 canvas。
// 关键是位移在“边缘最大、向中心衰减”，这样边沿才会把画面压出弯折。
function refractLayer(baseCanvas, blurCanvas, bx, by, bw, bh, r, opt) {
  const w = Math.ceil(bw);
  const h = Math.ceil(bh);
  const pad = Math.ceil(opt.amp) + 10;
  const sx = Math.max(0, Math.floor(bx) - pad);
  const sy = Math.max(0, Math.floor(by) - pad);
  const sw = Math.min(blurCanvas.width - sx, w + pad * 2);
  const sh = Math.min(blurCanvas.height - sy, h + pad * 2);

  const sharp = baseCanvas.getContext('2d', { willReadFrequently: true }).getImageData(sx, sy, sw, sh).data;
  const soft = blurCanvas.getContext('2d', { willReadFrequently: true }).getImageData(sx, sy, sw, sh).data;

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');
  const img = octx.createImageData(w, h);
  const dst = img.data;

  const ox0 = bx - sx;
  const oy0 = by - sy;
  const hw = w / 2;
  const hh = h / 2;
  const rim = Math.max(12, Math.min(h * 0.24, 28));   // 弯折发生的边带宽度
  const amp = opt.amp;
  const disp = opt.disp;
  const sat = opt.sat;

  for (let j = 0; j < h; j++) {
    const cy = j + 0.5 - hh;
    for (let i = 0; i < w; i++) {
      const cx = i + 0.5 - hw;
      const d = sdRound(cx, cy, hw, hh, r);
      const cov = Math.min(1, Math.max(0, 0.5 - d));
      if (cov <= 0) continue;

      const t = Math.min(1, Math.max(0, -d / rim));    // 0 = 贴边，1 = 内侧
      const g = gradRound(cx, cy, hw, hh, r);

      // 玻璃边缘像一块向下弯的表面：越靠边，法线方向的位移越大
      const prof = Math.pow(1 - t, 3.0);
      const a = amp * prof;
      const offX = -g.x * a;
      const offY = -g.y * a;

      const X = ox0 + i + 0.5;
      const Y = oy0 + j + 0.5;
      const o = (j * w + i) * 4;

      const sx2 = offX * 0.45;
      const sy2 = offY * 0.45;
      let cr = samplePx(soft, sw, sh, X + sx2, Y + sy2, 0);
      let cg = samplePx(soft, sw, sh, X + sx2, Y + sy2, 1);
      let cb = samplePx(soft, sw, sh, X + sx2, Y + sy2, 2);

      if (t < 1) {
        // 边带里混入清晰画面：弯折和色散才看得见
        const wgt = Math.pow(1 - t, 2.0) * 0.92;
        const sr = samplePx(sharp, sw, sh, X + offX * (1 + disp), Y + offY * (1 + disp), 0);
        const sg = samplePx(sharp, sw, sh, X + offX, Y + offY, 1);
        const sb = samplePx(sharp, sw, sh, X + offX * (1 - disp), Y + offY * (1 - disp), 2);
        cr += (sr - cr) * wgt;
        cg += (sg - cg) * wgt;
        cb += (sb - cb) * wgt;
      }

      // 通透感：比背景更饱和、稍微亮一点
      const luma = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
      cr = luma + (cr - luma) * sat;
      cg = luma + (cg - luma) * sat;
      cb = luma + (cb - luma) * sat;

      dst[o] = cr * 1.03 + 2;
      dst[o + 1] = cg * 1.03 + 2;
      dst[o + 2] = cb * 1.03 + 2;
      dst[o + 3] = 255 * cov;
    }
  }

  octx.putImageData(img, 0, 0);
  return out;
}

// 自适应版式：边距按图宽推算（1290 宽时 ≈ 10px），字号跟着图片大小走
function layoutBar(W, H) {
  const g = state.glass;
  const k = W / 1290;
  // 「大小」整体缩放：字号跟着胶囊一起变，logo 和内缩才不跑位
  const fs = Math.max(8, Math.min(W * 0.0215, 92) * (g.scale / 100));
  const bh = fs * 4.3;
  const m = Math.max(35, W * 0.008);
  const bw = W - m * 2;
  const bx = m + g.dx * k;
  const by = H - m - bh + g.dy * k;

  const fp = fs * 0.9;
  return {
    bx, by, bw, bh,
    br: bh / 2,
    m,
    f1: fs,
    f2: fs * 0.82,
    fp,
    logoH: fp * 1.5,
    padIn: bh * 0.5,
    gap: fs * 0.42,
    base1: by + bh * 0.40,
    base2: by + bh * 0.74,
  };
}

function drawGlass(ctx, W, H, meta) {
  const g = state.glass;
  const lay = layoutBar(W, H);
  const { bx, by, bw, bh, br } = lay;

  // 库里的比例：胶囊 56dp 时 blur 8dp、lens(24dp, 24dp)
  const rimPx = Math.max(6, bh * 0.43 * (g.thickness / 100));
  const ampPx = bh * 0.43 * (g.refract / 100);
  const blurPx = Math.max(0.5, bh * (8 / 56) * (g.blur / 100));
  const blurCanvas = ensureBlur(blurPx);

  let drew = false;
  if (glassGL) {
    try {
      const res = glassGL.render({
        source: blurCanvas,
        rect: { x: bx, y: by, w: bw, h: bh },
        radius: br,
        refractH: rimPx,
        refractA: ampPx,
        depth: 0,
        disp: g.disp >= 30 ? 1 : 0,
        sat: 1.22,
        surface: [0.07, 0.07, 0.07],
        surfaceA: (g.tint / 100) * 0.40,
        pad: Math.ceil(ampPx + 10),
      });
      ctx.drawImage(res.canvas, res.x, res.y);
      drew = true;
    } catch {
      drew = false;
    }
  }

  if (!drew) {
    const refract = refractLayer(cache.base, blurCanvas, bx, by, bw, bh, br, {
      amp: Math.min(rimPx * 0.85, ampPx),
      disp: (g.disp / 100) * 0.055,
      sat: 1.22,
    });
    ctx.drawImage(refract, bx, by);
  }

  // 表面、描边、高光都在着色器里按受光方向算，这里只放文字

  drawText(ctx, lay, meta);
}

// ---------------------------------------------------------------- 文字

const inkCache = new Map();

function inkBox(ch, family) {
  const key = `${ch}|${family}`;
  if (inkCache.has(key)) return inkCache.get(key);
  const S = 100;
  const c = document.createElement('canvas');
  c.width = 220; c.height = 220;
  const g = c.getContext('2d');
  g.font = `400 ${S}px ${family}`;
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#fff';
  g.fillText(ch, 60, 150);
  const d = g.getImageData(0, 0, 220, 220).data;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < 220; y++) {
    for (let x = 0; x < 220; x++) {
      if (d[(y * 220 + x) * 4 + 3] > 6) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  // 记录相对于绘制锚点（60, 150）的墨迹范围
  const box = x1 > x0
    ? { x0: x0 - 60, y0: y0 - 150, x1: x1 - 60, y1: y1 - 150, S, w: x1 - x0 + 1, h: y1 - y0 + 1 }
    : null;
  inkCache.set(key, box);
  return box;
}

// 按字形墨迹对齐：左边缘落在 left，墨迹的视觉中心落在 centerY
function drawGlyph(ctx, ch, family, left, centerY, targetH) {
  const ink = inkBox(ch, family);
  if (!ink) return 0;
  const sc = targetH / ink.h;
  ctx.save();
  ctx.translate(left - ink.x0 * sc, centerY - ((ink.y0 + ink.y1) / 2) * sc);
  ctx.scale(sc, sc);
  ctx.font = `400 ${ink.S}px ${family}`;
  ctx.fillText(ch, 0, 0);
  ctx.restore();
  return ink.w * sc;
}

function drawText(ctx, lay, meta) {
  const { bx, by, bw, bh, padIn, f1, f2, fp, base1, base2, gap, logoH } = lay;

  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = Math.max(1.5, f1 * 0.15);
  ctx.shadowOffsetY = Math.max(0.4, f1 * 0.03);

  ctx.fillStyle = 'rgba(255,255,255,0.97)';
  setFont(ctx, 600, f1, 0.015);
  ctx.fillText(meta.device, bx + padIn, base1);

  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  setFont(ctx, 400, f2, 0.004);
  ctx.fillText(meta.date, bx + padIn, base2);

  const hasRight = !!(meta.params || (state.showGps && meta.gps));
  if (hasRight) {
    const avail = bw - padIn * 2;
    setFont(ctx, 600, f1, 0.015);
    const leftW = Math.max(
      ctx.measureText(meta.device).width,
      (setFont(ctx, 400, f2, 0.004), ctx.measureText(meta.date).width),
    );

    // 画面太窄时依次：去掉苹果标 → 缩小右侧字号，保证不和左边打架
    let fpNow = fp;
    let f2Now = f2;
    let logoHNow = logoH;
    let paramsW = 0;
    let gpsW = 0;

    const measureRight = () => {
      setFont(ctx, 400, fpNow, 0.008);
      paramsW = meta.params ? ctx.measureText(meta.params).width : 0;
      setFont(ctx, 400, f2Now, 0.004);
      gpsW = state.showGps && meta.gps ? ctx.measureText(meta.gps).width : 0;
    };
    const ink = inkBox(APPLE_GLYPH, FONT);
    let logoW = meta.params && ink ? (ink.w / ink.h) * logoHNow : 0;

    measureRight();
    if (leftW + gap + logoW + Math.max(paramsW, gpsW) > avail) logoW = 0;
    measureRight();
    if (leftW + gap + Math.max(paramsW, gpsW) > avail) {
      const sc = Math.max(0.55, (avail - leftW - gap) / Math.max(1, Math.max(paramsW, gpsW)));
      fpNow *= sc;
      f2Now *= sc;
      logoHNow *= sc;
      measureRight();
    }

    const blockW = Math.max(paramsW, gpsW);
    const blockLeft = bx + bw - padIn - blockW;

    if (meta.params) {
      if (logoW > 0) {
        // 苹果标和参数之间一条细分隔线
        const divX = blockLeft - gap * 0.85;
        ctx.save();
        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = 'rgba(255,255,255,0.20)';
        ctx.lineWidth = Math.max(1, bh * 0.0045);
        ctx.beginPath();
        ctx.moveTo(divX, by + bh * 0.24);
        ctx.lineTo(divX, by + bh * 0.76);
        ctx.stroke();
        ctx.restore();

        ctx.fillStyle = 'rgba(255,255,255,0.97)';
        // 竖直方向落在胶囊中线上，也就是两行文字中间
        drawGlyph(ctx, APPLE_GLYPH, FONT, divX - gap * 0.55 - logoW, by + bh * 0.5, logoHNow);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      setFont(ctx, 400, fpNow, 0.008);
      ctx.fillText(meta.params, blockLeft, base1);
    }
    if (state.showGps && meta.gps) {
      ctx.fillStyle = 'rgba(255,255,255,0.74)';
      setFont(ctx, 400, f2Now, 0.004);
      ctx.fillText(meta.gps, blockLeft, base2);
    }
  }

  ctx.restore();
}

// ---------------------------------------------------------------- 渲染

let displayCanvas = null;
let rafId = 0;

function render() {
  if (!photo) return;
  ensureBase();

  if (!displayCanvas) {
    displayCanvas = document.createElement('canvas');
    stage.wrap.replaceChildren(displayCanvas);
  }
  displayCanvas.width = cache.W;
  displayCanvas.height = cache.H;
  const ctx = displayCanvas.getContext('2d');
  ctx.drawImage(cache.base, 0, 0);
  drawGlass(ctx, cache.W, cache.H, buildMeta());
  outCanvas = displayCanvas;
}

function schedule() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    render();
  });
}

// ---------------------------------------------------------------- 交互

function toast(msg) {
  stage.toast.textContent = msg;
  stage.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => stage.toast.classList.remove('show'), 2200);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片打不开'));
    img.src = src;
  });
}

async function openFile(file) {
  if (!file) return;
  try {
    const url = URL.createObjectURL(file);
    const img = await loadImage(url);
    let exif = {};
    try { exif = parseExif(await file.arrayBuffer()); } catch { exif = {}; }
    URL.revokeObjectURL(url);
    setPhoto({ img, exif });
  } catch {
    toast('这张图读不出来，换一张试试');
  }
}

function setPhoto(next) {
  photo = next;
  cache.key = null;
  cache.blur = null;
  displayCanvas = null;
  stage.wrap.replaceChildren();
  stage.empty.hidden = true;
  stage.edit.hidden = false;
  render();
}

// 示例图直接画出来：不依赖任何图片文件，仓库里不用放二进制
function makeDemoImage() {
  const W = 1290, H = 1470;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');

  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#101a2e');
  grad.addColorStop(1, '#c4552a');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  for (const [x, y, r, col] of [
    [420, 520, 240, 'rgba(40,120,255,.55)'],
    [880, 980, 290, 'rgba(255,120,60,.55)'],
    [700, 300, 180, 'rgba(60,210,170,.45)'],
  ]) {
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, col);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  g.strokeStyle = 'rgba(255,255,255,.14)';
  g.lineWidth = 2;
  for (let x = 0; x < W; x += 118) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
  for (let y = 0; y < H; y += 118) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
  }
  return c;
}

function loadSample() {
  setPhoto({
    img: makeDemoImage(),
    exif: {
      make: 'Apple',
      model: 'iPhone 17 Pro Max',
      date: '2026:08:06 16:27:15',
      fNumber: 2.8,
      exposure: 1 / 1792,
      iso: 20,
      focal: 100,
      focal35: 100,
      gps: {
        lat: { deg: 22, min: 6, sec: 7 },
        lon: { deg: 114, min: 1, sec: 32 },
        latRef: 'N',
        lonRef: 'E',
      },
    },
  });
}

// ---- 机型面板 ----
function renderModels() {
  const list = $('#modelList');
  const rows = [{ id: 'auto', name: '自动', note: '按照片 EXIF' }, ...MODELS];
  list.replaceChildren(...rows.map((m) => {
    const b = document.createElement('button');
    b.className = 'model-item' + (state.model === m.id ? ' on' : '');
    b.innerHTML = `<span>${m.name}<small>${m.note}</small></span><span class="tick">✓</span>`;
    b.addEventListener('click', () => {
      state.model = m.id;
      state.lens = m.def ?? 0;
      renderModels();
      schedule();
      saveState();
    });
    return b;
  }));
  attachSpringPress(list);

  const m = MODELS.find((x) => x.id === state.model);
  const row = $('#lensRow');
  if (!m) {
    row.innerHTML = '<span class="note" style="margin:0">选一个机型后可以切镜头</span>';
    return;
  }
  row.replaceChildren(...m.lenses.map((l, i) => {
    const b = document.createElement('button');
    b.className = 'lens' + (state.lens === i ? ' on' : '');
    b.textContent = `${l.zoom} ${l.focal}mm`;
    b.addEventListener('click', () => {
      state.lens = i;
      renderModels();
      schedule();
      saveState();
    });
    return b;
  }));
  attachSpringPress(row);
}

// ---- 参数面板 ----
const CTRLS = [
  { key: 'refract', label: '折射', min: 0, max: 200, step: 1, fmt: (v) => v },
  { key: 'thickness', label: '厚度', min: 0, max: 200, step: 1, fmt: (v) => v },
  { key: 'blur', label: '模糊', min: 0, max: 200, step: 1, fmt: (v) => v },
  { key: 'disp', label: '色散', min: 0, max: 200, step: 1, fmt: (v) => v },
  { key: 'tint', label: '浓度', min: 0, max: 200, step: 1, fmt: (v) => v },
  { key: 'scale', label: '大小', min: 60, max: 140, step: 1, fmt: (v) => v + '%' },
  { key: 'dx', label: '左右', min: -80, max: 80, step: 1, fmt: (v) => v },
  { key: 'dy', label: '上下', min: -120, max: 120, step: 1, fmt: (v) => v },
];

function buildControls() {
  const box = $('#controls');
  box.replaceChildren(...CTRLS.map((c) => {
    const wrap = document.createElement('div');
    wrap.className = 'ctl';
    wrap.innerHTML = `<div class="head"><b>${c.label}</b><output></output></div>`;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = c.min;
    input.max = c.max;
    input.step = c.step;
    input.value = state.glass[c.key];
    const out = wrap.querySelector('output');
    out.textContent = c.fmt(state.glass[c.key]);
    input.addEventListener('input', () => {
      state.glass[c.key] = Number(input.value);
      out.textContent = c.fmt(input.value);
      schedule();
    });
    input.addEventListener('change', saveState);
    wrap.appendChild(input);
    return wrap;
  }));
}

function syncControls() {
  const inputs = $('#controls').querySelectorAll('input');
  inputs.forEach((input, i) => {
    input.value = state.glass[CTRLS[i].key];
    input.previousElementSibling.querySelector('output').textContent = CTRLS[i].fmt(state.glass[CTRLS[i].key]);
  });
}

// ---- 保存 ----
function openSheet() {
  if (!outCanvas) return;
  outCanvas.toBlob((blob) => {
    if (!blob) { toast('导出失败'); return; }
    const url = URL.createObjectURL(blob);
    const img = document.createElement('img');
    img.src = url;
    img.alt = '带水印的照片';
    stage.result.replaceChildren(img);
    const dl = $('#dl');
    dl.href = url;
    dl.download = `watermark-${Date.now()}.jpg`;
    stage.edit.style.visibility = 'hidden';
    stage.sheet.hidden = false;
    syncBall();
  }, 'image/jpeg', 0.94);
}

function closeSheet() {
  stage.sheet.hidden = true;
  stage.edit.style.visibility = '';
  syncBall();
}

// ---- 绑定 ----
$('#pick').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', (e) => {
  openFile(e.target.files && e.target.files[0]);
  e.target.value = '';
});
$('#demo').addEventListener('click', loadSample);
$('#change').addEventListener('click', () => $('#file').click());
$('#save').addEventListener('click', openSheet);
$('#close').addEventListener('click', closeSheet);
$('#back').addEventListener('click', closeSheet);

const backBall = $('#backBall');

function syncBall() {
  const anyOpen = !stage.sheet.hidden || !stage.modelSheet.hidden || !stage.adjSheet.hidden;
  backBall.hidden = !anyOpen;
}

function closeTop() {
  if (!stage.sheet.hidden) { closeSheet(); }
  else if (!stage.adjSheet.hidden) { stage.adjSheet.hidden = true; }
  else if (!stage.modelSheet.hidden) { stage.modelSheet.hidden = true; }
  syncBall();
}

backBall.addEventListener('click', closeTop);

function openOnly(el) {
  [stage.sheet, stage.modelSheet, stage.adjSheet].forEach((s) => { s.hidden = true; });
  el.hidden = false;
  syncBall();
}

$('#modelBtn').addEventListener('click', () => {
  renderModels();
  openOnly(stage.modelSheet);
});
$('#adjBtn').addEventListener('click', () => {
  syncControls();
  openOnly(stage.adjSheet);
});

document.querySelectorAll('[data-close]').forEach((b) => {
  b.addEventListener('click', () => {
    b.closest('.sheet').hidden = true;
    syncBall();
  });
});

const enhanceBtn = $('#enhanceToggle');
enhanceBtn.classList.toggle('on', state.enhance);
enhanceBtn.setAttribute('aria-checked', String(state.enhance));

enhanceBtn.addEventListener('click', (e) => {
  state.enhance = !state.enhance;
  e.currentTarget.classList.toggle('on', state.enhance);
  e.currentTarget.setAttribute('aria-checked', String(state.enhance));
  rebuildBase();
  displayCanvas = null;
  stage.wrap.replaceChildren();
  schedule();
  saveState();
});

$('#gpsToggle').addEventListener('click', (e) => {
  state.showGps = !state.showGps;
  e.currentTarget.classList.toggle('on', state.showGps);
  e.currentTarget.setAttribute('aria-checked', String(state.showGps));
  schedule();
  saveState();
});

$('#reset').addEventListener('click', () => {
  state.glass = {
    refract: 60, thickness: 100, blur: 30, disp: 100, tint: 18,
    scale: 100, dx: 0, dy: 0,
  };
  cache.blur = null;
  syncControls();
  schedule();
  saveState();
});

loadState();
buildControls();
attachSpringPress();

const gpsBtn = $('#gpsToggle');
gpsBtn.classList.toggle('on', state.showGps);
gpsBtn.setAttribute('aria-checked', String(state.showGps));

if (/(^|[?&])sample=1/.test(location.search)) loadSample();
