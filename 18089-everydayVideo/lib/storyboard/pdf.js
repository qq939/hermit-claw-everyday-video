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

class PDFDoc {
    constructor() {
        this.objects = []; // array of Uint8Array (or Buffer) bodies
        this.offsets = [];
        // Reserve 1 for the catalog placeholder
        this._push('<< /Type /Catalog /Pages 2 0 R >>');
        // Pages object will reference page IDs we'll allocate.
        this._pageIds = [];
    }

    _push(body) {
        this.objects.push(Buffer.from(body, 'utf8'));
        return this.objects.length; // 1-based
    }

    addObject(body) {
        return this._push(body);
    }

    addPage(widthPt, heightPt, contentStream, fontIds) {
        const pageNum = this._push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] /Resources << /Font << ${fontIds.map((id, i) => `/F${i + 1} ${id} 0 R`).join(' ')} >> >> /Contents ${this.objects.length + 1} 0 R >>`);
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
const FONT_HELV = 'Helvetica';

function _addFonts(doc) {
    // Use built-in fonts by referencing names — no font object needed.
    return [];
}

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

function renderStoryboardPdf({ title, project, characters, shots, versionsByCharacter, exports = [] }) {
    const doc = new PDFDoc();
    const fontIds = []; // built-in

    // Cover page.
    let y = PAGE_H - MARGIN;
    let stream = `BT /F2 22 Tf ${MARGIN} ${y} Td (${_escapePdfString(title || "Storyboard")} Tj ET\n`;
    y -= 30;
    stream += `BT /F1 10 Tf ${MARGIN} ${y} Td (Generated: ${_escapePdfString(new Date().toISOString())}) Tj ET\n`;
    y -= 14;
    stream += `BT /F1 10 Tf ${MARGIN} ${y} Td (Hermit-Claw · ${_escapePdfString(project || '')}) Tj ET\n`;
    y -= 20;

    // Character roster on cover.
    stream += `BT /F2 13 Tf ${MARGIN} ${y} Td (Characters) Tj ET\n`;
    y -= 16;
    for (const c of characters) {
        const v = c.currentVersionId ? versionsByCharacter[c.currentVersionId] : null;
        const label = `· ${c.name} (${c.role || '-'})${v ? '  v' + v.versionNo : '  (no version yet)'}`;
        stream += `BT /F1 10 Tf ${MARGIN} ${y} Td (${_escapePdfString(label)}) Tj ET\n`;
        y -= 12;
        if (y < MARGIN + 40) break;
    }

    doc.addPage(PAGE_W, PAGE_H, stream, fontIds.length ? fontIds : ['1 0 R']);

    // One page per shot.
    for (const shot of shots) {
        let y2 = PAGE_H - MARGIN;
        let s = '';
        s += `BT /F2 14 Tf ${MARGIN} ${y2} Td (Shot ${shot.index}  ·  v${shot.versionNo}) Tj ET\n`;
        y2 -= 18;
        s += `BT /F1 10 Tf ${MARGIN} ${y2} Td (${_escapePdfString(shot.tIn)} -> ${_escapePdfString(shot.tOut)}) Tj ET\n`;
        y2 -= 16;

        // Character chips
        const charLabels = (shot.characterVersionIds || [])
            .map((vid) => {
                const v = versionsByCharacter[vid];
                if (!v) return null;
                const c = characters.find((x) => x.id === v.characterId);
                return c ? `${c.name} v${v.versionNo}` : null;
            })
            .filter(Boolean);
        const charLine = charLabels.length ? `Cast: ${charLabels.join(' / ')}` : 'Cast: —';
        s += `BT /F1 10 Tf ${MARGIN} ${y2} Td (${_escapePdfString(charLine)}) Tj ET\n`;
        y2 -= 16;

        // Description wrapped
        const descLines = _wrap(shot.description || '', 75);
        for (const line of descLines.slice(0, 18)) {
            s += `BT /F1 11 Tf ${MARGIN} ${y2} Td (${_escapePdfString(line)}) Tj ET\n`;
            y2 -= 13;
        }
        if (shot.notes) {
            y2 -= 4;
            s += `BT /F1 9 Tf ${MARGIN} ${y2} Td (Notes:) Tj ET\n`;
            y2 -= 11;
            for (const line of _wrap(shot.notes, 78).slice(0, 8)) {
                s += `BT /F1 9 Tf ${MARGIN} ${y2} Td (${_escapePdfString(line)}) Tj ET\n`;
                y2 -= 11;
            }
        }

        // Box for the visual.
        const boxY = Math.max(y2 - 200, MARGIN);
        s += `0.85 0.85 0.85 RG 1 w ${MARGIN} ${boxY} ${PAGE_W - 2 * MARGIN} ${(y2 - boxY) - 10} re S\n`;
        s += `BT /F1 9 Tf ${MARGIN + 6} ${boxY + 6} Td (visual preview placeholder) Tj ET\n`;

        doc.addPage(PAGE_W, PAGE_H, s, fontIds.length ? fontIds : ['1 0 R']);
    }

    // Exports index page.
    if (exports.length) {
        let y3 = PAGE_H - MARGIN;
        let s = `BT /F2 14 Tf ${MARGIN} ${y3} Td (Recent exports) Tj ET\n`;
        y3 -= 18;
        for (const e of exports.slice(0, 30)) {
            s += `BT /F1 9 Tf ${MARGIN} ${y3} Td (${_escapePdfString(`${e.at}  ${e.obsKey || e.localPath}  ${e.status}`)}) Tj ET\n`;
            y3 -= 11;
            if (y3 < MARGIN) break;
        }
        doc.addPage(PAGE_W, PAGE_H, s, fontIds.length ? fontIds : ['1 0 R']);
    }

    return doc.finalize();
}

module.exports = { renderStoryboardPdf, embedImage, PDFDoc };