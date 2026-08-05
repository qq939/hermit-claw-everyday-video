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
//   - For ASCII we fall back to the codepoint itself (matches the
//     cmap for the BMP Latin block in NotoSansCJK).
//   - For anything else we look up via codeToCid; missing → CID 0
//     (.notdef glyph) so the reader doesn't crash.
function _cidHex(doc, text) {
    let out = '';
    const c2c = doc._cjk && doc._cjk.codeToCid;
    for (const ch of String(text)) {
        const cp = ch.codePointAt(0);
        let cid;
        if (c2c && c2c.has(cp)) {
            cid = c2c.get(cp);
        } else if (cp < 0x100) {
            // ASCII / Latin-1: the cmap uses CID = codepoint + 1, but
            // a few values are exposed directly via Identity-H too.
            // Try the +1 form first, then the raw codepoint.
            cid = c2c && c2c.has(cp + 1) ? c2c.get(cp + 1) : cp;
        } else {
            cid = 0; // .notdef
        }
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

function _wrap(text, max) {
    const out = [];
    const lines = String(text || '').split(/\r?\n/);
    for (const raw of lines) {
        if (!raw) { out.push(''); continue; }
        // Crude wrap: by character count (CJK-safe approximate).
        let line = '';
        for (const ch of raw) {
            line += ch;
            // Each CJK char counts as 2; ASCII counts as ~0.55.
            const widthApprox = [...line].reduce((acc, c) => acc + (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(c) ? 2 : 0.55), 0);
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

function _kindLabel(k) { return { character: '角色', scene: '场景', prop: '道具' }[k] || k || '-'; }

// Emit a Tj-ready payload for a string under either encoding:
//   - CJK installed: Identity-H "<hex16...>" (each codepoint = 2-byte CID)
//   - fallback:      WinAnsi-encoded literal "(...)"
function _t(doc, text) {
    const s = String(text == null ? '' : text);
    if (doc._useCJK) return _cidHex(doc, s);
    return `(${_esc(s)})`;
}

function renderStoryboardPdf({ title, project, characters, shots, versionsByCharacter, exports = [] }) {
    const doc = new PDFDoc();

    // Cover page.
    let y = PAGE_H - MARGIN;
    let stream = `BT /F2 22 Tf ${MARGIN} ${y} Td ${_t(doc, title || "Storyboard")} Tj ET\n`;
    y -= 30;
    stream += `BT /F1 10 Tf ${MARGIN} ${y} Td ${_t(doc, 'Generated: ' + new Date().toISOString())} Tj ET\n`;
    y -= 14;
    if (project) {
        stream += `BT /F1 10 Tf ${MARGIN} ${y} Td ${_t(doc, 'Project: ' + project)} Tj ET\n`;
        y -= 14;
    }
    stream += `BT /F1 10 Tf ${MARGIN} ${y} Td ${_t(doc, 'Hermit-Claw · storyboard')} Tj ET\n`;
    y -= 22;

    // Character / scene / prop roster on cover.
    stream += `BT /F2 13 Tf ${MARGIN} ${y} Td ${_t(doc, 'Roster')} Tj ET\n`;
    y -= 16;
    for (const c of characters) {
        const v = c.currentVersionId ? versionsByCharacter[c.currentVersionId] : null;
        const label = `· [${_kindLabel(c.kind)}] ${c.name}${v ? '  v' + v.versionNo : '  (no version yet)'}`;
        stream += `BT /F1 10 Tf ${MARGIN} ${y} Td ${_t(doc, label)} Tj ET\n`;
        y -= 12;
        if (y < MARGIN + 40) break;
    }

    doc.addPage(PAGE_W, PAGE_H, stream);

    // One page per shot.
    for (const shot of shots) {
        let y2 = PAGE_H - MARGIN;
        let s = '';
        s += `BT /F2 14 Tf ${MARGIN} ${y2} Td ${_t(doc, `Shot #${shot.index}  ·  v${shot.versionNo}`)} Tj ET\n`;
        y2 -= 18;
        s += `BT /F1 10 Tf ${MARGIN} ${y2} Td ${_t(doc, `${shot.tIn || '00:00'}  ->  ${shot.tOut || '00:05'}`)} Tj ET\n`;
        y2 -= 16;

        // Cast / scene / prop chips
        const lookupLabel = (vid, kindSlot, kindLabel2) => {
            const v = versionsByCharacter[vid];
            if (!v) return null;
            const c = characters.find((x) => x.id === v.itemId);
            return c ? `${c.name} v${v.versionNo}` : null;
        };
        const castLabels = (shot.castVersionIds || []).map((vid) => lookupLabel(vid, 'cast')).filter(Boolean);
        const sceneLabels = (shot.sceneVersionIds || []).map((vid) => lookupLabel(vid, 'scene')).filter(Boolean);
        const propLabels = (shot.propVersionIds || []).map((vid) => lookupLabel(vid, 'prop')).filter(Boolean);
        if (castLabels.length) {
            s += `BT /F1 10 Tf ${MARGIN} ${y2} Td ${_t(doc, 'Cast: ' + castLabels.join(' / '))} Tj ET\n`;
            y2 -= 13;
        }
        if (sceneLabels.length) {
            s += `BT /F1 10 Tf ${MARGIN} ${y2} Td ${_t(doc, 'Scene: ' + sceneLabels.join(' / '))} Tj ET\n`;
            y2 -= 13;
        }
        if (propLabels.length) {
            s += `BT /F1 10 Tf ${MARGIN} ${y2} Td ${_t(doc, 'Props: ' + propLabels.join(' / '))} Tj ET\n`;
            y2 -= 13;
        }
        y2 -= 4;

        // Description wrapped
        const descLines = _wrap(shot.description || '', 75);
        if (descLines.length) {
            s += `BT /F2 11 Tf ${MARGIN} ${y2} Td ${_t(doc, 'Description:')} Tj ET\n`;
            y2 -= 13;
            for (const line of descLines.slice(0, 24)) {
                s += `BT /F1 11 Tf ${MARGIN} ${y2} Td ${_t(doc, line)} Tj ET\n`;
                y2 -= 13;
            }
        }
        if (shot.notes) {
            y2 -= 4;
            s += `BT /F2 9 Tf ${MARGIN} ${y2} Td ${_t(doc, 'Notes:')} Tj ET\n`;
            y2 -= 11;
            for (const line of _wrap(shot.notes, 78).slice(0, 8)) {
                s += `BT /F1 9 Tf ${MARGIN} ${y2} Td ${_t(doc, line)} Tj ET\n`;
                y2 -= 11;
            }
        }

        // Box for the visual placeholder.
        const boxH = 180;
        const boxY = Math.max(MARGIN, MARGIN + 20);
        s += `0.85 0.85 0.85 RG 1 w ${MARGIN} ${boxY} ${PAGE_W - 2 * MARGIN} ${boxH} re S\n`;
        s += `0.55 0.55 0.55 RG 1 w ${MARGIN} ${boxY + boxH / 2} m ${PAGE_W - MARGIN} ${boxY + boxH / 2} l S\n`;
        s += `0.55 0.55 0.55 RG 1 w ${MARGIN + (PAGE_W - 2 * MARGIN) / 2} ${boxY} m ${MARGIN + (PAGE_W - 2 * MARGIN) / 2} ${boxY + boxH} l S\n`;
        s += `BT /F1 9 Tf ${MARGIN + 6} ${boxY + 6} Td ${_t(doc, 'visual preview placeholder')} Tj ET\n`;

        doc.addPage(PAGE_W, PAGE_H, s);
    }

    // Exports index page.
    if (exports.length) {
        let y3 = PAGE_H - MARGIN;
        let s = `BT /F2 14 Tf ${MARGIN} ${y3} Td ${_t(doc, 'Recent exports')} Tj ET\n`;
        y3 -= 18;
        for (const e of exports.slice(0, 30)) {
            s += `BT /F1 9 Tf ${MARGIN} ${y3} Td ${_t(doc, `${e.at}  ${e.obsKey || e.localPath}  ${e.status}`)} Tj ET\n`;
            y3 -= 11;
            if (y3 < MARGIN) break;
        }
        doc.addPage(PAGE_W, PAGE_H, s);
    }

    return doc.finalize();
}

module.exports = { renderStoryboardPdf, embedImage, PDFDoc };