'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * One JSON object per line, appended to a file the client owns. Size-based
 * rotation: query.jsonl -> query.jsonl.1 -> ... -> query.jsonl.<keep>, oldest
 * dropped. Nothing here writes a row of data or a credential; the fields are
 * fixed by writeQuery below and the statement text is optional.
 */
class QueryLog {
  constructor(options) {
    this.path = options.path;
    this.maxBytes = options.maxBytes;
    this.keep = options.keep;
    this.includeStatementText = options.includeStatementText !== false;
    this.fd = null;
    this.bytes = 0;
  }

  open() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    try {
      this.bytes = fs.statSync(this.path).size;
    } catch {
      this.bytes = 0;
    }
    this.fd = fs.openSync(this.path, 'a');
    return this;
  }

  close() {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }

  rotate() {
    this.close();
    for (let n = this.keep - 1; n >= 1; n -= 1) {
      const from = `${this.path}.${n}`;
      const to = `${this.path}.${n + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    if (fs.existsSync(this.path)) fs.renameSync(this.path, `${this.path}.1`);
    const oldest = `${this.path}.${this.keep + 1}`;
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
    this.bytes = 0;
    this.fd = fs.openSync(this.path, 'a');
  }

  /**
   * Written synchronously, so a record is on disk before the response that it
   * describes leaves the process. At the rate limit this service enforces the
   * cost is not measurable, and an audit log that can be lost in a crash is not
   * the log the plan promises the client.
   */
  write(record) {
    const line = `${JSON.stringify(record)}\n`;
    const size = Buffer.byteLength(line);
    if (this.fd === null) this.open();
    if (this.bytes + size > this.maxBytes && this.bytes > 0) this.rotate();
    fs.writeSync(this.fd, line);
    this.bytes += size;
    return line;
  }

  /**
   * The record the plan promises: time, who asked, what was asked, which tables
   * it touched, how many rows came back, how long it took, and the error if any.
   */
  writeQuery(entry) {
    const record = {
      time: entry.time || new Date().toISOString(),
      event: entry.event || 'query',
      caller: entry.caller === undefined ? null : entry.caller,
      statementSha256: entry.statement === undefined || entry.statement === null
        ? null
        : crypto.createHash('sha256').update(entry.statement, 'utf8').digest('hex'),
      tables: entry.tables || [],
      rowCount: entry.rowCount === undefined ? null : entry.rowCount,
      truncated: entry.truncated === true,
      durationMs: entry.durationMs === undefined ? null : entry.durationMs,
      outcome: entry.outcome,
      rule: entry.rule === undefined ? null : entry.rule,
      error: entry.error === undefined ? null : entry.error
    };
    if (this.includeStatementText && typeof entry.statement === 'string') {
      record.statement = entry.statement;
    }
    return this.write(record);
  }
}

module.exports = { QueryLog };
