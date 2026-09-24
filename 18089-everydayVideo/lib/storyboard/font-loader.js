// storyboard/font-loader.js
//
// Loads NotoSansCJK from the system fonts and prepares a CFF font +
// Identity-H ToUnicode CMap for embedding in a PDF.
//
// Why so much code: Node has no built-in font parser and we can't pull
// npm packages. PDF embeds CJK via CIDFont Type 0 (CFF) + Identity-H,
// so we need:
//   - the raw CFF table bytes (passed through as /FontFile3)
//   - the cmap parsed out (CMap codepoint → glyph CID)
//   - a ToUnicode CMap (CID → UTF-16BE) so the rendered text is
//     copy-pasteable from any PDF viewer
//
// We never modify the CFF binary — we just read it and map characters.
// PDF viewers handle subsetting themselves if /FirstChar /LastChar and
// /Widths[...] are present; for our use (always full CJK set) we just
// point at the whole file and supply the ToUnicode map.
//
// Memory: ~16 MB total, well inside the 228 MB cgroup.

const fs = require('fs');
const path = require('path');

const CANDIDATE_FONTS = [
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK.ttc',
];

let _cache = null;

function _findFontPath() {
    for (const p of CANDIDATE_FONTS) if (fs.existsSync(p)) return p;
    return null;
}

// Minimal TTF/OTF table reader. Skips parsing CFF charstrings; we just
// need offsets to lift the raw bytes through.
//
// In a TTC, the table directory's offset field is an *absolute* file
// offset, not subfont-relative. So we ignore the baseOffset argument
// here and store the offset exactly as it appears in the directory.
function _readTables(buf, baseOffset) {
    const nt = buf.readUInt16BE(baseOffset + 4);
    let p = baseOffset + 12;
    const tables = {};
    for (let i = 0; i < nt; i++) {
        const tag = buf.slice(p, p + 4).toString('ascii');
        const _cs = buf.readUInt32BE(p + 4);
        const off = buf.readUInt32BE(p + 8);
        const ln = buf.readUInt32BE(p + 12);
        tables[tag] = { offset: off, length: ln };
        p += 16;
    }
    return tables;
}

// Walk a cmap and collect format-12 (segmented for full Unicode) +
// format-4 (BMP) entries. Returns array of {code, glyphId}.
function _readCmap(buf, cmapOffset) {
    const version = buf.readUInt16BE(cmapOffset);
    const numSub = buf.readUInt16BE(cmapOffset + 2);
    const subs = [];
    for (let i = 0; i < numSub; i++) {
        const o = cmapOffset + 4 + i * 8;
        const pid = buf.readUInt16BE(o);
        const eid = buf.readUInt16BE(o + 2);
        const soff = buf.readUInt32BE(o + 4);
        subs.push({ pid, eid, off: cmapOffset + soff });
    }
    // Prefer format 12 (full Unicode), then format 4 (BMP).
    subs.sort((a, b) => {
        const score = (s) => (s.pid === 3 && s.eid === 10 ? 0 : (s.pid === 3 && s.eid === 1 ? 1 : 2));
        return score(a) - score(b);
    });
    const glyphs = new Map(); // code -> glyphId
    for (const s of subs) {
        const fmt = buf.readUInt16BE(s.off);
        if (fmt === 12) {
            const numGroups = buf.readUInt32BE(s.off + 12);
            let p = s.off + 16;
            for (let i = 0; i < numGroups; i++) {
                const startCharCode = buf.readUInt32BE(p);
                const endCharCode = buf.readUInt32BE(p + 4);
                const startGlyphID = buf.readUInt32BE(p + 8);
                p += 12;
                for (let c = startCharCode, g = startGlyphID; c <= endCharCode; c++, g++) {
                    glyphs.set(c, g);
                }
            }
            break;
        } else if (fmt === 4) {
            const segCountX2 = buf.readUInt16BE(s.off + 6);
            const segCount = segCountX2 / 2;
            let endCodes = [];
            let startCodes = [];
            let idDeltas = [];
            let idRangeOffsets = [];
            let p = s.off + 14;
            for (let i = 0; i < segCount; i++) endCodes.push(buf.readUInt16BE(p + i * 2));
            p += segCount * 2 + 2; // reservedPad
            for (let i = 0; i < segCount; i++) startCodes.push(buf.readUInt16BE(p + i * 2));
            p += segCount * 2;
            for (let i = 0; i < segCount; i++) idDeltas.push(buf.readInt16BE(p + i * 2));
            p += segCount * 2;
            const idRangeOffBase = p;
            for (let i = 0; i < segCount; i++) idRangeOffsets.push(buf.readUInt16BE(p + i * 2));
            p += segCount * 2;
            for (let i = 0; i < segCount; i++) {
                const ec = endCodes[i];
                const sc = startCodes[i];
                const d = idDeltas[i];
                const ro = idRangeOffsets[i];
                if (ec === 0xFFFF) continue;
                for (let c = sc; c <= ec; c++) {
                    let gid;
                    if (ro === 0) {
                        gid = (c + d) & 0xffff;
                    } else {
                        const glyphOffset = idRangeOffBase + i * 2 + ro + (c - sc) * 2;
                        gid = buf.readUInt16BE(glyphOffset);
                        if (gid !== 0) gid = (gid + d) & 0xffff;
                    }
                    glyphs.set(c, gid);
                }
            }
            break;
        }
    }
    return glyphs;
}

// Read hmtx to get advance widths for glyph IDs. Returns a Map
// gid -> width in font units. CFF/CIDFontType0 widths use the same
// hmtx table.
function _readHmtx(buf, tables) {
    const head = tables['head'];
    const hhea = tables['hhea'];
    const maxp = tables['maxp'];
    const hmtx = tables['hmtx'];
    if (!head || !hhea || !hmtx || !maxp) return new Map();
    const unitsPerEm = buf.readUInt16BE(head.offset + 18);
    const numLongMetrics = buf.readUInt16BE(hhea.offset + 34);
    const numGlyphs = buf.readUInt16BE(maxp.offset + 4);
    const widths = new Map();
    let p = hmtx.offset;
    for (let gid = 0; gid < numGlyphs; gid++) {
        const advance = buf.readUInt16BE(p);
        widths.set(gid, advance);
        p += 4;
        if (gid >= numLongMetrics - 1) p -= 2; // skip lsb for non-long-metric glyphs
    }
    return { widths, unitsPerEm };
}

// Build a ToUnicode CMap. The cmap is a text-format PDF stream:
//   /CIDInit /ProcSet findresource begin
//   12 dict begin
//   begincmap
//   ...
//   1 begincidrange <utf16lo> <utf16hi> <cidlo>
//   endcidrange
//   ...
//   endcmap
//   CMapName currentdict /CMap defineresource pop
//   end
//   end
function _buildToUnicodeCMap(codeToCid) {
    // PDF ToUnicode CMap maps what appears in the content stream (under
    // Identity-H, two-byte CID) -> UTF-16BE Unicode codepoint.
    //
    //   beginbfchar  : <srcCID> <dstUnicode>      (one CID -> one unicode)
    //   beginbfrange : <srcCIDLo> <srcCIDHi> <dstUnicodeStart>
    //                 (a run of CIDs -> consecutive unicodes starting at
    //                 dstUnicodeStart; dstUnicodeStart + (cid - srcLo))
    //
    // We dedupe by CID first (one Unicode per CID — picking the
    // smallest unicode when several CJK variations share a glyph), sort
    // by CID, then emit ranges when CIDs are consecutive AND their
    // chosen unicodes are also consecutive; otherwise bfchar.
    const cidToCode = new Map();
    for (const [code, cid] of codeToCid.entries()) {
        // Skip CIDs > 0xFFFF — Identity-H is 16-bit so they can't
        // appear in the content stream or in the CMap entries.
        if (cid > 0xFFFF) continue;
        const prev = cidToCode.get(cid);
        if (prev === undefined || code < prev) cidToCode.set(cid, code);
    }
    const entries = [];
    for (const [cid, code] of cidToCode.entries()) entries.push({ code, cid });
    entries.sort((a, b) => a.cid - b.cid);

    const lines = [
        '/CIDInit /ProcSet findresource begin',
        '12 dict begin',
        'begincmap',
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
        '/CMapName /Adobe-Identity-UCS def',
        '/CMapType 2 def',
        '1 begincodespacerange',
        '<0000> <FFFF>',
        'endcodespacerange',
    ];
    const bfcharLines = [];
    const bfrangeLines = [];
    let i = 0;
    if (process.env.SB_DEBUG_CMAP) console.error('[font-loader] entries.length:', entries.length, 'first:', entries[0], 'second:', entries[1], '15th:', entries[15]);
    while (i < entries.length) {
        const start = entries[i];
        // Try to extend a run of consecutive CIDs whose mapped unicodes
        // are also consecutive (so we can use a single bfrange entry).
        let j = i;
        while (
            j + 1 < entries.length &&
            entries[j + 1].cid === entries[j].cid + 1 &&
            entries[j + 1].code === entries[j].code + 1
        ) j++;
        if (process.env.SB_DEBUG_CMAP && i < 3) console.error('[font-loader] bfrange group', i, 'cid', start.cid, '..', entries[j].cid, 'code', start.code, '..', entries[j].code);
        if (j === i) {
            bfcharLines.push(`<${_hex4(start.cid)}> <${_hex4(start.code)}>`);
        } else {
            const end = entries[j];
            bfrangeLines.push(`<${_hex4(start.cid)}> <${_hex4(end.cid)}> <${_hex4(start.code)}>`);
        }
        i = j + 1;
    }
    if (bfcharLines.length) {
        lines.push(`${bfcharLines.length} beginbfchar`);
        for (const l of bfcharLines) lines.push(l);
        lines.push('endbfchar');
    }
    if (bfrangeLines.length) {
        lines.push(`${bfrangeLines.length} beginbfrange`);
        for (const l of bfrangeLines) lines.push(l);
        lines.push('endbfrange');
    }
    lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
    return Buffer.from(lines.join('\n'), 'utf8');
}

function _hex4(n) {
    // Identity-H uses 16-bit CIDs; clamp anything higher so the
    // codespace / bfchar entries stay at exactly 4 hex chars.
    if (n > 0xFFFF) n = 0;
    return n.toString(16).padStart(4, '0').toUpperCase();
}

// Encodes a string as 2-byte big-endian CID bytes for use in content
// streams under Identity-H. Returns hex pair per char.
//   <0000> = char at code 0
//   <4e2d> = 中
function _stringToCidHex(text) {
    const cps = [];
    for (const ch of String(text)) {
        cps.push(ch.codePointAt(0));
    }
    return cps.map(_hex4).join('');
}

// Main entry. Returns { ok, cffBytes, cmapBytes, widths, unitsPerEm, codeToCid }
// or { ok: false, error }.
function loadCJKFont() {
    if (_cache) return _cache;
    const fp = _findFontPath();
    if (!fp) return { ok: false, error: 'NotoSansCJK not found on system' };
    try {
        const ttc = fs.readFileSync(fp);
        if (ttc.slice(0, 4).toString('ascii') !== 'ttcf') {
            return { ok: false, error: 'font file is not a TTC' };
        }
        const subOffset = ttc.readUInt32BE(12); // first subfont
        const tables = _readTables(ttc, subOffset);
        if (!tables['CFF '] || !tables['cmap'] || !tables['hmtx']) {
            return { ok: false, error: 'required tables missing in CJK font' };
        }
        const cffBytes = ttc.slice(tables['CFF '].offset, tables['CFF '].offset + tables['CFF '].length);
        const codeToCid = _readCmap(ttc, tables['cmap'].offset);
        const { widths, unitsPerEm } = _readHmtx(ttc, tables);
        // Build a ToUnicode CMap covering only the codepoints we mapped
        // (full CJK = thousands; the CMap still stays small because we
        // compress into beginbfrange wherever consecutive runs allow).
        const cmapBytes = _buildToUnicodeCMap(codeToCid);
        _cache = {
            ok: true,
            fontPath: fp,
            cffBytes,
            cmapBytes,
            widths, // Map<gid, advance in font units>
            unitsPerEm,
            codeToCid,
            stringToCidHex: _stringToCidHex,
        };
        return _cache;
    } catch (e) {
        return { ok: false, error: `font load failed: ${e.message}` };
    }
}

// Reset cache (used when storyboard content changes — but ToUnicode is
// always built off the FULL cmap, so cache is fine to keep across calls).
function _reset() { _cache = null; }

module.exports = { loadCJKFont, _reset };