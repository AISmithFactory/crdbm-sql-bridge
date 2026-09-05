'use strict';

/**
 * A conservative, T-SQL-aware lexical pass.
 *
 * It exists because the parser is not sufficient on its own. Measured against
 * node-sql-parser 5.4.0 with `database: 'transactsql'` on 2026-09-05:
 * `SELECT * FROM OPENROWSET(a,b,c)` parses cleanly as a plain SELECT with an
 * EMPTY table list, so neither the statement-type check nor the allowlist sees
 * it. The bans the plan promises are therefore enforced lexically, here, before
 * the statement reaches the parser, and the parser is used for the thing it is
 * genuinely better at: telling us which tables a statement reads.
 *
 * The scan blanks comments and string literals (so a semicolon or the word
 * EXEC inside a literal cannot cause a false refusal) and keeps the contents of
 * bracketed and double-quoted identifiers, marked as `quoted` so that a column
 * legitimately named [set] is not mistaken for the SET statement.
 */

const OPEN_STATES = {
  string: 'unterminated-literal',
  bracket: 'unterminated-identifier',
  dquote: 'unterminated-identifier',
  block: 'unterminated-comment'
};

/**
 * @param {string} sql
 * @returns {{scrubbed: string, tokens: Array<{word: string, index: number, quoted: boolean}>,
 *            semicolons: number[], sigils: number[], open: string|null}}
 */
function scan(sql) {
  const out = new Array(sql.length);
  const quotedRanges = [];
  const semicolons = [];
  const sigils = [];

  let i = 0;
  let state = 'normal';
  let blockDepth = 0;
  let quotedStart = -1;

  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) out[k] = ' ';
  };

  while (i < sql.length) {
    const c = sql[i];
    const c2 = sql[i + 1];

    if (state === 'normal') {
      if (c === '-' && c2 === '-') {
        const end = sql.indexOf('\n', i);
        const stop = end === -1 ? sql.length : end;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (c === '/' && c2 === '*') {
        state = 'block';
        blockDepth = 1;
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "'") {
        state = 'string';
        out[i] = ' ';
        i += 1;
        continue;
      }
      if (c === '[') {
        state = 'bracket';
        quotedStart = i + 1;
        out[i] = ' ';
        i += 1;
        continue;
      }
      if (c === '"') {
        state = 'dquote';
        quotedStart = i + 1;
        out[i] = ' ';
        i += 1;
        continue;
      }
      if (c === ';') semicolons.push(i);
      if (c === '@') sigils.push(i);
      out[i] = c;
      i += 1;
      continue;
    }

    if (state === 'block') {
      if (c === '/' && c2 === '*') {
        blockDepth += 1;
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '*' && c2 === '/') {
        blockDepth -= 1;
        blank(i, i + 2);
        i += 2;
        if (blockDepth === 0) state = 'normal';
        continue;
      }
      out[i] = c === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }

    if (state === 'string') {
      if (c === "'" && c2 === "'") {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "'") {
        out[i] = ' ';
        i += 1;
        state = 'normal';
        continue;
      }
      out[i] = c === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }

    if (state === 'bracket' || state === 'dquote') {
      const closer = state === 'bracket' ? ']' : '"';
      if (c === closer && c2 === closer) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === closer) {
        quotedRanges.push([quotedStart, i]);
        out[i] = ' ';
        i += 1;
        state = 'normal';
        continue;
      }
      out[i] = c;
      i += 1;
      continue;
    }
  }

  const open = state === 'normal' ? null : OPEN_STATES[state];
  const scrubbed = out.map((ch) => (ch === undefined ? ' ' : ch)).join('');

  const tokens = [];
  const re = /[A-Za-z_#][A-Za-z0-9_$#]*/g;
  let m;
  while ((m = re.exec(scrubbed)) !== null) {
    const index = m.index;
    const quoted = quotedRanges.some(([a, b]) => index >= a && index < b);
    tokens.push({ word: m[0], index, quoted });
  }

  return { scrubbed, tokens, semicolons, sigils, open };
}

module.exports = { scan };
