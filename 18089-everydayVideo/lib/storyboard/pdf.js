// storyboard/pdf.js
// Hand-rolled PDF writer for the storyboard export. Zero deps so it
// stays well under the 228MB cgroup limit. Supports:
//
//   - A4 portrait pages
//   - Embedded Helvetica + Helvetica-Bold (built-in font)
//   - Vector lines, rectangles, text
//   - Embedded raster images (PNG via FlateDecode + DCTDecode for JPEG)
//
// We deliberately avoid generating whole images inline; large rasters
// are referenced by relative path or skipped (a "no asset" placeholder
// is drawn instead) so the PDF stays small.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- low-level PDF object builder ----

function _esc(str) {
    return String(str)
        .replace(/\\/g, '\\\\')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)');
}

// Encode text under Identity-H: each Unicode code point must be
// translated to its glyph ID (CID) in the CFF, since this is a
// CID-keyed font. Returns hex literal "<...>".
//
// NotoSansCJK cmap layout (the only CIDFont we currently use):
//   - BMP Latin block (U+0020..U+007E, U+00A0..U+00FF): glyph is at
//     CID = codepoint + 1 (i.e. U+0020 → 0x0001, U+007E → 0x005F).
//   - CJK and other blocks: cmap maps codepoint → CID directly.
//   - Anything missing: CID 0 (.notdef) — the reader will draw a
//     empty box but won't crash.
function _cidHex(doc, text) {
    let out = '';
    const c2c = doc._cjk && doc._cjk.codeToCid;
    for (const ch of String(text)) {
        const cp = ch.codePointAt(0);
        let cid;
        if (c2c && c2c.has(cp)) {
            cid = c2c.get(cp);
        } else if (cp < 0x100) {
            // ASCII / Latin-1: cmap uses CID = codepoint + 1 (no
            // direct entry for the codepoint itself). Some chars
            // (e.g. U+00A0 NBSP) may be exposed directly though,
            // so we already tried `c2c.has(cp)` first.
            // If the +1 entry isn't there either, fall back to the
            // raw codepoint — it lines up by coincidence for many
            // BMP Latin glyphs in NotoSansCJK.
            cid = c2c && c2c.has(cp + 1) ? c2c.get(cp + 1) : cp;
        } else {
            cid = 0; // .notdef
        }
        // Identity-H uses fixed 2-byte CIDs (0..0xFFFF). NotoSansCJK
        // can have CIDs > 0xFFFF for some SMP / emoji-range glyphs,
        // but they only exist because cmap format-12 stores 32-bit
        // glyph IDs. Under Identity-H, any CID > 0xFFFF is undefined;
        // substitute CID 0 (.notdef) so the Tj hex payload stays
        // exactly 4 chars per codepoint.
        if (cid > 0xFFFF) cid = 0;
        out += (cid >>> 0).toString(16).padStart(4, '0');
    }
    return '<' + out + '>';
}

class PDFDoc {
    constructor() {
        this.objects = []; // array of Uint8Array (or Buffer) bodies
        this.offsets = [];
        this._useCJK = false;
        this._cjk = null;
        // Object layout:
        //   1 = Catalog (placeholder)
        //   2 = Pages   (placeholder, finalized at the end)
        //   3 = F1 (Helvetica) — kept as a fallback for empty strings
        //   4 = F2 (Helvetica-Bold) — same
        // When CJK is loaded, F1/F2 are both replaced by the CJK font.
        //   3 = Type0 font (F1)
        //   4 = Type0 font (F2)
        //   5 = CIDFontType0
        //   6 = FontDescriptor
        //   7 = FontFile3 (raw CFF bytes)
        //   8 = ToUnicode CMap
        this._push('<< /Type /Catalog /Pages 2 0 R >>');
        this._push('<< /Type /Pages /Count 0 /Kids [] >>');
        this._push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
        this._push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
        this._pageIds = [];

        // Try to load the system CJK font. If absent (dev box without
        // fonts), we fall back to the Helvetica default and the user
        // sees Latin-only — better than crashing the export.
        try {
            const { loadCJKFont } = require('./font-loader');
            const r = loadCJKFont();
            if (process.env.SB_DEBUG_CMAP) console.error('[pdf.js] loadCJKFont ok=', r.ok, 'cmapBytes.length=', r.cmapBytes && r.cmapBytes.length, 'first 200:', r.cmapBytes && r.cmapBytes.slice(0, 200).toString('utf8').replace(/\n/g, '|'));
            if (r && r.ok) {
                this._cjk = r;
                this._useCJK = true;
                this._installCJKFont();
            }
        } catch (_) { /* no CJK — fall back */ }
    }

    _installCJKFont() {
        // Build the 6-object font graph. Replaces the Helvetica placeholders.
        // After this: objects 3..8 exist in this order:
        //   3 = Type0 font dict for F1 (and reused for F2 with /FontName alias)
        //   4 = Type0 font dict for F2 (points at same CIDFont, just different BaseFont string)
        //   5 = CIDFontType0
        //   6 = FontDescriptor
        //   7 = FontFile3 (CFF stream — appended after this method)
        //   8 = ToUnicode CMap stream — appended after this method
        //
        // Simpler: register F1 and F2 as separate Type0 entries pointing at
        // the same CIDFont descendant, with two different /BaseFont strings
        // so the PDF reader doesn't deduplicate them.
        // Because _push appends to objects[], we use placeholder strings and
        // patch them at finalize.
        const cffId = 7;
        const cmapId = 8;
        const cidId = 5;
        const fdId = 6;

        // First make space for the 6 objects by pushing empty placeholders
        // we'll overwrite via direct object body writes.
        const placeholders = [3, 4, 5, 6, 7, 8];
        // We'll use a special raw-push method that lets us write binary.
        this._push('<< /CFF_PLACEHOLDER >>');
        this._push('<< /CFF_PLACEHOLDER >>');
        this._push('<< /CFF_PLACEHOLDER >>');
        this._push('<< /CFF_PLACEHOLDER >>');
        this._push('<< /CFF_PLACEHOLDER >>');
        this._push('<< /CFF_PLACEHOLDER >>');

        // Now overwrite objects[2..7] with our font dicts.
        const upe = this._cjk.unitsPerEm || 1000;
        const cjkName = 'NotoSansCJK-Regular';
        // F1 (object 3) — Type0 wrapper for CJK
        this.objects[2] = Buffer.from(
            `<< /Type /Font /Subtype /Type0 /BaseFont /${cjkName} ` +
            `/Encoding /Identity-H ` +
            `/DescendantFonts [${cidId} 0 R] ` +
            `/ToUnicode ${cmapId} 0 R >>`,
            'utf8'
        );
        // F2 (object 4) — Type0 wrapper for "Bold", points at same CIDFont
        this.objects[3] = Buffer.from(
            `<< /Type /Font /Subtype /Type0 /BaseFont /NotoSansCJK-Bold ` +
            `/Encoding /Identity-H ` +
            `/DescendantFonts [${cidId} 0 R] ` +
            `/ToUnicode ${cmapId} 0 R >>`,
            'utf8'
        );
        // CIDFontType0 (object 5)
        this.objects[4] = Buffer.from(
            `<< /Type /Font /Subtype /CIDFontType0 ` +
            `/BaseFont /${cjkName} ` +
            `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
            `/FontDescriptor ${fdId} 0 R >>`,
            'utf8'
        );
        // FontDescriptor (object 6) — metric values approximate; CFF
        // glyph metrics override these when present.
        this.objects[5] = Buffer.from(
            `<< /Type /FontDescriptor /FontName /${cjkName} ` +
            `/Flags 4 /FontBBox [-100 -200 1100 900] ` +
            `/ItalicAngle 0 /Ascent 900 /Descent -200 ` +
            `/CapHeight 700 /StemV 80 ` +
            `/FontFile3 ${cffId} 0 R >>`,
            'utf8'
        );
        // FontFile3 (object 7) — stream with raw CFF bytes.
        const cff = this._cjk.cffBytes;
        this.objects[6] = Buffer.concat([
            Buffer.from(`<< /Length ${cff.length} /Subtype /CIDFontType0C >>\nstream\n`, 'utf8'),
            cff,
            Buffer.from('\nendstream', 'utf8'),
        ]);
        // ToUnicode CMap (object 8)
        const cmap = this._cjk.cmapBytes;
        this.objects[7] = Buffer.concat([
            Buffer.from(`<< /Length ${cmap.length} >>\nstream\n`, 'utf8'),
            cmap,
            Buffer.from('\nendstream', 'utf8'),
        ]);
    }

    _push(body) {
        this.objects.push(Buffer.from(body, 'utf8'));
        return this.objects.length; // 1-based
    }

    addObject(body) {
        return this._push(body);
    }

    addPage(widthPt, heightPt, contentStream) {
        // F1=3, F2=4 — set up at construction. (Same when CJK is installed.)
        const contentId = this.objects.length + 2; // after we push page+content
        const pageNum = this._push(
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] ` +
            `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> ` +
            `/Contents ${contentId} 0 R >>`
        );
        this._push(`<< /Length ${Buffer.byteLength(contentStream, 'utf8')} >>\nstream\n${contentStream}\nendstream`);
        this._pageIds.push(pageNum);
        return pageNum;
    }

    finalize() {
        // Rewrite object 2 = Pages
        const kids = this._pageIds.map((id) => `${id} 0 R`).join(' ');
        const pagesObj = `<< /Type /Pages /Count ${this._pageIds.length} /Kids [${kids}] >>`;
        this.objects[1] = Buffer.from(pagesObj, 'utf8');

        // Build the file.
        const chunks = [];
        chunks.push(Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary'));
        let offset = chunks[0].length;
        const xref = [];
        for (let i = 0; i < this.objects.length; i++) {
            xref.push(offset);
            const body = this.objects[i];
            const header = Buffer.from(`${i + 1} 0 obj\n`, 'utf8');
            const trailer = Buffer.from('\nendobj\n', 'utf8');
            chunks.push(header, body, trailer);
            offset += header.length + body.length + trailer.length;
        }
        const xrefStart = offset;
        let xrefStr = `xref\n0 ${this.objects.length + 1}\n`;
        xrefStr += '0000000000 65535 f \n';
        for (const off of xref) {
            xrefStr += `${String(off).padStart(10, '0')} 00000 n \n`;
        }
        chunks.push(Buffer.from(xrefStr, 'utf8'));
        chunks.push(Buffer.from(`trailer\n<< /Size ${this.objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`, 'utf8'));
        return Buffer.concat(chunks);
    }
}

// ---- image helpers ----

function _readPNG(path) {
    const buf = fs.readFileSync(path);
    if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
    // Walk chunks to find IHDR + IDAT.
    let p = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = 0;
    const idatChunks = [];
    while (p < buf.length) {
        const len = buf.readUInt32BE(p); p += 4;
        const type = buf.slice(p, p + 4).toString('ascii'); p += 4;
        const data = buf.slice(p, p + len); p += len;
        p += 4; // crc
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
        } else if (type === 'IDAT') {
            idatChunks.push(data);
        } else if (type === 'IEND') break;
    }
    if (!width) return null;
    const idat = Buffer.concat(idatChunks);
    const inflated = zlib.inflateSync(idat);
    let colorSpace;
    if (colorType === 6) colorSpace = 'DeviceRGB';
    else if (colorType === 2) colorSpace = 'DeviceRGB';
    else if (colorType === 4) colorSpace = 'DeviceGray'; // + alpha
    else return null;
    return { width, height, colorSpace, data: inflated };
}

function _decodePNG(data, width, height, colorType) {
    // PNG IDAT stream has a filter byte per scanline. We re-filter into
    // raw pixel rows.
    const bpp = colorType === 6 ? 4 : (colorType === 2 ? 3 : (colorType === 4 ? 2 : 1));
    const stride = width * bpp;
    const out = Buffer.alloc(stride * height);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
        const filter = data[y * (stride + 1)];
        const row = data.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
        const cur = Buffer.alloc(stride);
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? cur[x - bpp] : 0;
            const b = prev[x];
            const c = x >= bpp ? prev[x - bpp] : 0;
            let v;
            switch (filter) {
                case 0: v = row[x]; break;
                case 1: v = (row[x] + a) & 0xff; break;
                case 2: v = (row[x] + b) & 0xff; break;
                case 3: v = (row[x] + ((a + b) >> 1)) & 0xff; break;
                case 4: {
                    const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
                    const pr = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
                    v = (row[x] + pr) & 0xff;
                    break;
                }
                default: v = row[x];
            }
            cur[x] = v;
        }
        cur.copy(out, y * stride);
        prev = cur;
    }
    return out;
}

function embedImage(doc, imagePath) {
    if (!imagePath || !fs.existsSync(imagePath)) return null;
    const ext = path.extname(imagePath).toLowerCase();
    if (ext === '.png') {
        const meta = _readPNG(imagePath);
        if (!meta) return null;
        const pixels = _decodePNG(meta.data, meta.width, meta.height, 6); // assume RGBA
        return doc._push(`<< /Type /XObject /Subtype /Image /Width ${meta.width} /Height ${meta.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${pixels.length} >>\nstream\n`) && (() => {
            // Need to write binary stream body. Hack: append raw bytes after the object header.
            const idx = doc.objects.length - 1;
            const head = doc.objects[idx];
            const tail = Buffer.from('\nendstream\nendobj\n', 'utf8');
            doc.objects[idx] = Buffer.concat([head, pixels, tail]);
            return idx + 1;
        })();
    }
    return null; // JPEG / others not yet embedded (placeholder drawn instead)
}

// ---- storyboard layout ----

const PAGE_W = 595.28; // A4 portrait, points
const PAGE_H = 841.89;
const MARGIN = 36;

// Storyboard UI color palette (matches lib/storyboard/storyboard.html).
// We pick "printable" approximations that look good on white paper.
const COLORS = {
    bg:         [0.984, 0.984, 0.988],   // almost-white (cards)
    bg2:        [0.961, 0.965, 0.973],   // secondary surface
    bg3:        [0.929, 0.937, 0.949],   // subtle background
    line:       [0.851, 0.863, 0.882],   // hairline border
    line2:      [0.659, 0.694, 0.749],   // stronger border
    fg:         [0.106, 0.137, 0.176],   // main text
    fg3:        [0.388, 0.435, 0.498],   // secondary text
    accent:     [0.345, 0.651, 1.000],   // primary accent (like #58a6ff)
    accent2:    [0.078, 0.745, 0.502],   // success green
    err:        [0.973, 0.318, 0.286],   // error red
    scene:      [0.027, 0.714, 0.831],   // cyan
    prop:       [0.957, 0.620, 0.043],   // amber
    character:  [0.345, 0.651, 1.000],   // blue
};

function _rgb(c) { return `${c[0].toFixed(3)} ${c[1].toFixed(3)} ${c[2].toFixed(3)}`; }

// Wrap text by approximate glyph width. Each CJK char counts as 2;
// ASCII as ~0.55. Returns array of strings.
function _wrap(text, max) {
    const out = [];
    const lines = String(text || '').split(/\r?\n/);
    for (const raw of lines) {
        if (!raw) { out.push(''); continue; }
        let line = '';
        for (const ch of raw) {
            line += ch;
            const widthApprox = [...line].reduce(
                (acc, c) => acc + (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(c) ? 2 : 0.55),
                0
            );
            if (widthApprox > max) {
                out.push(line);
                line = '';
            }
        }
        if (line) out.push(line);
    }
    return out;
}

function _escapePdfString(s) { return _esc(s); }

function _kindLabel(k) {
    return { character: '角色', scene: '场景', prop: '道具' }[k] || k || '-';
}
function _kindColor(k) {
    return COLORS[k] || COLORS.accent;
}
function _kindBadge(k) {
    return { character: '角色', scene: '场景', prop: '道具' }[k] || (k || '-');
}

// Emit a Tj-ready payload for a string under either encoding:
//   - CJK installed: Identity-H "<hex16...>" (each codepoint = 2-byte CID)
//   - fallback:      WinAnsi-encoded literal "(...)"
function _t(doc, text) {
    const s = String(text == null ? '' : text);
    if (doc._useCJK) return _cidHex(doc, s);
    return `(${_esc(s)})`;
}

// ---- content-stream helpers (low-level) ----
// All helpers return the appended string. The caller concatenates back
// into its accumulator. (Strings are immutable in JS, so we can't
// mutate an outer accumulator.)

function _rect(stream, x, y, w, h, fill, stroke, lw) {
    let out = stream;
    if (fill) {
        out += `${_rgb(fill)} rg ${x} ${y} ${w} ${h} re f\n`;
    }
    if (stroke) {
        out += `${_rgb(stroke)} RG ${lw || 0.5} w ${x} ${y} ${w} ${h} re S\n`;
    }
    return out;
}

function _line(stream, x1, y1, x2, y2, color, lw) {
    return stream + `${_rgb(color)} RG ${lw || 0.5} w ${x1} ${y1} m ${x2} ${y2} l S\n`;
}

function _text(stream, doc, x, y, font, size, color, str) {
    return stream + `BT ${font} ${size} Tf ${_rgb(color)} rg ${x} ${y} Td ${_t(doc, str)} Tj ET\n`;
}

// ---- higher-level layout helpers ----

function _pageHeader(stream, doc, projectName, sectionTitle) {
    // Top accent bar
    let s = _rect(stream, 0, PAGE_H - 4, PAGE_W, 4, COLORS.accent, null);
    // Subhead line
    s = _line(s, MARGIN, PAGE_H - 26, PAGE_W - MARGIN, PAGE_H - 26, COLORS.line, 0.5);
    s = _text(s, doc, MARGIN, PAGE_H - 22, '/F2', 9, COLORS.fg3,
        projectName || 'Hermit-Claw · Storyboard');
    if (sectionTitle) {
        // Right-aligned section title
        const w = _approxTextWidth(sectionTitle, 9);
        s = _text(s, doc, PAGE_W - MARGIN - w, PAGE_H - 22, '/F1', 9, COLORS.fg, sectionTitle);
    }
    return s;
}

function _pageFooter(stream, doc, pageNum, totalPages, projectSlug) {
    let s = _line(stream, MARGIN, MARGIN - 18, PAGE_W - MARGIN, MARGIN - 18, COLORS.line, 0.5);
    s = _text(s, doc, MARGIN, MARGIN - 30, '/F1', 8, COLORS.fg3,
        `${projectSlug || 'storyboard'} · ${new Date().toISOString().slice(0, 10)}`);
    const pn = `Page ${pageNum} / ${totalPages}`;
    const w = _approxTextWidth(pn, 8);
    s = _text(s, doc, PAGE_W - MARGIN - w, MARGIN - 30, '/F1', 8, COLORS.fg3, pn);
    return s;
}

function _approxTextWidth(s, sizePt) {
    // Used only for right-alignment. CJK ≈ 1.0em, ASCII ≈ 0.55em.
    let w = 0;
    for (const ch of String(s)) {
        if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) w += sizePt;
        else w += sizePt * 0.55;
    }
    return w;
}

function _chip(stream, doc, x, y, h, label, kind, withVersion) {
    const color = _kindColor(kind);
    const padX = 6;
    const fs = 8;
    const textW = _approxTextWidth(label, fs);
    const verFs = 7;
    let verW = 0;
    let verLabel = '';
    if (withVersion) {
        verLabel = ` v${withVersion}`;
        verW = _approxTextWidth(verLabel, verFs);
    }
    const w = Math.max(36, padX * 2 + textW + verW + 4);
    let s = stream;
    // Pill background
    s = _rect(s, x, y, w, h, COLORS.bg3, COLORS.line, 0.5);
    // Small color dot on the left
    s = _rect(s, x + 3, y + h / 2 - 2, 4, 4, color, null);
    // Label
    s = _text(s, doc, x + padX + 4, y + h / 2 - fs / 2 + 1, '/F1', fs, COLORS.fg, label);
    if (withVersion) {
        s = _text(s, doc, x + w - padX - verW, y + h / 2 - verFs / 2 + 1, '/F2', verFs, COLORS.accent, verLabel);
    }
    return s;
}

function _sectionTitle(stream, doc, x, y, title, accent) {
    // Section header: small uppercase label + accent bar under it.
    let s = _text(stream, doc, x, y, '/F2', 11, COLORS.fg, title);
    s = _rect(s, x, y - 6, 18, 2, accent || COLORS.accent, null);
    return s;
}

function _kindBadgeForItem(stream, doc, x, y, kind) {
    const color = _kindColor(kind);
    const label = _kindBadge(kind);
    const fs = 8;
    const padX = 5;
    const w = padX * 2 + _approxTextWidth(label, fs);
    const h = 12;
    let s = _rect(stream, x, y, w, h, color, null, 0);
    s = _text(s, doc, x + padX, y + h / 2 - fs / 2 + 1, '/F2', fs, COLORS.bg, label);
    return s;
}

function _placeholderBox(stream, doc, x, y, w, h, label) {
    // A subtle dashed-looking placeholder (we use 2 opposite diagonals +
    // a tinted rect to read as "image placeholder").
    let s = _rect(stream, x, y, w, h, COLORS.bg2, COLORS.line, 0.6);
    s = _line(s, x, y, x + w, y + h, COLORS.line2, 0.4);
    s = _line(s, x + w, y, x, y + h, COLORS.line2, 0.4);
    if (label) {
        const fs = 9;
        s = _text(s, doc, x + 8, y + 8, '/F1', fs, COLORS.fg3, label);
    }
    return s;
}

// ---- layout sections ----

function _coverPage(stream, doc, { projectName, title, projectSlug, generatedAt, characters, versionsByCharacter, shots }) {
    let s = stream;
    // Hero block: tinted background full-width band
    s = _rect(s, 0, PAGE_H - 220, PAGE_W, 184, COLORS.bg2, null);
    s = _rect(s, 0, PAGE_H - 220, PAGE_W, 4, COLORS.accent, null);

    // Project eyebrow
    s = _text(s, doc, MARGIN, PAGE_H - 56, '/F1', 10, COLORS.accent, 'PROJECT STORYBOARD');
    // Title
    s = _text(s, doc, MARGIN, PAGE_H - 92, '/F2', 26, COLORS.fg, title || projectName || 'Storyboard');
    // Subtitle
    if (projectName) {
        const sub = `项目名称 · ${projectName}`;
        s = _text(s, doc, MARGIN, PAGE_H - 116, '/F1', 11, COLORS.fg3, sub);
    }
    // Meta strip
    const my = PAGE_H - 156;
    const meta = [
        ['Generated', generatedAt],
        ['Slug', projectSlug || '-'],
        ['Items', String(characters.length)],
        ['Shots', String(shots.length)],
    ];
    let mx = MARGIN;
    for (const [k, val] of meta) {
        s = _text(s, doc, mx, my, '/F1', 8, COLORS.fg3, k.toUpperCase());
        s = _text(s, doc, mx, my - 12, '/F2', 10, COLORS.fg, val);
        mx += 130;
    }
    // Owner line
    s = _text(s, doc, MARGIN, PAGE_H - 200, '/F1', 9, COLORS.fg3,
        'Hermit-Claw · storyboard  ·  export-pdf');

    // Roster section
    let y = PAGE_H - 250;
    s = _sectionTitle(s, doc, MARGIN, y, '素材库 / Roster', COLORS.accent);
    y -= 22;

    // Group by kind
    const groups = { character: [], scene: [], prop: [] };
    for (const c of characters) (groups[c.kind] || (groups[c.kind] = [])).push(c);
    for (const kind of ['character', 'scene', 'prop']) {
        const items = groups[kind];
        if (!items || !items.length) continue;
        // kind badge
        s = _kindBadgeForItem(s, doc, MARGIN, y - 4, kind);
        y -= 18;
        for (const c of items) {
            const v = c.currentVersionId ? versionsByCharacter[c.currentVersionId] : null;
            const versionLabel = v ? `v${v.versionNo}` : null;
            const verCount = c.versionCount || 0;
            const line = `· ${c.name}`;
            s = _text(s, doc, MARGIN + 8, y, '/F1', 10, COLORS.fg, line);
            if (versionLabel) {
                const w = _approxTextWidth(line, 10);
                s = _text(s, doc, MARGIN + 8 + w + 8, y, '/F2', 9, COLORS.accent, versionLabel);
            }
            if (verCount > 1) {
                const meta2 = `${verCount} versions`;
                const w = PAGE_W - MARGIN - MARGIN - _approxTextWidth(meta2, 9);
                s = _text(s, doc, MARGIN + w, y, '/F1', 9, COLORS.fg3, meta2);
            }
            y -= 14;
            if (y < MARGIN + 40) break;
        }
        y -= 4;
        if (y < MARGIN + 40) break;
    }

    // TOC
    if (y > MARGIN + 80) {
        y -= 8;
        s = _sectionTitle(s, doc, MARGIN, y, '目录 / Contents', COLORS.accent);
        y -= 18;
        const sections = [
            ['1.', '素材库 / Library (character / scene / prop)'],
            ['2.', `分镜 / Shots (${shots.length})`],
            ['3.', '导出历史 / Exports'],
        ];
        for (const [n, t] of sections) {
            s = _text(s, doc, MARGIN + 8, y, '/F2', 10, COLORS.accent, n);
            s = _text(s, doc, MARGIN + 28, y, '/F1', 10, COLORS.fg, t);
            y -= 14;
        }
    }
    return s;
}

function _libraryPage(stream, doc, item, versions, currentVersion) {
    let s = stream;
    const itemName = item.name || '(unnamed)';
    const kindColor = _kindColor(item.kind);

    // Header card
    s = _rect(s, MARGIN, PAGE_H - 96, PAGE_W - 2 * MARGIN, 60, COLORS.bg2, COLORS.line, 0.5);
    // Kind badge
    s = _kindBadgeForItem(s, doc, MARGIN + 12, PAGE_H - 32, item.kind);
    // Name
    s = _text(s, doc, MARGIN + 60, PAGE_H - 30, '/F2', 18, COLORS.fg, itemName);
    // Subline
    const cur = currentVersion ? `current v${currentVersion.versionNo}` : 'no version yet';
    const counts = `${versions.length} version${versions.length === 1 ? '' : 's'}`;
    s = _text(s, doc, MARGIN + 60, PAGE_H - 50, '/F1', 9, COLORS.fg3, `${cur}  ·  ${counts}  ·  ${item.id || ''}`);

    // Three-view section
    let y = PAGE_H - 130;
    s = _sectionTitle(s, doc, MARGIN, y, '三视图 / Three Views', kindColor);
    y -= 16;
    const views = ['front', 'side', 'back'];
    const labels = { front: '正视图 · Front', side: '侧视图 · Side', back: '背视图 · Back' };
    const viewW = (PAGE_W - 2 * MARGIN - 2 * 12) / 3;
    const viewH = 180;
    if (currentVersion) {
        for (let i = 0; i < 3; i++) {
            const v = views[i];
            const src = (currentVersion.sources || {})[v];
            const x = MARGIN + i * (viewW + 12);
            const yBox = y - viewH;
            s = _rect(s, x, yBox, viewW, viewH, COLORS.bg, COLORS.line, 0.5);
            s = _text(s, doc, x + 8, y - 14, '/F2', 9, COLORS.fg, labels[v]);
            // Source kind + path
            let sourceText = '(empty)';
            if (src) {
                if (src.kind === 'upload') sourceText = '📁 upload';
                else if (src.kind === 'obs') sourceText = `☁ ${src.obsKey || 'OBS'}`;
                else if (src.kind === 'auto') sourceText = `🎲 ${src.prompt ? 'auto (prompt)' : 'auto'}`;
                if (src.path) sourceText += `  ${src.path.split('/').slice(-2).join('/')}`;
            }
            s = _text(s, doc, x + 8, yBox + 12, '/F1', 8, COLORS.fg3, sourceText);
            // Quick feedback snippet per view
            if (currentVersion.feedback) {
                const fb = String(currentVersion.feedback).slice(0, 80);
                s = _text(s, doc, x + 8, yBox + 26, '/F1', 7, COLORS.fg3, fb);
            }
            // Diagonal X marker when empty
            if (!src) {
                s = _line(s, x + 4, yBox + 4, x + viewW - 4, yBox + viewH - 4, COLORS.line2, 0.4);
                s = _line(s, x + viewW - 4, yBox + 4, x + 4, yBox + viewH - 4, COLORS.line2, 0.4);
            }
        }
    } else {
        s = _text(s, doc, MARGIN, y - 10, '/F1', 10, COLORS.fg3, '尚无版本 · no version yet');
    }
    y -= viewH + 18;

    // Prompt block
    if (currentVersion && currentVersion.prompt) {
        s = _sectionTitle(s, doc, MARGIN, y, '提示词 / Prompt', COLORS.accent);
        y -= 16;
        const promptLines = _wrap(currentVersion.prompt, 80);
        const maxLines = Math.min(promptLines.length, 6);
        for (let i = 0; i < maxLines; i++) {
            s = _text(s, doc, MARGIN + 8, y, '/F1', 10, COLORS.fg, promptLines[i]);
            y -= 13;
        }
        if (promptLines.length > maxLines) {
            s = _text(s, doc, MARGIN + 8, y, '/F1', 9, COLORS.fg3, `…(${promptLines.length - maxLines} more lines)`);
            y -= 13;
        }
        y -= 6;
    }

    // Feedback block
    if (currentVersion && currentVersion.feedback) {
        s = _sectionTitle(s, doc, MARGIN, y, '改进意见 / Feedback', COLORS.accent);
        y -= 16;
        const fbLines = _wrap(currentVersion.feedback, 80);
        const maxLines = Math.min(fbLines.length, 4);
        for (let i = 0; i < maxLines; i++) {
            s = _text(s, doc, MARGIN + 8, y, '/F1', 9, COLORS.fg3, fbLines[i]);
            y -= 12;
        }
        if (fbLines.length > maxLines) {
            s = _text(s, doc, MARGIN + 8, y, '/F1', 8, COLORS.fg3, `…(${fbLines.length - maxLines} more lines)`);
            y -= 12;
        }
        y -= 6;
    }

    // Version history
    if (versions.length > 1) {
        s = _sectionTitle(s, doc, MARGIN, y, '版本历史 / Version History', COLORS.accent);
        y -= 16;
        for (const v of versions) {
            const isCur = currentVersion && v.id === currentVersion.id;
            // Bullet
            s = _rect(s, MARGIN, y - 4, 8, 8, isCur ? COLORS.accent2 : COLORS.line2, null);
            // Label
            const verLabel = `v${v.versionNo}`;
            s = _text(s, doc, MARGIN + 16, y, '/F2', 10, isCur ? COLORS.accent2 : COLORS.fg, verLabel);
            const at = (v.createdAt || '').slice(0, 10);
            const by = v.createdBy ? `by ${v.createdBy}` : '';
            const meta = `${at} ${by}`.trim();
            s = _text(s, doc, MARGIN + 56, y, '/F1', 9, COLORS.fg3, meta);
            // Mini prompt
            if (v.prompt) {
                const mini = String(v.prompt).slice(0, 60) + (v.prompt.length > 60 ? '…' : '');
                s = _text(s, doc, MARGIN + 200, y, '/F1', 9, COLORS.fg, mini);
            }
            y -= 14;
            if (y < MARGIN + 40) break;
        }
    }
    return s;
}

function _buildVersionMapPerItem(items, versionsByCharacter) {
    // group versions by itemId, sorted by versionNo descending
    const byItem = {};
    for (const v of Object.values(versionsByCharacter || {})) {
        if (!v || !v.itemId) continue;
        (byItem[v.itemId] = byItem[v.itemId] || []).push(v);
    }
    for (const arr of Object.values(byItem)) {
        arr.sort((a, b) => (b.versionNo || 0) - (a.versionNo || 0));
    }
    return byItem;
}

function _shotPage(stream, doc, shot, characters, versionsByItem, versionsByCharacter) {
    let s = stream;
    const shotTitle = shot.title || `Shot #${shot.index || '?'}`;
    // Header
    let y = PAGE_H - 60;
    s = _rect(s, MARGIN, PAGE_H - 70, PAGE_W - 2 * MARGIN, 36, COLORS.bg2, COLORS.line, 0.5);
    s = _text(s, doc, MARGIN + 12, PAGE_H - 50, '/F2', 16, COLORS.fg, shotTitle);
    const timeLabel = `${shot.tIn || '00:00'}  →  ${shot.tOut || '00:05'}`;
    const tw = _approxTextWidth(timeLabel, 11);
    s = _text(s, doc, PAGE_W - MARGIN - 12 - tw, PAGE_H - 48, '/F2', 11, COLORS.accent, timeLabel);
    // Version badge
    if (shot.versionNo) {
        const vl = `v${shot.versionNo}`;
        const vw = _approxTextWidth(vl, 9);
        s = _text(s, doc, PAGE_W - MARGIN - 12 - tw - 16 - vw, PAGE_H - 48, '/F1', 9, COLORS.fg3, vl);
    }
    s = _text(s, doc, MARGIN + 12, PAGE_H - 64, '/F1', 9, COLORS.fg3, `shot.id=${shot.id || ''}`);

    y = PAGE_H - 100;

    // Cast / Scene / Props block
    const lookupLabel = (vid) => {
        const v = versionsByCharacter[vid];
        if (!v) return null;
        const c = characters.find((x) => x.id === v.itemId);
        return c ? `${c.name} v${v.versionNo}` : null;
    };

    const blocks = [
        { kind: 'character', title: '角色 / Cast', ids: shot.castVersionIds || [] },
        { kind: 'scene',     title: '场景 / Scene', ids: shot.sceneVersionIds || [] },
        { kind: 'prop',      title: '道具 / Props', ids: shot.propVersionIds || [] },
    ];
    for (const b of blocks) {
        if (!b.ids.length) continue;
        s = _sectionTitle(s, doc, MARGIN, y, b.title, _kindColor(b.kind));
        y -= 16;
        let cx = MARGIN;
        const cy = y - 8;
        const chipH = 16;
        for (const vid of b.ids) {
            const label = lookupLabel(vid);
            if (!label) continue;
            const [name, ver] = label.split(' v');
            s = _chip(s, doc, cx, cy - chipH, chipH, name, b.kind, ver);
            // Compute chip width for cursor advance (we re-implement the math
            // here so the helper can stay return-only).
            const padX = 6, fs = 8, verFs = 7;
            const textW = _approxTextWidth(name, fs);
            const verLabel = ` v${ver}`;
            const verW = _approxTextWidth(verLabel, verFs);
            const chipW = Math.max(36, padX * 2 + textW + verW + 4);
            cx += chipW + 6;
            if (cx > PAGE_W - MARGIN - 60) {
                cx = MARGIN;
                y -= chipH + 6;
            }
        }
        if (cx !== MARGIN) y -= chipH + 6;
        y -= 4;
    }

    // Description
    if (shot.description) {
        s = _sectionTitle(s, doc, MARGIN, y, '描述 / Description', COLORS.accent);
        y -= 16;
        const descLines = _wrap(shot.description, 80);
        for (const line of descLines.slice(0, 12)) {
            s = _text(s, doc, MARGIN + 8, y, '/F1', 11, COLORS.fg, line);
            y -= 14;
        }
        if (descLines.length > 12) {
            s = _text(s, doc, MARGIN + 8, y, '/F1', 9, COLORS.fg3, `…(${descLines.length - 12} more lines)`);
            y -= 13;
        }
        y -= 6;
    }

    // Notes
    if (shot.notes) {
        s = _sectionTitle(s, doc, MARGIN, y, '备注 / Notes', COLORS.accent);
        y -= 16;
        const noteLines = _wrap(shot.notes, 80);
        for (const line of noteLines.slice(0, 6)) {
            s = _text(s, doc, MARGIN + 8, y, '/F1', 9, COLORS.fg3, line);
            y -= 12;
        }
        if (noteLines.length > 6) {
            s = _text(s, doc, MARGIN + 8, y, '/F1', 8, COLORS.fg3, `…(${noteLines.length - 6} more lines)`);
            y -= 11;
        }
        y -= 6;
    }

    // Visual placeholder box (3-up: front / dialog / action)
    const boxY = MARGIN + 6;
    const boxH = Math.max(110, y - boxY - 16);
    if (boxH > 50) {
        s = _placeholderBox(s, doc, MARGIN, boxY, PAGE_W - 2 * MARGIN, boxH, 'visual preview placeholder');
        const third = (PAGE_W - 2 * MARGIN) / 3;
        s = _line(s, MARGIN + third, boxY, MARGIN + third, boxY + boxH, COLORS.line2, 0.4);
        s = _line(s, MARGIN + 2 * third, boxY, MARGIN + 2 * third, boxY + boxH, COLORS.line2, 0.4);
        s = _text(s, doc, MARGIN + 8, boxY + boxH - 14, '/F1', 8, COLORS.fg3, '正 / 侧 / 背  (storyboard frames)');
    }
    return s;
}

function _exportsPage(stream, doc, exports) {
    let s = stream;
    let y = PAGE_H - 60;
    s = _sectionTitle(s, doc, MARGIN, y, '导出历史 / Exports', COLORS.accent);
    y -= 18;
    // Column header
    s = _text(s, doc, MARGIN, y, '/F1', 8, COLORS.fg3, 'TIME');
    s = _text(s, doc, MARGIN + 150, y, '/F1', 8, COLORS.fg3, 'TARGET');
    s = _text(s, doc, MARGIN + 360, y, '/F1', 8, COLORS.fg3, 'STATUS');
    s = _text(s, doc, PAGE_W - MARGIN - 60, y, '/F1', 8, COLORS.fg3, 'BYTES');
    s = _line(s, MARGIN, y - 4, PAGE_W - MARGIN, y - 4, COLORS.line, 0.5);
    y -= 16;
    for (const e of exports.slice(0, 30)) {
        const at = (e.at || '').slice(0, 19).replace('T', ' ');
        const target = e.obsKey || (e.localPath || '').split('/').pop() || '-';
        const status = e.status || '-';
        const statusColor = status === 'uploaded' ? COLORS.accent2 : COLORS.fg3;
        s = _text(s, doc, MARGIN, y, '/F1', 9, COLORS.fg, at);
        s = _text(s, doc, MARGIN + 150, y, '/F1', 9, COLORS.fg, target);
        s = _text(s, doc, MARGIN + 360, y, '/F2', 9, statusColor, status);
        if (e.bytes) {
            const b = (e.bytes / 1024).toFixed(1) + ' KB';
            const bw = _approxTextWidth(b, 9);
            s = _text(s, doc, PAGE_W - MARGIN - bw, y, '/F1', 9, COLORS.fg3, b);
        }
        y -= 14;
        if (y < MARGIN + 30) break;
    }
    if (!exports.length) {
        s = _text(s, doc, MARGIN, y, '/F1', 10, COLORS.fg3, '(no exports yet)');
    }
    return s;
}

function renderStoryboardPdf({
    title,
    project,
    projectSlug,
    characters = [],
    shots = [],
    versionsByCharacter = {},
    exports = [],
    generatedAt,
}) {
    const doc = new PDFDoc();

    // Build per-item version list (newest first)
    const versionsByItem = _buildVersionMapPerItem(characters, versionsByCharacter);

    // Compute total pages so footer can render "X / Y".
    // 1 cover + 1 library-item per item + 1 page per shot + 1 exports (if any)
    const libPages = characters.length;
    const totalPages = 1 + libPages + shots.length + (exports.length ? 1 : 0);
    let pageNum = 0;

    // ─── Cover page ───────────────────────────────────────────────
    {
        let stream = '';
        pageNum = 1;
        stream = _pageHeader(stream, doc, project, 'Cover');
        stream = _coverPage(stream, doc, {
            projectName: project,
            title,
            projectSlug,
            generatedAt: generatedAt || new Date().toISOString(),
            characters,
            versionsByCharacter,
            shots,
        });
        stream = _pageFooter(stream, doc, pageNum, totalPages, projectSlug || project);
        doc.addPage(PAGE_W, PAGE_H, stream);
    }

    // ─── Library pages (one per item) ─────────────────────────────
    for (const item of characters) {
        const versions = versionsByItem[item.id] || [];
        const currentVersion = item.currentVersionId
            ? versionsByCharacter[item.currentVersionId]
            : (versions[0] || null);
        let stream = '';
        pageNum++;
        stream = _pageHeader(stream, doc, project, `Library / ${_kindBadge(item.kind)}`);
        stream = _libraryPage(stream, doc, item, versions, currentVersion);
        stream = _pageFooter(stream, doc, pageNum, totalPages, projectSlug || project);
        doc.addPage(PAGE_W, PAGE_H, stream);
    }

    // ─── Shot pages (one per shot) ────────────────────────────────
    for (const shot of shots) {
        let stream = '';
        pageNum++;
        stream = _pageHeader(stream, doc, project, `Shot #${shot.index || '?'}`);
        stream = _shotPage(stream, doc, shot, characters, versionsByItem, versionsByCharacter);
        stream = _pageFooter(stream, doc, pageNum, totalPages, projectSlug || project);
        doc.addPage(PAGE_W, PAGE_H, stream);
    }

    // ─── Exports page ─────────────────────────────────────────────
    if (exports.length) {
        let stream = '';
        pageNum++;
        stream = _pageHeader(stream, doc, project, 'Exports');
        stream = _exportsPage(stream, doc, exports);
        stream = _pageFooter(stream, doc, pageNum, totalPages, projectSlug || project);
        doc.addPage(PAGE_W, PAGE_H, stream);
    }

    return doc.finalize();
}

module.exports = { renderStoryboardPdf, embedImage, PDFDoc };