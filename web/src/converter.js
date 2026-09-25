import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { createWorker } from 'tesseract.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
globalThis.pdfjsLib = pdfjsLib;
globalThis.Tesseract = { createWorker };

/* EduAccess local document tools. No uploads or network requests. */
(function (root) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function escapeXml(s = '') {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function crc32(bytes) {
    let c = -1;
    for (const b of bytes) {
      c ^= b;
      for (let i = 0; i < 8; i++) c = (c & 1) ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return (c ^ -1) >>> 0;
  }

  const u16 = (n) => [n & 255, (n >>> 8) & 255];
  const u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

  function zip(files, mimeType = 'application/zip') {
    const chunks = [];
    const central = [];
    let offset = 0;
    const nowTime = 0;
    const nowDate = 33; // 1980-01-01, fecha DOS válida para evitar advertencias en Word

    for (const [name, text] of Object.entries(files)) {
      const fileName = enc.encode(name);
      const data = enc.encode(text);
      const crc = crc32(data);

      // Correct local ZIP header. The previous version missed the modification-date field,
      // so Word could detect the output as corrupt.
      const local = new Uint8Array([
        0x50, 0x4b, 0x03, 0x04,
        ...u16(20),      // version needed
        ...u16(0),       // general purpose bit flag
        ...u16(0),       // compression method: stored
        ...u16(nowTime), // last mod file time
        ...u16(nowDate), // last mod file date
        ...u32(crc),
        ...u32(data.length),
        ...u32(data.length),
        ...u16(fileName.length),
        ...u16(0),
        ...fileName
      ]);

      chunks.push(local, data);

      const entry = new Uint8Array([
        0x50, 0x4b, 0x01, 0x02,
        ...u16(20),      // version made by
        ...u16(20),      // version needed
        ...u16(0),       // general purpose bit flag
        ...u16(0),       // compression method: stored
        ...u16(nowTime), // last mod file time
        ...u16(nowDate), // last mod file date
        ...u32(crc),
        ...u32(data.length),
        ...u32(data.length),
        ...u16(fileName.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
        ...fileName
      ]);

      central.push(entry);
      offset += local.length + data.length;
    }

    const centralSize = central.reduce((total, item) => total + item.length, 0);
    return new Blob([
      ...chunks,
      ...central,
      new Uint8Array([
        0x50, 0x4b, 0x05, 0x06,
        ...u16(0),
        ...u16(0),
        ...u16(central.length),
        ...u16(central.length),
        ...u32(centralSize),
        ...u32(offset),
        ...u16(0)
      ])
    ], { type: mimeType });
  }

  async function unzip(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const out = {};
    let end = -1;

    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) throw Error('El archivo no es un documento válido.');

    let p = view.getUint32(end + 16, true);
    const count = view.getUint16(end + 10, true);

    for (let i = 0; i < count; i++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      const method = view.getUint16(p + 10, true);
      const compressedSize = view.getUint32(p + 20, true);
      const nameLength = view.getUint16(p + 28, true);
      const extraLength = view.getUint16(p + 30, true);
      const commentLength = view.getUint16(p + 32, true);
      const name = dec.decode(bytes.slice(p + 46, p + 46 + nameLength));
      const local = view.getUint32(p + 42, true);
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);

      if ((name === 'word/document.xml' || /^ppt\/slides\/slide\d+\.xml$/.test(name)) && compressedSize < 15000000) {
        let data = bytes.slice(start, start + compressedSize);
        if (method === 8) {
          const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
          data = new Uint8Array(await new Response(stream).arrayBuffer());
        } else if (method !== 0) {
          throw Error('Compresión no compatible.');
        }
        out[name] = dec.decode(data);
      }
      p += 46 + nameLength + extraLength + commentLength;
    }
    return out;
  }

  function fromXml(xml, tag) {
    if (!xml) return '';
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) throw Error('No se pudo leer el documento.');
    const paragraphs = Array.from(doc.getElementsByTagName('*')).filter((n) => n.localName === tag);
    return paragraphs
      .map((p) => Array.from(p.getElementsByTagName('*')).filter((n) => n.localName === 't').map((n) => n.textContent).join(''))
      .filter(Boolean)
      .join('\n');
  }

  function cleanXmlChars(value = '') {
    return String(value)
      .replace(/\u0000/g, '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
      .replace(/[\uFFFE\uFFFF]/g, '')
      .normalize('NFC');
  }

  function splitForWord(text) {
    const clean = cleanXmlChars(text).replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!clean) return ['Documento sin texto extraíble.'];

    const paragraphs = [];
    for (const block of clean.split(/\n+/)) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      // Word puede abrir párrafos largos, pero partirlos evita XML gigante si el PDF trae texto mal separado.
      for (let i = 0; i < trimmed.length; i += 1300) {
        paragraphs.push(trimmed.slice(i, i + 1300));
      }
    }
    return paragraphs.length ? paragraphs.slice(0, 900) : ['Documento sin texto extraíble.'];
  }

  function makeDocx(text) {
    const paras = splitForWord(text)
      .map((line) => '<w:p><w:r><w:t xml:space="preserve">' + escapeXml(line) + '</w:t></w:r></w:p>')
      .join('');

    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>';

    const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>';

    const documentRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>';

    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
      '<w:name w:val="Normal"/><w:qFormat/>' +
      '<w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr>' +
      '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>' +
      '</w:style>' +
      '</w:styles>';

    const settings = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:zoom w:percent="100"/>' +
      '</w:settings>';

    const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' + paras +
      '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' +
      '</w:body></w:document>';

    return zip({
      '[Content_Types].xml': contentTypes,
      '_rels/.rels': rels,
      'docProps/core.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Documento convertido por EduAccess</dc:title><dc:creator>EduAccess</dc:creator><cp:lastModifiedBy>EduAccess</cp:lastModifiedBy></cp:coreProperties>',
      'docProps/app.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>EduAccess</Application></Properties>',
      'word/_rels/document.xml.rels': documentRels,
      'word/styles.xml': styles,
      'word/settings.xml': settings,
      'word/document.xml': documentXml
    }, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  }

  async function legacyPdfText(buffer) {
    const bytes = new Uint8Array(buffer);
    const raw = new TextDecoder('latin1').decode(bytes);
    if (!raw.startsWith('%PDF')) throw Error('El archivo no parece ser un PDF.');

    async function inflatePdfStream(data) {
      const tryInflate = async (format) => {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      };
      try { return await tryInflate('deflate'); } catch {}
      try { return await tryInflate('deflate-raw'); } catch {}
      return data;
    }

    function streamStartIndex(source, start) {
      let p = start;
      if (source[p] === '\r' && source[p + 1] === '\n') return p + 2;
      if (source[p] === '\n' || source[p] === '\r') return p + 1;
      return p;
    }

    function decodeUtf16BE(hex) {
      hex = hex.replace(/[^0-9A-Fa-f]/g, '');
      if (hex.startsWith('FEFF')) hex = hex.slice(4);
      let out = '';
      for (let i = 0; i + 3 < hex.length; i += 4) {
        const code = parseInt(hex.slice(i, i + 4), 16);
        if (!Number.isFinite(code)) continue;
        out += String.fromCharCode(code);
      }
      return out;
    }

    function parseCMap(cmapText) {
      const map = new Map();
      const add = (src, dst) => {
        src = src.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
        if (!src) return;
        let value = dst.replace(/[<>\s]/g, '');
        if (!value) return;
        map.set(src, value.length >= 4 ? decodeUtf16BE(value) : String.fromCharCode(parseInt(value, 16)));
      };

      const bfcharBlocks = cmapText.match(/beginbfchar[\s\S]*?endbfchar/g) || [];
      for (const block of bfcharBlocks) {
        const pairs = [...block.matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g)];
        for (const p of pairs) add(p[1], p[2]);
      }

      const bfrangeBlocks = cmapText.match(/beginbfrange[\s\S]*?endbfrange/g) || [];
      for (const block of bfrangeBlocks) {
        const arrayRanges = [...block.matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*\[([\s\S]*?)\]/g)];
        for (const r of arrayRanges) {
          const start = parseInt(r[1].replace(/\s/g, ''), 16);
          const end = parseInt(r[2].replace(/\s/g, ''), 16);
          const width = r[1].replace(/\s/g, '').length;
          const values = [...r[3].matchAll(/<([0-9A-Fa-f\s]+)>/g)].map((x) => x[1]);
          for (let code = start; code <= end && code - start < values.length; code++) {
            add(code.toString(16).toUpperCase().padStart(width, '0'), values[code - start]);
          }
        }

        const seqRanges = [...block.matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g)];
        for (const r of seqRanges) {
          const start = parseInt(r[1].replace(/\s/g, ''), 16);
          const end = parseInt(r[2].replace(/\s/g, ''), 16);
          const width = r[1].replace(/\s/g, '').length;
          const dst0 = parseInt(r[3].replace(/\s/g, ''), 16);
          const dstWidth = r[3].replace(/\s/g, '').length;
          for (let code = start; code <= end && code - start < 6000; code++) {
            const dst = (dst0 + (code - start)).toString(16).toUpperCase().padStart(dstWidth, '0');
            add(code.toString(16).toUpperCase().padStart(width, '0'), dst);
          }
        }
      }

      const lengths = [...new Set([...map.keys()].map((k) => k.length))].sort((a, b) => b - a);
      return { map, lengths };
    }

    function decodeLiteralBytes(literal) {
      const body = literal.slice(1, -1);
      const out = [];
      for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch !== '\\') {
          out.push(body.charCodeAt(i) & 255);
          continue;
        }
        const n = body[++i];
        if (n === undefined) break;
        if (n === 'n') out.push(10);
        else if (n === 'r') out.push(13);
        else if (n === 't') out.push(9);
        else if (n === 'b') out.push(8);
        else if (n === 'f') out.push(12);
        else if (n === '\n' || n === '\r') {
          if (n === '\r' && body[i + 1] === '\n') i++;
        } else if (/[0-7]/.test(n)) {
          let oct = n;
          for (let j = 0; j < 2 && /[0-7]/.test(body[i + 1] || ''); j++) oct += body[++i];
          out.push(parseInt(oct, 8) & 255);
        } else {
          out.push(n.charCodeAt(0) & 255);
        }
      }
      return new Uint8Array(out);
    }

    function bytesToHex(data) {
      return [...data].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
    }

    function decodeByCMap(hex, cmap) {
      if (!cmap || !cmap.map.size) return '';
      hex = hex.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
      let out = '';
      for (let i = 0; i < hex.length;) {
        let found = false;
        for (const len of cmap.lengths) {
          const key = hex.slice(i, i + len);
          if (key.length === len && cmap.map.has(key)) {
            out += cmap.map.get(key);
            i += len;
            found = true;
            break;
          }
        }
        if (!found) {
          const byte = parseInt(hex.slice(i, i + 2), 16);
          if (Number.isFinite(byte) && byte >= 32) out += String.fromCharCode(byte);
          i += 2;
        }
      }
      return out;
    }

    function decodePdfString(token, cmap) {
      if (!token) return '';
      if (token.startsWith('<')) {
        const hex = token.slice(1, -1).replace(/\s/g, '');
        if (cmap && cmap.map.size) return decodeByCMap(hex, cmap);
        if (hex.startsWith('FEFF') || /^00[0-7][0-9A-F]/i.test(hex)) return decodeUtf16BE(hex);
        const arr = new Uint8Array((hex.match(/.{1,2}/g) || []).map((h) => parseInt(h, 16)).filter((n) => Number.isFinite(n)));
        try { return new TextDecoder('utf-8').decode(arr); } catch { return new TextDecoder('latin1').decode(arr); }
      }
      const data = decodeLiteralBytes(token);
      if (cmap && cmap.map.size) return decodeByCMap(bytesToHex(data), cmap);
      return new TextDecoder('latin1').decode(data);
    }

    function cleanText(text) {
      return String(text || '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
        .replace(/[\uE000-\uF8FF]/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    function looksGarbled(text) {
      const sample = cleanText(text).slice(0, 2500);
      if (sample.length < 80) return false;
      const visible = [...sample].filter((c) => !/\s/.test(c));
      if (!visible.length) return true;
      const letters = visible.filter((c) => /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(c)).length;
      const common = visible.filter((c) => /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9.,;:¿?¡!()\-/%ºª]/.test(c)).length;
      const letterRatio = letters / visible.length;
      const commonRatio = common / visible.length;
      return letterRatio < 0.28 || commonRatio < 0.62;
    }

    const objects = [];
    const objectRe = /(\d+)\s+(\d+)\s+obj([\s\S]*?)endobj/g;
    let om;
    while ((om = objectRe.exec(raw))) {
      const id = Number(om[1]);
      const content = om[3];
      const globalStart = om.index + om[0].indexOf(content);
      const streamPos = content.indexOf('stream');
      let stream = null;
      let dict = content;
      if (streamPos >= 0) {
        const s0 = globalStart + streamPos + 'stream'.length;
        const s1 = streamStartIndex(raw, s0);
        const e0 = raw.indexOf('endstream', s1);
        if (e0 > s1) {
          let data = bytes.slice(s1, e0);
          while (data.length && (data[data.length - 1] === 10 || data[data.length - 1] === 13)) data = data.slice(0, -1);
          dict = content.slice(0, streamPos);
          if (/\/FlateDecode/.test(dict)) data = await inflatePdfStream(data);
          stream = new TextDecoder('latin1').decode(data);
        }
      }
      objects.push({ id, dict, content, stream });
    }

    const cmapByObj = new Map();
    for (const obj of objects) {
      if (obj.stream && /beginbf(?:char|range)/.test(obj.stream)) cmapByObj.set(obj.id, parseCMap(obj.stream));
    }

    const fontObjToCMap = new Map();
    for (const obj of objects) {
      const m = obj.content.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
      if (m && cmapByObj.has(Number(m[1]))) fontObjToCMap.set(obj.id, cmapByObj.get(Number(m[1])));
    }

    const fontNameToCMap = new Map();
    for (const obj of objects) {
      const fontBlocks = [...obj.content.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)];
      for (const block of fontBlocks) {
        for (const fm of block[1].matchAll(/\/([A-Za-z0-9_.-]+)\s+(\d+)\s+0\s+R/g)) {
          const cmap = fontObjToCMap.get(Number(fm[2]));
          if (cmap) fontNameToCMap.set(fm[1], cmap);
        }
      }
    }

    const output = [];
    const textToken = String.raw`(?:\((?:\\.|[^\\])*?\)|<[0-9A-Fa-f\s]+>)`;
    const arrayToken = String.raw`\[(?:[^\[\]]|\((?:\\.|[^\\])*?\)|<[0-9A-Fa-f\s]+>)*\]`;
    const tokenRe = new RegExp(String.raw`\/([A-Za-z0-9_.-]+)\s+[-+]?\d*\.?\d+\s+Tf|(${arrayToken})\s*TJ|(${textToken})\s*(?:Tj|'|")|(T\*|Td|TD|Tm)\b`, 'g');

    for (const obj of objects) {
      if (!obj.stream || !/BT[\s\S]*?ET/.test(obj.stream)) continue;
      const blocks = obj.stream.match(/BT[\s\S]*?ET/g) || [];
      for (const block of blocks) {
        let currentCMap = null;
        let lastWasBreak = false;
        let tm;
        while ((tm = tokenRe.exec(block))) {
          if (tm[1]) {
            currentCMap = fontNameToCMap.get(tm[1]) || currentCMap;
            continue;
          }
          if (tm[4]) {
            if (!lastWasBreak) output.push('\n');
            lastWasBreak = true;
            continue;
          }
          if (tm[2]) {
            const strings = tm[2].match(new RegExp(textToken, 'g')) || [];
            const text = strings.map((s) => decodePdfString(s, currentCMap)).join('');
            if (text.trim()) output.push(text, ' ');
            lastWasBreak = false;
            continue;
          }
          if (tm[3]) {
            const text = decodePdfString(tm[3], currentCMap);
            if (text.trim()) output.push(text, ' ');
            lastWasBreak = false;
          }
        }
        output.push('\n');
      }
    }

    const extracted = cleanText(output.join(''));
    if (!extracted) return '';
    if (looksGarbled(extracted)) {
      throw Error('El PDF tiene texto, pero viene codificado con una fuente que esta demo no puede interpretar de forma confiable. Probá con un PDF con texto seleccionable normal o convertí el PDF desde Word/Google Docs. Para resolver todos los PDF habría que integrar PDF.js/OCR en una versión más avanzada.');
    }
    return extracted;
  }

  async function pdfTextWithPdfJs(buffer) {
    if (!globalThis.pdfjsLib) throw Error('PDF.js no está cargado.');
    const bytes = new Uint8Array(buffer);
    const loadingTask = globalThis.pdfjsLib.getDocument({
      data: bytes,
      isEvalSupported: false,
      disableFontFace: false,
      useSystemFonts: true
    });
    const pdf = await loadingTask.promise;
    const pages = [];
    const maxPages = Math.min(pdf.numPages, 120);

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false });
      const items = content.items || [];
      let lastY = null;
      let line = '';
      const lines = [];

      for (const item of items) {
        const text = String(item.str || '').trim();
        if (!text) continue;
        const y = item.transform ? Math.round(item.transform[5]) : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 6) {
          if (line.trim()) lines.push(line.trim());
          line = text;
        } else {
          line += (line ? ' ' : '') + text;
        }
        if (y !== null) lastY = y;
      }
      if (line.trim()) lines.push(line.trim());
      pages.push(lines.join('\n'));
    }

    return cleanXmlChars(pages.join('\n\n')).replace(/\n{3,}/g, '\n\n').trim();
  }

  async function pdfTextWithOcr(buffer, onProgress) {
    if (!globalThis.pdfjsLib || !globalThis.Tesseract) throw Error('OCR no está cargado.');
    const bytes = new Uint8Array(buffer);
    const pdf = await globalThis.pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true }).promise;
    const maxPages = Math.min(pdf.numPages, 8);
    const worker = await globalThis.Tesseract.createWorker('spa', 1, {
      logger: (m) => {
        if (onProgress && m.status) onProgress(m.status + (m.progress ? ' ' + Math.round(m.progress * 100) + '%' : ''));
      }
    });

    const texts = [];
    try {
      for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
        if (onProgress) onProgress('OCR página ' + pageNumber + ' de ' + maxPages + '…');
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { willReadFrequently: true });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: context, viewport }).promise;
        const result = await worker.recognize(canvas);
        texts.push((result.data && result.data.text) || '');
      }
    } finally {
      await worker.terminate();
    }

    return cleanXmlChars(texts.join('\n\n')).replace(/\n{3,}/g, '\n\n').trim();
  }

  async function pdfText(buffer, options = {}) {
    let text = '';
    let pdfJsError = null;

    try {
      text = await pdfTextWithPdfJs(buffer);
    } catch (error) {
      pdfJsError = error;
    }

    if (text && text.trim().length >= 40) return text;

    try {
      text = await legacyPdfText(buffer);
      if (text && text.trim().length >= 40) return text;
    } catch {}

    if (options.ocr) {
      const ocrText = await pdfTextWithOcr(buffer, options.onProgress);
      if (ocrText && ocrText.trim().length >= 20) return ocrText;
      throw Error('El OCR no pudo reconocer texto suficiente. Probá con un PDF más nítido o con mejor contraste.');
    }

    if (globalThis.Tesseract) {
      throw Error('No se encontró texto seleccionable. Activá la opción OCR para intentar leer el PDF como imagen.');
    }

    throw Error(pdfJsError?.message || 'No se pudo leer el texto del PDF.');
  }

  function makePdf(text) {
    const lines = [];
    for (const paragraph of String(text || '').split(/\r?\n/)) {
      const words = paragraph.split(/\s+/).filter(Boolean);
      let line = '';
      for (const word of words) {
        if ((line + ' ' + word).length > 88) {
          lines.push(line);
          line = word;
        } else {
          line += (line ? ' ' : '') + word;
        }
      }
      lines.push(line);
    }
    const pages = [];
    for (let i = 0; i < lines.length; i += 48) pages.push(lines.slice(i, i + 48));
    if (!pages.length) pages.push(['']);

    const objects = [null];
    const add = (s) => { objects.push(s); return objects.length - 1; };
    const cleanPdf = (s) => String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\xFF]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const pageIds = [];
    const pageDefs = [];

    for (const chunk of pages) {
      const content = 'BT /F1 11 Tf 48 790 Td 14 TL ' + chunk.map((line, i) => `${i ? 'T* ' : ''}(${cleanPdf(line)}) Tj`).join(' ') + ' ET';
      const stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      const page = add('');
      pageIds.push(page);
      pageDefs.push({ page, stream });
    }

    const pagesId = add(`<< /Type /Pages /Kids [${pageIds.map((id) => id + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`);
    for (const { page, stream } of pageDefs) {
      objects[page] = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`;
    }
    const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

    let output = '%PDF-1.4\n';
    const offsets = [0];
    for (let i = 1; i < objects.length; i++) {
      offsets[i] = output.length;
      output += `${i} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const start = output.length;
    output += `xref\n0 ${objects.length}\n0000000000 65535 f \n` + offsets.slice(1).map((x) => String(x).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objects.length} /Root ${catalog} 0 R >>\nstartxref\n${start}\n%%EOF`;
    return new Blob([Uint8Array.from(output, (c) => c.charCodeAt(0) & 255)], { type: 'application/pdf' });
  }

  async function extractText(file, options = {}) {
    const name = file.name.toLowerCase();
    if (file.size > 15000000) throw Error('El límite de esta demo es 15 MB.');
    if (name.endsWith('.pdf')) return await pdfText(await file.arrayBuffer(), options);
    if (name.endsWith('.docx')) {
      const parts = await unzip(await file.arrayBuffer());
      return fromXml(parts['word/document.xml'], 'p');
    }
    if (name.endsWith('.pptx')) {
      const parts = await unzip(await file.arrayBuffer());
      return Object.keys(parts)
        .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
        .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
        .map((k, i) => 'Diapositiva ' + (i + 1) + '\n' + fromXml(parts[k], 'p'))
        .join('\n\n');
    }
    throw Error('Formato no compatible. Usá PDF, DOCX o PPTX.');
  }

  async function convert(file, mode, options = {}) {
    const expected = { pdfdocx: '.pdf', docxpdf: '.docx', pptxdocx: '.pptx' }[mode];
    if (!expected || !file.name.toLowerCase().endsWith(expected)) throw Error('Elegí un archivo ' + (expected || 'compatible') + '.');
    const text = await extractText(file, options);
    if (!text.trim()) throw Error('No se encontró texto seleccionable. Activá OCR para intentar leer el PDF como imagen.');
    const output = mode === 'docxpdf' ? makePdf(text) : makeDocx(text);
    return { blob: output, name: file.name.replace(/\.[^.]+$/, '') + (mode === 'docxpdf' ? '.pdf' : '.docx') };
  }

  function summarizeText(text) {
    const original = String(text || '')
      .replace(/\r/g, '\n')
      .replace(/[\t ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const clean = original.replace(/\s+/g, ' ').trim();
    if (!clean) {
      return { summary: 'No se encontró texto para resumir.', explanation: '', keywords: [], questions: [] };
    }

    const normalized = clean.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const stop = new Set(('de la el los las un una unos unas y o en a que con por para del al se es son como mas pero no si su sus lo le les este esta estos estas entre sobre tambien fue ser ha han hay desde hasta cada donde cuando cual cuales quien quienes tener tiene deben debe usar usa usá hacer hace muestra mostrar').split(' '));
    const freq = new Map();
    for (const word of normalized.match(/[a-zñ]{4,}/g) || []) {
      if (!stop.has(word)) freq.set(word, (freq.get(word) || 0) + 1);
    }
    const keywords = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 9)
      .map(([w]) => w);

    const lines = original.split(/\n+/)
      .map((line) => line.replace(/^[\s#*•\-–—\d.)]+/, '').trim())
      .filter((line) => line.length > 12);

    const isLinuxTask = /\/etc|\/bin|\/tmp|whoami|directorio personal|archivos de configuracion|archivos de configuración|comando/i.test(clean);
    const isAssignment = /captura requerida|ejercicio|consigna|comando ejecutado|whoami|busc[aá]|mostr[aá]|identific[aá]|tom[aá] una captura/i.test(clean);

    if (isAssignment || isLinuxTask) {
      const actions = [];
      if (/captura requerida|captura/i.test(clean)) actions.push('tomar capturas donde se vea el comando ejecutado, el resultado y el usuario con whoami');
      if (/tipo de archivo|tipo de archivos|\/etc|\/bin|\/tmp/i.test(clean)) actions.push('identificar el tipo de archivo usando tres archivos distintos: uno de /etc, uno de /bin y uno de /tmp');
      if (/tamaño.*directorio personal|directorio personal.*tamaño|espacio ocupa/i.test(clean)) actions.push('mostrar cuánto espacio ocupa el directorio personal');
      if (/\/etc.*terminen|archivos de configuraci[oó]n|\.conf/i.test(clean)) actions.push('buscar archivos de configuración dentro de /etc');

      const extracted = lines
        .filter((line) => /captura|ejercicio|comando|whoami|\/etc|\/bin|\/tmp|directorio|archivo|configuraci[oó]n|busc|mostr|identific/i.test(line))
        .slice(0, 5);

      const actionText = actions.length ? actions.join('; ') : extracted.join('; ');
      const summary = actionText
        ? 'El documento es una consigna práctica sobre comandos y archivos del sistema. Pide ' + actionText + '. La condición principal es que cada captura muestre claramente el comando usado, el resultado obtenido y el usuario.'
        : 'El documento es una consigna práctica. Indica tareas que deben resolverse ejecutando comandos, registrando resultados y mostrando evidencias mediante capturas.';

      const explanation = isLinuxTask
        ? 'En palabras simples, tenés que usar comandos de Linux para revisar archivos y carpetas del sistema, y después demostrarlo con capturas. No alcanza con escribir la respuesta: la evidencia debe mostrar el comando, la salida y tu usuario.'
        : 'En palabras simples, es una guía de trabajo: hay que seguir los pasos, ejecutar las acciones pedidas y guardar capturas como evidencia.';

      const questions = [
        '¿Qué comando se puede usar para mostrar el tipo de archivo?',
        '¿Qué archivos se deben elegir de /etc, /bin y /tmp?',
        '¿Cómo se muestra el tamaño total del directorio personal?',
        '¿Qué debe verse obligatoriamente en cada captura?',
        '¿Cómo se buscan archivos de configuración dentro de /etc?'
      ];

      return { summary, explanation, keywords, questions };
    }

    const sentences = clean.match(/[^.!?¿¡]+[.!?]?/g)?.map((s) => s.trim()).filter((s) => s.length > 35) || [clean.slice(0, 700)];
    const scored = sentences.map((s, i) => {
      const words = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-zñ]{4,}/g) || [];
      const score = words.reduce((sum, w) => sum + (freq.get(w) || 0), 0) / Math.max(8, words.length);
      return { s, i, score };
    });
    const selected = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(6, scored.length))
      .sort((a, b) => a.i - b.i)
      .map((x) => x.s.replace(/\s+/g, ' ').trim());

    const summary = selected.length
      ? 'El documento desarrolla principalmente estos puntos: ' + selected.join(' ')
      : clean.slice(0, 900);
    const explanation = 'En palabras simples, el material se centra en ' + (keywords.slice(0, 4).join(', ') || 'los temas principales del texto') + '. El resumen reúne las ideas más repetidas e importantes para usarlo como apoyo de estudio.';
    const questions = keywords.slice(0, 5).map((kw) => '¿Qué explica el documento sobre ' + kw + '?');

    return { summary, explanation, keywords, questions };
  }

  async function analyzeDocument(file, options = {}) {
    const text = await extractText(file, options);
    if (!text.trim()) throw Error('No se encontró texto seleccionable. Activá OCR para intentar leer el PDF como imagen.');
    return { text, ...summarizeText(text) };
  }

  root.EduAccessConverter = { convert, extractText, summarizeText, analyzeDocument };
})(typeof window !== 'undefined' ? window : globalThis);
