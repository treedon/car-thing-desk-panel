// The digest's transcript reader: whole JSONL lines from a byte offset, in chunks, each parsed and
// handed to a callback with the byte offset just past the line's newline. It runs in the process that
// answers Claude Code's hooks, over transcripts of tens of MB whose single lines can be megabytes, so:
//   - one chunk is read into one reused buffer, and the loop awaits setImmediate after every chunk, so
//     hooks and timers are served between chunks;
//   - only the new bytes of a chunk are searched for a newline, and a line cut by a chunk edge keeps
//     its pieces in a list that is joined once, when its newline arrives: no rescan, no regrowing buffer;
//   - a line past maxLineBytes is never held whole: its bytes are dropped as they stream by and the
//     callback hears one null for it at its newline;
//   - text is decoded only from a whole line, so a multi-byte character cut by a chunk edge is intact
//     (0x0A never occurs inside a multi-byte UTF-8 sequence).
import fs from 'node:fs/promises';

export const CHUNK_BYTES = 256 * 1024;
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

const NEWLINE = 0x0a;
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

// A line's record: the object it holds, or null when it is not JSON or not a JSON object.
function parseLine(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

const positive = (v, fallback) => (Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback);

// Reads whole lines from fromOffset up to the file's size when the read starts, and calls
// onRecord(record | null, endOffset) for each, in order; endOffset is the byte offset just past the line's
// newline, so offsets only move forward. A line that is not a JSON object, or is longer than maxLineBytes
// (not counting its newline), is reported as null. A last line without its newline yet is not reported:
// the returned offset is the end of the last whole line, where the next read starts.
//
// Resolves { offset, size, shrunk }. When the file is smaller than fromOffset, or ends before the size it
// had at the start, it was truncated or replaced: shrunk is true and the caller starts over from 0.
// A shrunk read from fromOffset past the end reads nothing and returns offset === fromOffset. A file that
// cannot be opened rejects with the system error. A throw from onRecord stops the read and rejects.
export async function readRecords(file, fromOffset, onRecord, opts = {}) {
  const chunkBytes = Math.min(positive(opts.chunkBytes, CHUNK_BYTES), CHUNK_BYTES);
  const maxLineBytes = positive(opts.maxLineBytes, MAX_LINE_BYTES);
  const start = Number.isSafeInteger(fromOffset) && fromOffset > 0 ? fromOffset : 0;

  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size < start) return { offset: start, size, shrunk: true };

    const buf = Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(size - start, 1)));
    let pos = start; // the file offset of the next byte to read
    let offset = start; // just past the last whole line reported
    let pieces = []; // copies of the bytes of the line in progress that earlier chunks held
    let held = 0; // their total length
    let dropping = false; // the line in progress is past maxLineBytes: its bytes are not kept
    let shrunk = false;

    while (pos < size) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (bytesRead === 0) { shrunk = true; break; } // the file ended before the size it had at the start
      const view = buf.subarray(0, bytesRead);

      let from = 0; // where the line in progress continues in this chunk
      for (;;) {
        const nl = view.indexOf(NEWLINE, from);
        if (nl === -1) {
          const tail = bytesRead - from;
          if (tail > 0 && !dropping) {
            if (held + tail > maxLineBytes) {
              pieces = []; held = 0; dropping = true;
            } else {
              pieces.push(Buffer.from(view.subarray(from))); // a copy: buf is reused for the next chunk
              held += tail;
            }
          }
          break;
        }
        const length = held + (nl - from);
        const end = pos + nl + 1;
        if (dropping || length > maxLineBytes) {
          onRecord(null, end);
        } else {
          let text;
          if (held === 0) {
            text = view.toString('utf8', from, nl);
          } else {
            pieces.push(view.subarray(from, nl));
            text = Buffer.concat(pieces, length).toString('utf8');
          }
          onRecord(parseLine(text), end);
        }
        if (held > 0 || dropping) { pieces = []; held = 0; dropping = false; }
        offset = end;
        from = nl + 1;
      }

      pos += bytesRead;
      await yieldToLoop();
    }
    return { offset, size, shrunk };
  } finally {
    await handle.close();
  }
}
