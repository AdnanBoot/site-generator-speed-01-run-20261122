// Original implementation of makefun-site 1.0.0 static site generator.

const RESERVED_DIRS = ['posts', 'tags', 'page'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const SLUG_MAX = 64;
const INCLUDE_DEPTH = 8;

function cmpCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const HTML_ESC_RE = /[&<>"']/g;

function escapeHtml(str) {
  HTML_ESC_RE.lastIndex = 0;
  let m = HTML_ESC_RE.exec(str);
  if (m === null) return str;
  let out = '';
  let last = 0;
  do {
    const idx = m.index;
    if (idx > last) out += str.slice(last, idx);
    const c = str.charCodeAt(idx);
    if (c === 38) out += '&amp;';
    else if (c === 60) out += '&lt;';
    else if (c === 62) out += '&gt;';
    else if (c === 34) out += '&quot;';
    else out += '&#39;';
    last = idx + 1;
    m = HTML_ESC_RE.exec(str);
  } while (m !== null);
  if (last < str.length) out += str.slice(last);
  return out;
}

function slugify(text) {
  const len = text.length;
  let out = '';
  let pendingDash = false;
  let i = 0;
  for (; i < len; i++) {
    const code = text.charCodeAt(i);
    if (code >= 128) break;
    if (code >= 65 && code <= 90) {
      if (pendingDash) {
        if (out.length === SLUG_MAX) break;
        out += '-';
        pendingDash = false;
      }
      out += String.fromCharCode(code + 32);
      if (out.length === SLUG_MAX) return out;
    } else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
      if (pendingDash) {
        if (out.length === SLUG_MAX) break;
        out += '-';
        pendingDash = false;
      }
      out += text[i];
      if (out.length === SLUG_MAX) return out;
    } else if (out.length > 0) {
      pendingDash = true;
    }
  }
  if (i === len) {
    return out === '' ? 'untitled' : out;
  }

  // Slow path for non-ASCII
  const normalized = text.normalize('NFKD').replace(/\p{M}/gu, '');
  out = '';
  pendingDash = false;
  for (const ch of normalized) {
    const code = ch.codePointAt(0);
    if (code >= 65 && code <= 90) {
      if (pendingDash) {
        out += '-';
        pendingDash = false;
      }
      out += String.fromCharCode(code + 32);
    } else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
      if (pendingDash) {
        out += '-';
        pendingDash = false;
      }
      out += ch;
    } else if (out.length > 0) {
      pendingDash = true;
    }
  }
  if (out.length > SLUG_MAX) {
    out = out.slice(0, SLUG_MAX);
  }
  out = out.replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function allocateUniqueSlug(base, takenSet) {
  let candidate = base;
  let n = 2;
  while (takenSet.has(candidate)) {
    candidate = `${base}-${n}`;
    n++;
  }
  takenSet.add(candidate);
  return candidate;
}

function formatLongDate(dateStr) {
  const parts = dateStr.split('-');
  const day = Number(parts[2]);
  const month = MONTHS[Number(parts[1]) - 1];
  return `${day} ${month} ${parts[0]}`;
}

function countWords(text) {
  let count = 0;
  const len = text.length;
  let i = 0;
  while (i < len) {
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c > 32 && c < 160) break;
      if (c === 32 || (c >= 9 && c <= 13)) {
        i++;
      } else if (c >= 160 && (c === 160 || c === 0xfeff || /\s/.test(text[i]))) {
        i++;
      } else {
        break;
      }
    }
    if (i >= len) break;
    count++;
    i++;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c > 32 && c < 160) {
        i++;
        continue;
      }
      if (c === 32 || (c >= 9 && c <= 13)) {
        break;
      }
      if (c >= 160 && (c === 160 || c === 0xfeff || /\s/.test(text[i]))) {
        break;
      }
      i++;
    }
  }
  return count;
}

function dirOf(path) {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function resolveRelativePathFromParts(baseParts, rel) {
  const stack = baseParts.slice();
  const segments = rel.split('/');
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  return stack.join('/');
}

// ---------------------------------------------------------------------------
// Front matter parser
// ---------------------------------------------------------------------------

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE_RE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LAYOUT_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_CHAR_RE = /^[^"[\]]+$/;

function daysInMonth(year, month) {
  if (month === 2) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function parseQuotedOrBareString(raw, key) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) {
      return { error: `key "${key}": a quoted string is not closed` };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const next = raw[i + 1];
        if ((next !== '"' && next !== '\\') || i + 1 === raw.length - 1) {
          return { error: `key "${key}": a quoted string holds an escape other than \\" or \\\\` };
        }
        out += next;
        i++;
      } else if (c === '"') {
        return { error: `key "${key}": a quoted string holds a stray quote` };
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (raw.startsWith('[')) {
    return { error: `key "${key}": a bare string opens on [` };
  }
  return { value: raw };
}

function parseFrontMatterValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary':
      return parseQuotedOrBareString(raw, key);
    case 'date': {
      const m = DATE_RE.exec(raw);
      if (m) {
        const y = Number(m[1]);
        const mo = Number(m[2]);
        const d = Number(m[3]);
        if (y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo)) {
          return { value: raw };
        }
      }
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = [];
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '' || !TAG_CHAR_RE.test(t)) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags.push(t);
      }
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout':
      return LAYOUT_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64
        ? { value: raw }
        : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  const len = text.length;
  let nl = text.indexOf('\n');
  const firstLine = nl === -1 ? text : text.slice(0, nl);
  if (firstLine !== '---') return { error: 'no front matter' };
  if (nl === -1) return { error: 'the front matter is not closed' };

  let pos = nl + 1;
  let closeLineStart = -1;
  let closeLineEnd = -1;
  while (pos <= len) {
    nl = text.indexOf('\n', pos);
    const end = nl === -1 ? len : nl;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeLineStart = pos;
      closeLineEnd = end;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeLineStart === -1) return { error: 'the front matter is not closed' };

  const data = {};
  pos = 4; // right after "---\n"
  let lineNum = 1;
  while (pos < closeLineStart) {
    lineNum++;
    nl = text.indexOf('\n', pos);
    const end = nl === -1 ? len : nl;
    // Check blank or comment (#)
    let p = pos;
    while (p < end && (text.charCodeAt(p) === 32 || text.charCodeAt(p) === 9)) p++;
    if (p === end || text.charCodeAt(pos) === 35) {
      pos = end + 1;
      continue;
    }
    const line = text.slice(pos, end);
    const m = FM_LINE_RE.exec(line);
    if (!m) return { error: `line ${lineNum} is not "key: value"` };
    const key = m[1];
    let raw = m[2] ?? '';
    let rEnd = raw.length;
    while (rEnd > 0 && (raw.charCodeAt(rEnd - 1) === 32 || raw.charCodeAt(rEnd - 1) === 9)) rEnd--;
    if (rEnd < raw.length) raw = raw.slice(0, rEnd);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const parsed = parseFrontMatterValue(key, raw);
    if ('error' in parsed) return parsed;
    data[key] = parsed.value;
    pos = end + 1;
  }

  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeLineEnd < len ? text.slice(closeLineEnd + 1) : '';
  return { data, body };
}

// ---------------------------------------------------------------------------
// Markdown lexer & renderer
// ---------------------------------------------------------------------------

function isBlankRange(src, pos, end) {
  for (let p = pos; p < end; p++) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimRange(src, pos, end) {
  let s = pos;
  while (s < end) {
    const c = src.charCodeAt(s);
    if (c !== 32 && c !== 9) break;
    s++;
  }
  let e = end;
  while (e > s) {
    const c = src.charCodeAt(e - 1);
    if (c !== 32 && c !== 9) break;
    e--;
  }
  return s >= e ? '' : src.slice(s, e);
}

function matchFenceOpenRange(src, pos, end) {
  if (end - pos < 3) return null;
  if (src.charCodeAt(pos) !== 96 || src.charCodeAt(pos + 1) !== 96 || src.charCodeAt(pos + 2) !== 96) {
    return null;
  }
  let p = pos + 3;
  while (p < end) {
    const c = src.charCodeAt(p);
    if (
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) ||
      c === 95 ||
      c === 43 ||
      c === 45
    ) {
      p++;
    } else {
      break;
    }
  }
  const langEnd = p;
  while (p < end) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) return null;
    p++;
  }
  return langEnd === pos + 3 ? '' : src.slice(pos + 3, langEnd);
}

function isFenceCloseRange(src, pos, end) {
  if (end - pos < 3) return false;
  if (src.charCodeAt(pos) !== 96 || src.charCodeAt(pos + 1) !== 96 || src.charCodeAt(pos + 2) !== 96) {
    return false;
  }
  for (let p = pos + 3; p < end; p++) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function matchHeadingRange(src, pos, end) {
  if (pos >= end || src.charCodeAt(pos) !== 35) return null;
  let depth = 1;
  let p = pos + 1;
  while (p < end && depth < 7 && src.charCodeAt(p) === 35) {
    depth++;
    p++;
  }
  if (depth > 6 || p >= end) return null;
  const c0 = src.charCodeAt(p);
  if (c0 !== 32 && c0 !== 9) return null;
  p++;
  while (p < end) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) break;
    p++;
  }
  let e = end;
  while (e > p) {
    const c = src.charCodeAt(e - 1);
    if (c !== 32 && c !== 9) break;
    e--;
  }
  if (p >= e) return null;
  return { depth, text: src.slice(p, e) };
}

function isHrRange(src, pos, end) {
  if (end - pos < 3) return false;
  const c0 = src.charCodeAt(pos);
  if ((c0 !== 45 && c0 !== 42) || src.charCodeAt(pos + 1) !== c0 || src.charCodeAt(pos + 2) !== c0) {
    return false;
  }
  for (let p = pos + 3; p < end; p++) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function lineEndsParagraphRange(src, pos, end) {
  if (pos >= end) return true;
  const c0 = src.charCodeAt(pos);
  if (c0 === 32 || c0 === 9) return isBlankRange(src, pos, end);
  if (c0 === 96) return matchFenceOpenRange(src, pos, end) !== null;
  if (c0 === 35) return matchHeadingRange(src, pos, end) !== null;
  if (c0 === 45 || c0 === 42) return isHrRange(src, pos, end);
  return false;
}

function matchBulletRange(src, pos, end) {
  if (pos + 1 >= end) return null;
  const c0 = src.charCodeAt(pos);
  if ((c0 !== 45 && c0 !== 42) || src.charCodeAt(pos + 1) !== 32) return null;
  return trimRange(src, pos + 2, end);
}

function matchOrderedRange(src, pos, end) {
  let p = pos;
  const limit = Math.min(end, pos + 9);
  while (p < limit) {
    const c = src.charCodeAt(p);
    if (c >= 48 && c <= 57) p++;
    else break;
  }
  if (p === pos || p + 1 >= end) return null;
  if (src.charCodeAt(p) !== 46 || src.charCodeAt(p + 1) !== 32) return null;
  return {
    start: Number(src.slice(pos, p)),
    text: trimRange(src, p + 2, end),
  };
}

function isContinuedRange(src, pos, end) {
  if (pos + 2 >= end) return false;
  if (src.charCodeAt(pos) !== 32 || src.charCodeAt(pos + 1) !== 32) return false;
  let p = pos + 2;
  while (p < end && src.charCodeAt(p) === 32) p++;
  if (p >= end) return false;
  const c = src.charCodeAt(p);
  if (c <= 32) return !(c === 32 || (c >= 9 && c <= 13));
  if (c < 160) return true;
  return c !== 160 && c !== 0xfeff && !/\s/.test(src[p]);
}

const ESCAPABLE_ASCII = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) {
  ESCAPABLE_ASCII[ch.charCodeAt(0)] = 1;
}

function findUnescapedDoubleStar(s, from) {
  const limit = s.length - 2;
  for (let j = from; j <= limit; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      const next = s.charCodeAt(j + 1);
      if (next < 128 && ESCAPABLE_ASCII[next] === 1) {
        j++;
        continue;
      }
    } else if (c === 42 && s.charCodeAt(j + 1) === 42) {
      return j;
    }
  }
  return -1;
}

function findUnescapedCloseBracket(s, from) {
  const len = s.length;
  for (let j = from; j < len; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < len) {
      const next = s.charCodeAt(j + 1);
      if (next < 128 && ESCAPABLE_ASCII[next] === 1) {
        j++;
        continue;
      }
    } else if (c === 93) {
      return j;
    }
  }
  return -1;
}

function findUnescapedSingleStar(s, from) {
  const len = s.length;
  for (let j = from; j < len; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < len) {
      const next = s.charCodeAt(j + 1);
      if (next < 128 && ESCAPABLE_ASCII[next] === 1) {
        j++;
        continue;
      }
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const INLINE_TOKEN_RE = /[&<>"'\\`*\[]/g;

function renderInline(s, resolveLink) {
  INLINE_TOKEN_RE.lastIndex = 0;
  let m = INLINE_TOKEN_RE.exec(s);
  if (m === null) return s;

  let out = '';
  let last = 0;
  const len = s.length;
  while (m !== null) {
    const i = m.index;
    const code = s.charCodeAt(i);
    if (code === 38) {
      if (i > last) out += s.slice(last, i);
      out += '&amp;';
      last = i + 1;
    } else if (code === 60) {
      if (i > last) out += s.slice(last, i);
      out += '&lt;';
      last = i + 1;
    } else if (code === 62) {
      if (i > last) out += s.slice(last, i);
      out += '&gt;';
      last = i + 1;
    } else if (code === 34) {
      if (i > last) out += s.slice(last, i);
      out += '&quot;';
      last = i + 1;
    } else if (code === 39) {
      if (i > last) out += s.slice(last, i);
      out += '&#39;';
      last = i + 1;
    } else if (code === 92) {
      if (i + 1 < len) {
        const next = s.charCodeAt(i + 1);
        if (next < 128 && ESCAPABLE_ASCII[next] === 1) {
          if (i > last) out += s.slice(last, i);
          out += next === 62 ? '&gt;' : s[i + 1];
          last = i + 2;
          INLINE_TOKEN_RE.lastIndex = last;
        }
      }
    } else if (code === 96) {
      const close = s.indexOf('`', i + 1);
      if (close > i + 1) {
        if (i > last) out += s.slice(last, i);
        out += `<code>${escapeHtml(s.slice(i + 1, close))}</code>`;
        last = close + 1;
        INLINE_TOKEN_RE.lastIndex = last;
      }
    } else if (code === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const close = findUnescapedDoubleStar(s, i + 2);
        if (close > i + 2) {
          if (i > last) out += s.slice(last, i);
          out += `<strong>${renderInline(s.slice(i + 2, close), resolveLink)}</strong>`;
          last = close + 2;
          INLINE_TOKEN_RE.lastIndex = last;
        } else {
          INLINE_TOKEN_RE.lastIndex = i + 2;
        }
      } else {
        const close = findUnescapedSingleStar(s, i + 1);
        if (close > i + 1) {
          if (i > last) out += s.slice(last, i);
          out += `<em>${renderInline(s.slice(i + 1, close), resolveLink)}</em>`;
          last = close + 1;
          INLINE_TOKEN_RE.lastIndex = last;
        }
      }
    } else if (code === 91) {
      const k = findUnescapedCloseBracket(s, i + 1);
      if (k !== -1 && s.charCodeAt(k + 1) === 40) {
        const closeParen = s.indexOf(')', k + 2);
        if (closeParen !== -1) {
          const target = s.slice(k + 2, closeParen);
          if (target !== '' && !/\s/.test(target)) {
            if (i > last) out += s.slice(last, i);
            out += `<a href="${escapeHtml(resolveLink(target))}">${renderInline(s.slice(i + 1, k), resolveLink)}</a>`;
            last = closeParen + 1;
            INLINE_TOKEN_RE.lastIndex = last;
          }
        }
      }
    }
    m = INLINE_TOKEN_RE.exec(s);
  }
  if (last === 0) return s;
  if (last < len) out += s.slice(last);
  return out;
}

function renderMarkdown(src, resolveLink) {
  const len = src.length;
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let html = '';

  let pos = 0;
  while (pos < len) {
    let nl = src.indexOf('\n', pos);
    let end = nl === -1 ? len : nl;
    let nextPos = nl === -1 ? len : nl + 1;

    if (pos >= end) {
      pos = nextPos;
      continue;
    }
    const c0 = src.charCodeAt(pos);
    if ((c0 === 32 || c0 === 9) && isBlankRange(src, pos, end)) {
      pos = nextPos;
      continue;
    }

    if (c0 === 96) {
      const fenceLang = matchFenceOpenRange(src, pos, end);
      if (fenceLang !== null) {
        const cls = fenceLang === '' ? '' : ` class="language-${escapeHtml(fenceLang)}"`;
        let codeBody = '';
        pos = nextPos;
        while (pos < len) {
          nl = src.indexOf('\n', pos);
          end = nl === -1 ? len : nl;
          nextPos = nl === -1 ? len : nl + 1;
          if (isFenceCloseRange(src, pos, end)) {
            pos = nextPos;
            break;
          }
          codeBody += `${escapeHtml(src.slice(pos, end))}\n`;
          pos = nextPos;
        }
        html += `<pre><code${cls}>${codeBody}</code></pre>\n`;
        continue;
      }
    }

    if (c0 === 35) {
      const heading = matchHeadingRange(src, pos, end);
      if (heading !== null) {
        const id = allocateUniqueSlug(slugify(heading.text), ids);
        const inlineHtml = renderInline(heading.text, resolveLink);
        html += `<h${heading.depth} id="${id}">${inlineHtml}</h${heading.depth}>\n`;
        if (heading.depth === 2 || heading.depth === 3) {
          toc.push({ level: heading.depth, id, html: inlineHtml });
        }
        pos = nextPos;
        continue;
      }
    }

    if ((c0 === 45 || c0 === 42) && isHrRange(src, pos, end)) {
      html += '<hr>\n';
      pos = nextPos;
      continue;
    }

    if (c0 === 62) {
      const qLines = [];
      while (pos < len) {
        nl = src.indexOf('\n', pos);
        end = nl === -1 ? len : nl;
        nextPos = nl === -1 ? len : nl + 1;
        if (pos >= end || src.charCodeAt(pos) !== 62) break;
        const start = pos + 1 < end && src.charCodeAt(pos + 1) === 32 ? pos + 2 : pos + 1;
        const stripped = trimRange(src, start, end);
        if (stripped !== '') qLines.push(stripped);
        pos = nextPos;
      }
      if (qLines.length === 0) {
        html += '<blockquote>\n</blockquote>\n';
      } else {
        html += `<blockquote>\n<p>${renderInline(qLines.join('\n'), resolveLink)}</p>\n</blockquote>\n`;
      }
      continue;
    }

    const bulletText = (c0 === 45 || c0 === 42) ? matchBulletRange(src, pos, end) : null;
    const orderedMatch = bulletText === null && c0 >= 48 && c0 <= 57 ? matchOrderedRange(src, pos, end) : null;
    if (bulletText !== null || orderedMatch !== null) {
      const isOrdered = orderedMatch !== null;
      const startNum = isOrdered ? orderedMatch.start : 1;
      const items = [[isOrdered ? orderedMatch.text : bulletText]];
      pos = nextPos;
      while (pos < len) {
        nl = src.indexOf('\n', pos);
        end = nl === -1 ? len : nl;
        nextPos = nl === -1 ? len : nl + 1;
        if (isOrdered) {
          const om = matchOrderedRange(src, pos, end);
          if (om !== null) {
            items.push([om.text]);
            pos = nextPos;
            continue;
          }
        } else {
          const bt = matchBulletRange(src, pos, end);
          if (bt !== null) {
            items.push([bt]);
            pos = nextPos;
            continue;
          }
        }
        if (isContinuedRange(src, pos, end)) {
          items[items.length - 1].push(trimRange(src, pos, end));
          pos = nextPos;
        } else {
          break;
        }
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      html += `${open}\n`;
      for (let k = 0; k < items.length; k++) {
        const itemText = items[k].length === 1 ? items[k][0] : items[k].join('\n');
        html += `<li>${renderInline(itemText, resolveLink)}</li>\n`;
      }
      html += `</${tag}>\n`;
      continue;
    }

    const pLines = [trimRange(src, pos, end)];
    pos = nextPos;
    while (pos < len) {
      nl = src.indexOf('\n', pos);
      end = nl === -1 ? len : nl;
      nextPos = nl === -1 ? len : nl + 1;
      if (lineEndsParagraphRange(src, pos, end)) break;
      pLines.push(trimRange(src, pos, end));
      pos = nextPos;
    }
    const pText = pLines.length === 1 ? pLines[0] : pLines.join('\n');
    const pHtml = renderInline(pText, resolveLink);
    if (excerpt === null) excerpt = pHtml;
    html += `<p>${pHtml}</p>\n`;
  }

  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------------------
// Template parser & renderer
// ---------------------------------------------------------------------------

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateParseError extends Error {}

function parsePath(tmplName, text) {
  if (!PATH_RE.test(text)) {
    throw new TemplateParseError(`template "${tmplName}": ${JSON.stringify(text)} is not a path`);
  }
  return text.split('.');
}

const NODE_TEXT = 0;
const NODE_VAR = 1;
const NODE_RAW = 2;
const NODE_IF = 3;
const NODE_FOR = 4;
const NODE_INCLUDE = 5;

function parseTemplate(name, src) {
  const root = { kind: -1, body: [] };
  const stack = [root];
  let body = root.body;
  let text = '';
  let i = 0;
  const len = src.length;

  const flushText = () => {
    if (text !== '') {
      body.push({ kind: NODE_TEXT, text });
      text = '';
    }
  };

  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);

    if (next === '{') {
      const isRaw = src[open + 2] === '{';
      const delim = isRaw ? '}}}' : '}}';
      const offset = isRaw ? 3 : 2;
      const close = src.indexOf(delim, open + offset);
      if (close === -1) {
        throw new TemplateParseError(`template "${name}": a ${isRaw ? '{{{' : '{{'} is not closed`);
      }
      flushText();
      const path = parsePath(name, src.slice(open + offset, close).trim());
      body.push({ kind: isRaw ? NODE_RAW : NODE_VAR, path });
      i = close + offset;
      continue;
    }

    // {% ... %}
    const close = src.indexOf('%}', open + 2);
    if (close === -1) {
      throw new TemplateParseError(`template "${name}": a {% is not closed`);
    }
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone =
      /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) {
      text = text.slice(0, text.length - (open - lineStart));
    }
    flushText();

    const tag = src.slice(open + 2, close).trim();
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { kind: NODE_FOR, name: m[1], path: parsePath(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { kind: NODE_IF, not: m[1] !== undefined, path: parsePath(name, m[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== NODE_IF || top.else !== null) {
        throw new TemplateParseError(`template "${name}": an else outside an if`);
      }
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      const expectedKind = tag === 'endfor' ? NODE_FOR : NODE_IF;
      const expectedName = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== expectedKind) {
        throw new TemplateParseError(`template "${name}": an ${tag} with no open ${expectedName}`);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body =
        parent.kind === -1 || parent.kind === NODE_FOR
          ? parent.body
          : parent.else ?? parent.then;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ kind: NODE_INCLUDE, name: m[1] });
    } else {
      throw new TemplateParseError(`template "${name}": {% ${tag} %} is not a tag`);
    }

    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }

  flushText();
  if (stack.length > 1) {
    const unclosed = stack[stack.length - 1].kind === NODE_FOR ? 'for' : 'if';
    throw new TemplateParseError(`template "${name}": a ${unclosed} is not closed`);
  }
  return root.body;
}

const hasOwn = Object.hasOwn;

function valueToText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    const parts = new Array(v.length);
    for (let i = 0; i < v.length; i++) parts[i] = valueToText(v[i]);
    return parts.join(', ');
  }
  return '';
}

function isTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function lookupPath(scope, path) {
  const first = path[0];
  let s = scope;
  while (s !== null && !hasOwn(s.vars, first)) {
    s = s.parent;
  }
  if (s === null) return undefined;
  let val = s.vars[first];
  const plen = path.length;
  if (plen === 1) return val;
  if (val === null || typeof val !== 'object' || !hasOwn(val, path[1])) return undefined;
  val = val[path[1]];
  if (plen === 2) return val;
  for (let k = 2; k < plen; k++) {
    if (val === null || typeof val !== 'object' || !hasOwn(val, path[k])) return undefined;
    val = val[path[k]];
  }
  return val;
}

function renderTemplateNodes(nodes, scope, templates, depth) {
  let out = '';
  const nlen = nodes.length;
  for (let i = 0; i < nlen; i++) {
    const n = nodes[i];
    switch (n.kind) {
      case NODE_TEXT:
        out += n.text;
        break;
      case NODE_VAR: {
        const v = lookupPath(scope, n.path);
        out += escapeHtml(typeof v === 'string' ? v : valueToText(v));
        break;
      }
      case NODE_RAW: {
        const v = lookupPath(scope, n.path);
        out += typeof v === 'string' ? v : valueToText(v);
        break;
      }
      case NODE_IF: {
        const val = isTruthy(lookupPath(scope, n.path));
        const branch = val !== n.not ? n.then : n.else;
        if (branch !== null) {
          out += renderTemplateNodes(branch, scope, templates, depth);
        }
        break;
      }
      case NODE_FOR: {
        const arr = lookupPath(scope, n.path);
        if (!Array.isArray(arr)) break;
        const len = arr.length;
        if (len === 0) break;
        const loop = { index: 0, first: false, last: false, length: len };
        const vars = { [n.name]: undefined, loop };
        const childScope = { vars, parent: scope };
        const varName = n.name;
        const notLoop = varName !== 'loop';
        for (let k = 0; k < len; k++) {
          if (notLoop) vars[varName] = arr[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === len - 1;
          out += renderTemplateNodes(n.body, childScope, templates, depth);
        }
        break;
      }
      case NODE_INCLUDE: {
        if (depth < INCLUDE_DEPTH) {
          const target = templates.get(n.name);
          if (target !== undefined) {
            out += renderTemplateNodes(target, scope, templates, depth + 1);
          }
        }
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main build entry
// ---------------------------------------------------------------------------

export function run(input) {
  const reportLines = [];

  // 1. Parse templates in code-unit order
  const templates = new Map();
  const templateNames = Object.keys(input.templates).sort(cmpCodeUnits);
  for (let i = 0; i < templateNames.length; i++) {
    const name = templateNames[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateParseError)) throw err;
      reportLines.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 2. Read and sort files
  const sortedFiles = [...input.files].sort((a, b) => cmpCodeUnits(a.path, b.path));
  const rawSources = [];
  const statics = [];
  for (let i = 0; i < sortedFiles.length; i++) {
    const f = sortedFiles[i];
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      rawSources.push({ path: f.path, text });
    } else {
      statics.push(f);
    }
  }

  // 3. Front matter & validation
  const sources = [];
  for (let i = 0; i < rawSources.length; i++) {
    const s = rawSources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      reportLines.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    const isPost = s.path.startsWith('posts/');
    let reservedDir;
    for (let j = 0; j < RESERVED_DIRS.length; j++) {
      const d = RESERVED_DIRS[j];
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        reservedDir = d;
        break;
      }
    }
    if (reservedDir !== undefined) {
      reportLines.push(`refused ${s.path}: ${reservedDir}/ is the generator's own`);
      continue;
    }
    if (isPost && !Object.hasOwn(fm.data, 'date')) {
      reportLines.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = fm.data.layout ?? (isPost ? 'post' : 'page');
    if (!templates.has(layout)) {
      reportLines.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    if (fm.data.draft === true) {
      reportLines.push(`draft ${s.path}`);
      continue;
    }
    sources.push({
      path: s.path,
      data: fm.data,
      body: fm.body,
      post: isPost,
      layout,
      slug: '',
      outDir: '',
      url: '',
      html: '',
      toc: null,
      excerpt: '',
      newer: null,
      older: null,
      tagRefs: [],
    });
  }

  // 4. Permalinks
  const takenByDir = new Map();
  const bySource = new Map();
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? RESERVED_DIRS : []);
      takenByDir.set(dir, taken);
    }
    const baseSlug = s.data.slug ?? slugify(s.data.title);
    const slug = allocateUniqueSlug(baseSlug, taken);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 5. Markdown rendering & link resolution
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const brokenLinks = new Set();

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const dir = dirOf(s.path);
    const baseParts = dir === '' ? [] : dir.split('/');
    const resolveLink = (target) => {
      if (
        /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) ||
        target.startsWith('/') ||
        target.startsWith('#')
      ) {
        return target;
      }
      const hashIdx = target.indexOf('#');
      const rel = hashIdx === -1 ? target : target.slice(0, hashIdx);
      const frag = hashIdx === -1 ? '' : target.slice(hashIdx);
      const resolved = rel === '' ? null : resolveRelativePathFromParts(baseParts, rel);
      if (resolved !== null) {
        const targetSource = bySource.get(resolved);
        if (targetSource !== undefined) return `${targetSource.url}${frag}`;
        if (staticPaths.has(resolved)) return `${base}/${resolved}${frag}`;
      }
      brokenLinks.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, resolveLink);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 6. Collections (posts sorted newest first, then slug)
  const posts = sources.filter((s) => s.post);
  posts.sort((a, b) => cmpCodeUnits(b.data.date, a.data.date) || cmpCodeUnits(a.slug, b.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 7. Tags
  const tagsBySlug = new Map();
  const dedupSourceTags = (s) => {
    const rawTags = s.data.tags;
    if (!rawTags || rawTags.length === 0) return [];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < rawTags.length; i++) {
      const name = rawTags[i];
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push({ name, slug });
      }
    }
    return out;
  };

  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const own = dedupSourceTags(p);
    p.tagRefs = [];
    for (let j = 0; j < own.length; j++) {
      const { name, slug } = own[j];
      let tag = tagsBySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        tagsBySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (s.post) continue;
    const own = dedupSourceTags(s);
    s.tagRefs = [];
    for (let j = 0; j < own.length; j++) {
      const { name, slug } = own[j];
      const existing = tagsBySlug.get(slug);
      s.tagRefs.push(existing ?? { name, slug, url: '', posts: [] });
    }
  }

  const allTagsSorted = [...tagsBySlug.values()].sort(
    (a, b) => b.posts.length - a.posts.length || cmpCodeUnits(a.slug, b.slug),
  );

  // 8. Layouts & Output
  const makeCard = (s) => {
    const dateStr = s.data.date ?? '';
    return {
      title: s.data.title,
      url: s.url,
      date: dateStr,
      date_long: dateStr === '' ? '' : formatLongDate(dateStr),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  };

  const makeLink = (s) => {
    if (s === null) return null;
    const dateStr = s.data.date ?? '';
    return {
      title: s.data.title,
      url: s.url,
      date: dateStr,
      date_long: dateStr === '' ? '' : formatLongDate(dateStr),
    };
  };

  const postCards = new Map();
  for (let i = 0; i < posts.length; i++) {
    postCards.set(posts[i], makeCard(posts[i]));
  }

  const siteVar = { title: input.site.title, base_url: base };
  const tagsVar = allTagsSorted.map((t) => ({
    name: t.name,
    slug: t.slug,
    url: t.url,
    count: t.posts.length,
  }));
  const recentVar = posts.slice(0, input.site.recent).map((p) => postCards.get(p));

  const renderPage = (tmplName, extraVars) => {
    const nodes = templates.get(tmplName);
    if (nodes === undefined) return null;
    const scope = {
      vars: { site: siteVar, tags: tagsVar, recent: recentVar, ...extraVars },
      parent: null,
    };
    return renderTemplateNodes(nodes, scope, templates, 0);
  };

  const output = {};

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const baseCard = s.post ? postCards.get(s) : makeCard(s);
    const pageVar = {
      ...baseCard,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: makeLink(s.newer),
      older: makeLink(s.older),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = renderPage(s.layout, { page: pageVar });
  }

  const perPage = input.site.per_page;
  const totalPages = Math.max(1, Math.ceil(posts.length / perPage));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= totalPages; k++) {
    const slice = posts.slice((k - 1) * perPage, k * perPage).map((p) => postCards.get(p));
    const html = renderPage('index', {
      posts: slice,
      pager: {
        number: k,
        total: totalPages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === totalPages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) {
      output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
  }

  for (let i = 0; i < allTagsSorted.length; i++) {
    const t = allTagsSorted[i];
    const html = renderPage('tag', {
      tag: {
        name: t.name,
        slug: t.slug,
        url: t.url,
        count: t.posts.length,
        posts: t.posts.map((p) => postCards.get(p)),
      },
    });
    if (html !== null) {
      output[`tags/${t.slug}/index.html`] = html;
    }
  }

  const tagsIndexHtml = renderPage('tags', {});
  if (tagsIndexHtml !== null) {
    output['tags/index.html'] = tagsIndexHtml;
  }

  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) {
      reportLines.push(`shadowed ${f.path}: a built page has its path`);
    } else {
      output[f.path] = f.content;
    }
  }

  // 9. Report
  const allReportLines = [...reportLines, ...brokenLinks].sort(cmpCodeUnits);
  const pageCount = sources.length - posts.length;
  allReportLines.push(
    `built ${pageCount} pages, ${posts.length} posts, ${allTagsSorted.length} tags and ${statics.length} static files`,
  );
  output['build-report.txt'] = `${allReportLines.join('\n')}\n`;

  return output;
}
