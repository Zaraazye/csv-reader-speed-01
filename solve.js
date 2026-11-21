// csv-reader-speed-01: fast drop-in for csv-reader 1.0.0 (make.fun's own reader).
// Konsep 1: indexOf/slice state machine with the reference semantics inlined.
// v3: hot unquoted reader is small (stray-CR slow path extracted); the record's
// next LF is cached (recEnd) instead of one indexOf('\n') per field.
// (v4 tried inlining the unquoted fast path in run(): no measurable gain,
// reverted — one implementation of the fast path.)
// Invariants: no per-character `value += c`, no regex in the hot path, no error
// object allocated on a clean path (errors array is lazy), no clock/env/file
// reads, no state kept between cases (all state is local to one run() call;
// helpers only mutate the per-call scratch object `st`).

/** Transform one quoted segment: each CRLF / lone CR becomes one LF. Returns [value, lineBreaks]. */
function fixSeg(seg) {
  let out = '';
  let p = 0;
  const m = seg.length;
  let breaks = 0;
  while (p < m) {
    let r = seg.indexOf('\r', p);
    let l = seg.indexOf('\n', p);
    if (r === -1) r = m;
    if (l === -1) l = m;
    if (r < l) {
      out += seg.slice(p, r);
      out += '\n';
      breaks += 1;
      p = r + (r + 1 < m && seg.charCodeAt(r + 1) === 10 ? 2 : 1);
    } else if (l < m) {
      out += seg.slice(p, l + 1);
      breaks += 1;
      p = l + 1;
    } else {
      out += seg.slice(p);
      break;
    }
  }
  return [out, breaks];
}

/** Push one error for the record `st` is reading (lazy errors array). */
function pushErr(st, code) {
  if (st.errors === null) st.errors = [];
  st.errors.push({ code, line: st.recordLine, row: st.recordRow });
}

/**
 * Slow path of readUnquoted: the field holds stray CR(s) before its end.
 * Drops each (stray_cr), keeps the rest. Sets st.val / st.end / st.added /
 * st.pos / st.line.
 */
function readUnquotedSlow(st, init, pos) {
  const text = st.t;
  const n = st.n;
  let p = pos;
  let a = init;
  let ad = 0;
  let line = st.line;
  while (true) {
    let c2 = text.indexOf(',', p);
    let l2 = text.indexOf('\n', p);
    if (c2 === -1) c2 = n;
    if (l2 === -1) l2 = n;
    let e2;
    let k2;
    if (c2 < l2) {
      e2 = c2;
      k2 = 0;
    } else if (l2 < n) {
      e2 = l2;
      k2 = 1;
    } else {
      e2 = n;
      k2 = 2;
    }
    const s2 = text.slice(p, e2);
    const cr2 = s2.indexOf('\r');
    if (cr2 === -1) {
      a = a === '' ? s2 : a + s2;
      ad += s2.length;
      if (k2 === 0) {
        st.pos = e2 + 1;
        st.end = 0;
      } else if (k2 === 1) {
        st.pos = e2 + 1;
        line += 1;
        st.end = 1;
      } else {
        st.pos = n;
        st.end = 2;
      }
      break;
    }
    if (k2 === 1 && cr2 === s2.length - 1) {
      const inner2 = s2.slice(0, -1);
      a = a === '' ? inner2 : a + inner2;
      ad += inner2.length;
      st.pos = e2 + 1;
      line += 1;
      st.end = 1;
      break;
    }
    // Stray CR at p + cr2 (not followed by LF): drop it.
    const pre = s2.slice(0, cr2);
    a = a === '' ? pre : a + pre;
    ad += pre.length;
    pushErr(st, 'stray_cr');
    p = p + cr2 + 1;
  }
  st.val = a;
  st.added = ad;
  st.line = line;
}

/**
 * Read one unquoted field starting at st.pos, with initial value `init`.
 * Sets st.val (field value), st.end (0 comma, 1 line break, 2 end of text),
 * st.added (characters kept by this read — used for quote_junk), and advances
 * st.pos / st.line. A CR not followed by LF is dropped (stray_cr).
 * Uses st.recEnd (the record's next LF, cached) instead of searching for LF.
 */
function readUnquoted(st, init) {
  const text = st.t;
  const n = st.n;
  const pos = st.pos;
  let cIdx = text.indexOf(',', pos);
  if (cIdx === -1) cIdx = n;
  let lIdx = st.recEnd;
  if (lIdx < pos) {
    // Defensive: recEnd must never lag behind pos; re-derive if it ever does.
    lIdx = text.indexOf('\n', pos);
    if (lIdx === -1) lIdx = n;
    st.recEnd = lIdx;
  }
  let end;
  let kind; // 0 comma, 1 line break, 2 end of text
  if (cIdx < lIdx) {
    end = cIdx;
    kind = 0;
  } else if (lIdx < n) {
    end = lIdx;
    kind = 1;
  } else {
    end = n;
    kind = 2;
  }
  const seg = text.slice(pos, end);
  const cr = seg.indexOf('\r');
  if (cr === -1) {
    st.val = init === '' ? seg : init + seg;
    st.added = seg.length;
    if (kind === 0) {
      st.pos = end + 1;
      st.end = 0;
    } else if (kind === 1) {
      st.pos = end + 1;
      st.line += 1;
      st.end = 1;
    } else {
      st.pos = n;
      st.end = 2;
    }
    return;
  }
  if (kind === 1 && cr === seg.length - 1) {
    // Trailing CR is the CRLF record terminator, not a stray CR.
    const inner = seg.slice(0, -1);
    st.val = init === '' ? inner : init + inner;
    st.added = inner.length;
    st.pos = end + 1;
    st.line += 1;
    st.end = 1;
    return;
  }
  readUnquotedSlow(st, init, pos);
}

/**
 * Read one quoted field whose opening quote is at st.pos.
 * Sets st.val / st.end and advances st.pos / st.line. Doubled quotes become
 * one quote, CRLF / lone CR inside become LF; junk after the closing quote is
 * appended as it stands (quote_junk when the field ends, if any kept);
 * a quote that never closes is a literal, the rest re-read as unquoted.
 */
function readQuoted(st) {
  const text = st.t;
  const n = st.n;
  const open = st.pos;
  const openLine = st.line;
  let pos = open + 1;
  let line = st.line;
  let qval = '';
  while (true) {
    const q = text.indexOf('"', pos);
    if (q === -1) {
      // Unterminated quote: literal character, text after it re-read as unquoted.
      st.pos = open + 1;
      st.line = openLine;
      pushErr(st, 'unterminated_quote');
      readUnquoted(st, '"');
      return;
    }
    if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
      // Doubled quote: one literal quote.
      const seg = text.slice(pos, q);
      if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) {
        qval = qval === '' ? seg + '"' : qval + seg + '"';
      } else {
        const fx = fixSeg(seg);
        line += fx[1];
        qval += fx[0] + '"';
      }
      pos = q + 2;
      continue;
    }
    // Closing quote at q.
    const seg = text.slice(pos, q);
    if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) {
      qval = qval === '' ? seg : qval + seg;
    } else {
      const fx = fixSeg(seg);
      line += fx[1];
      qval = qval === '' ? fx[0] : qval + fx[0];
    }
    pos = q + 1;
    if (pos >= n) {
      st.pos = n;
      st.line = line;
      st.val = qval;
      st.end = 2;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      st.pos = pos + 1;
      st.line = line;
      st.val = qval;
      st.end = 0;
      return;
    }
    if (c === 10) {
      st.pos = pos + 1;
      st.line = line + 1;
      st.val = qval;
      st.end = 1;
      return;
    }
    if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
      st.pos = pos + 2;
      st.line = line + 1;
      st.val = qval;
      st.end = 1;
      return;
    }
    // Junk follows the closing quote: read on as unquoted.
    st.pos = pos;
    st.line = line;
    readUnquoted(st, qval);
    if (st.added > 0) pushErr(st, 'quote_junk');
    return;
  }
}

/** csv-reader 1.0.0's answer for one case's input {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const st = {
    t: text,
    n: text.length,
    pos: 0,
    line: 1,
    recEnd: 0,
    errors: null,
    recordLine: 1,
    recordRow: null,
    val: '',
    end: 0,
    added: 0,
  };
  if (st.n > 0 && text.charCodeAt(0) === 0xFEFF) st.pos = 1;

  const rows = [];
  let columns = null;
  let width = -1;

  while (true) {
    // Lines with no characters are no records.
    while (st.pos < st.n) {
      const c = text.charCodeAt(st.pos);
      if (c === 10) {
        st.pos += 1;
        st.line += 1;
      } else if (c === 13 && st.pos + 1 < st.n && text.charCodeAt(st.pos + 1) === 10) {
        st.pos += 2;
        st.line += 1;
      } else {
        break;
      }
    }
    if (st.pos >= st.n) break;

    st.recordLine = st.line;
    st.recordRow = header && columns === null ? null : rows.length;
    st.recEnd = text.indexOf('\n', st.pos);
    if (st.recEnd === -1) st.recEnd = st.n;
    const fields = [];
    let quoted = false;

    // Field loop: one field per iteration, ends when the field does not end at a comma.
    while (true) {
      if (text.charCodeAt(st.pos) === 34) {
        quoted = true;
        const lineBefore = st.line;
        readQuoted(st);
        // A quoted field may have swallowed line breaks: re-derive the record's
        // next LF, but only when the quoted field actually crossed one.
        if (st.end === 0 && st.line !== lineBefore) {
          st.recEnd = text.indexOf('\n', st.pos);
          if (st.recEnd === -1) st.recEnd = st.n;
        }
      } else {
        quoted = false;
        readUnquoted(st, '');
      }
      fields.push(st.val);
      if (st.end !== 0) break;
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      if (st.errors === null) st.errors = [];
      st.errors.push({ code: 'short_row', line: st.recordLine, row: st.recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      if (st.errors === null) st.errors = [];
      st.errors.push({ code: 'long_row', line: st.recordLine, row: st.recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns === null ? [] : columns) : null, rows, errors: st.errors === null ? [] : st.errors };
}
