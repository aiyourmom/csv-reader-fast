// Fast pure-JavaScript drop-in for csv-reader 1.0.0 (make.fun).
// Answers must be byte-identical to the reference on every input,
// including its broken-row policy; only then does speed matter.
//
// How it works (no WASM, no native code, no codegen, stdlib only):
//  - Outer loop cuts one record at a time up to the next LF, using a
//    BOUNDED slice. An unbounded indexOf would scan to EOF when there
//    is no match, which turns into O(n^2) on LF-only files.
//  - A record with no quote and no stray CR is split in one native
//    split(',') call. A record with quotes but no stray CR goes through
//    a one-line transducer (parseSingleLine) that jumps from separator
//    to separator with indexOf/slice and never allocates per field.
//  - Anything else (stray CR, a quoted field that runs past the line,
//    an unterminated quote) falls back to a scalar per-field reader
//    that mirrors the reference character by character, only faster:
//    it advances with indexOf inside bounded slices instead of
//    stepping one character at a time.
//
// Semantics, copied from the reference (vendor/csv-reader/index.js):
//  - A U+FEFF at the very start is dropped. A record ends at LF or
//    CRLF; a line left with no characters is no record.
//  - Outside quotes a CR not followed by LF is dropped (stray_cr).
//  - A field opening with a quote runs to the next quote that is not
//    doubled; "" inside it is one quote; each CRLF or lone CR inside
//    it reads as LF. What follows the closing quote up to the next
//    comma or line break is appended as it stands (quote_junk, when
//    the field ends). A quote that never closes is a literal, and the
//    text after it is read again as unquoted (unterminated_quote).
//  - A quote inside an unquoted field is a literal. Fields stay
//    strings, never trimmed or converted.
//  - columns is the first record when header is true, else null; rows
//    are padded with "" (short_row, with fields: its count) or cut
//    (long_row, with extra: the cut fields) to the first record's
//    width. The header itself never gets short_row/long_row.
//  - Each error is {code, line, row}, in the order met; line is the
//    1-based line its record starts on, counting every LF, CRLF and
//    lone CR inside quotes; row is the record's index in rows, null
//    for the header.
//  - A line holding only stray CRs is left with no characters: no
//    record, but its stray_cr errors stay.
//  - No state is kept between run() calls; each case is answered alone.

// How a field ended: at a comma, at a line break, or at end of text.
const AT_COMMA = 0;
const AT_BREAK = 1;
const AT_EOF = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  // Cursor over the text, plus the line the cursor is on.
  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on, and the index in
  // rows it takes (null while the header is being read).
  let startLine = 1;
  let startRow = null;

  // Append the quoted segment text[a..b) to value. CRLF and lone CR
  // inside quotes each become one LF and move the line count. The
  // common case (no CR/LF at all) is a single concatenation.
  function pushQuoted(value, a, b) {
    const seg = text.slice(a, b);
    if (seg.indexOf('\r') === -1 && seg.indexOf('\n') === -1) return value + seg;
    let out = value;
    let from = 0;
    let i = 0;
    const m = seg.length;
    while (i < m) {
      const c = seg.charCodeAt(i);
      if (c === 13) {
        out += seg.slice(from, i) + '\n';
        line += 1;
        // CRLF consumes two characters, lone CR one.
        i += i + 1 < m && seg.charCodeAt(i + 1) === 10 ? 2 : 1;
        from = i;
      } else {
        if (c === 10) line += 1;
        i += 1;
      }
    }
    return out + seg.slice(from);
  }

  // Read unquoted characters onto `value` up to the next comma, line
  // break, or end of text. A CR not followed by LF is dropped and
  // reported as stray_cr; the field then continues. Returns the field
  // and how it ended; `kept` counts the characters retained, which
  // the caller uses to decide whether junk followed a closing quote.
  // The CR search is always confined to the bounded chunk [p, end):
  // searching the whole rest of the text would scan to EOF whenever
  // a record holds no CR at all.
  function scanBare(value) {
    let kept = 0;
    let p = pos;
    for (;;) {
      const iComma0 = text.indexOf(',', p);
      const iLf0 = text.indexOf('\n', p);
      // Keep the original LF position: remapping a missing LF to n
      // would make a trailing CR at EOF look like a CRLF and swallow
      // its stray_cr error.
      const iLf = iLf0 === -1 ? n : iLf0;
      const iComma = iComma0 === -1 ? n : iComma0;
      const end = iComma < iLf ? iComma : iLf;
      const chunk = text.slice(p, end);
      const iCr = chunk.indexOf('\r');
      if (iCr !== -1) {
        if (iCr === chunk.length - 1 && iLf0 !== -1 && end === iLf0) {
          // CRLF: the record ends here.
          if (iCr > 0) {
            value += chunk.slice(0, iCr);
            kept += iCr;
          }
          pos = end + 1;
          line += 1;
          return { value, ended: AT_BREAK, kept };
        }
        // Stray CR: report it, drop it, keep reading the same field.
        errors.push({ code: 'stray_cr', line: startLine, row: startRow });
        if (iCr > 0) {
          value += chunk.slice(0, iCr);
          kept += iCr;
        }
        p += iCr + 1;
        continue;
      }
      if (chunk.length > 0) {
        value += chunk;
        kept += chunk.length;
      }
      if (end === n) {
        pos = n;
        return { value, ended: AT_EOF, kept };
      }
      if (end === iComma) {
        pos = end + 1;
        return { value, ended: AT_COMMA, kept };
      }
      pos = end + 1;
      line += 1;
      return { value, ended: AT_BREAK, kept };
    }
  }

  // Read a quoted field whose opening quote sits at pos. On a closing
  // quote, whatever follows up to the next comma or line break is
  // appended as it stands (junk). If the quote never closes, it is a
  // literal and the text after it is read again as unquoted, with the
  // line reset to where the quote opened (newlines inside the failed
  // quote do not count).
  function scanQuoted() {
    const open = pos;
    const openLine = line;
    let p = pos + 1;
    let value = '';
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: startLine, row: startRow });
        pos = open + 1;
        return scanBare('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        // Doubled quote inside the field: one literal quote.
        value = pushQuoted(value, p, q) + '"';
        p = q + 2;
        continue;
      }
      // Closing quote at q.
      value = pushQuoted(value, p, q);
      const nx = q + 1;
      if (nx >= n) {
        pos = n;
        return { value, ended: AT_EOF, kept: 0 };
      }
      const c = text.charCodeAt(nx);
      if (c === 44) {
        pos = nx + 1;
        return { value, ended: AT_COMMA, kept: 0 };
      }
      if (c === 10) {
        pos = nx + 1;
        line += 1;
        return { value, ended: AT_BREAK, kept: 0 };
      }
      if (c === 13 && text.charCodeAt(nx + 1) === 10) {
        pos = nx + 2;
        line += 1;
        return { value, ended: AT_BREAK, kept: 0 };
      }
      // Junk after the closing quote: appended as it stands.
      pos = nx;
      const junk = scanBare(value);
      if (junk.kept > 0) {
        errors.push({ code: 'quote_junk', line: startLine, row: startRow });
      }
      return junk;
    }
  }

  // Apply the first record's width (pad / cut) and record short_row /
  // long_row. The header sets the width and is never itself padded,
  // cut, or reported.
  function closeRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: startLine, row: startRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: startLine, row: startRow, extra: fields.slice(width) });
      fields.length = width;
    }
    rows.push(fields);
  }

  // Transducer for one record that fits on a single line (no stray CR,
  // no LF inside a quoted field). Walks field by field with indexOf
  // jumps and slice, allocating nothing per field. Returns
  // {fields, junk} — junk counts the fields that had junk after their
  // closing quote — or null when a quoted field does not close on this
  // line, meaning the record is multiline or unterminated and the
  // caller must use the scalar slow path. Errors are NOT pushed here:
  // if this returns null after spotting junk, the slow path will meet
  // the same junk again and pushing here would duplicate the error.
  // A quote in the middle of an unquoted field is a literal there,
  // so the unquoted branch simply stops at the next comma.
  function parseSingleLine(body) {
    const fields = [];
    const L = body.length;
    let junk = 0;
    let i = 0;
    for (;;) {
      if (body.charCodeAt(i) === 34) {
        // Quoted field opening at i.
        let value = '';
        let j = i + 1;
        let closed = -1;
        for (;;) {
          const q = body.indexOf('"', j);
          if (q === -1) return null;
          if (body.charCodeAt(q + 1) === 34) {
            value += body.slice(j, q) + '"';
            j = q + 2;
            continue;
          }
          value += body.slice(j, q);
          closed = q;
          break;
        }
        const nx = closed + 1;
        if (nx >= L) {
          fields.push(value);
          return { fields, junk };
        }
        if (body.charCodeAt(nx) === 44) {
          fields.push(value);
          i = nx + 1;
          continue;
        }
        // Junk after the closing quote, up to the next comma or the
        // end of the line. Junk is always non-empty on this branch
        // (a comma or end-of-line was handled above), so it is always
        // one quote_junk error per such field.
        junk += 1;
        const nc = body.indexOf(',', nx);
        if (nc === -1) {
          fields.push(value + body.slice(nx));
          return { fields, junk };
        }
        fields.push(value + body.slice(nx, nc));
        i = nc + 1;
        continue;
      }
      // Unquoted field: up to the next comma or the end of the line.
      const nc = body.indexOf(',', i);
      if (nc === -1) {
        fields.push(body.slice(i));
        return { fields, junk };
      }
      fields.push(body.slice(i, nc));
      i = nc + 1;
    }
  }

  // Slow path: read one record field by field with the scalar
  // readers. Used when the record holds a stray CR or a quoted field
  // that runs past the line. Returns the fields, or null when the
  // record turns out to hold only stray CRs (no record, errors stay).
  function readRecordSlow() {
    const fields = [];
    let ended;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      const f = quoted ? scanQuoted() : scanBare('');
      fields.push(f.value);
      ended = f.ended;
    } while (ended === AT_COMMA);
    if (fields.length === 1 && fields[0] === '' && !quoted) return null;
    return fields;
  }

  while (pos < n) {
    // One record's worth of text, up to the next LF (bounded slice).
    const nl = text.indexOf('\n', pos);
    const recEnd = nl === -1 ? n : nl;
    const hasLf = nl !== -1;
    const seg = text.slice(pos, recEnd);
    // Drop the CR that closes a CRLF; a line with nothing left is
    // no record.
    let body = seg;
    if (hasLf && body.length > 0 && body.charCodeAt(body.length - 1) === 13) body = body.slice(0, -1);
    if (body.length === 0) {
      line += 1;
      pos = hasLf ? recEnd + 1 : n;
      continue;
    }
    startLine = line;
    startRow = header && columns === null ? null : rows.length;
    // A stray CR inside the line needs the scalar slow path.
    if (body.indexOf('\r') !== -1) {
      const fields = readRecordSlow();
      if (fields !== null) closeRecord(fields);
      continue;
    }
    if (body.indexOf('"') === -1) {
      // No quote at all: one native split per record.
      closeRecord(body.split(','));
      line += 1;
      pos = hasLf ? recEnd + 1 : n;
      continue;
    }
    const one = parseSingleLine(body);
    if (one !== null) {
      for (let k = 0; k < one.junk; k++) {
        errors.push({ code: 'quote_junk', line: startLine, row: startRow });
      }
      closeRecord(one.fields);
      line += 1;
      pos = hasLf ? recEnd + 1 : n;
      continue;
    }
    // A quoted field runs past this line (multiline / unterminated).
    const fields = readRecordSlow();
    if (fields !== null) closeRecord(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
