// The chunked offset reader the digest reads transcripts with: whole lines from a byte offset, in chunks,
// yielding to the event loop between them, each line parsed and handed over with the offset just past it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { readRecords, CHUNK_BYTES, MAX_LINE_BYTES } from '../src/digest/reader.js';

let dir;
let n = 0;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-reader-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const file = (content) => {
  const f = path.join(dir, `t${n++}.jsonl`);
  fs.writeFileSync(f, content);
  return f;
};
const line = (o) => `${JSON.stringify(o)}\n`;
const bytes = (s) => Buffer.byteLength(s);
const collect = async (f, from, opts) => {
  const seen = [];
  const result = await readRecords(f, from, (record, end) => seen.push([record, end]), opts);
  return { seen, result };
};

test('the defaults are 256 KB chunks and 4 MB lines', () => {
  assert.deepEqual([CHUNK_BYTES, MAX_LINE_BYTES], [256 * 1024, 4 * 1024 * 1024]);
});

test('reads whole lines from an offset and returns the new offset', async () => {
  const a = { type: 'user', n: 1 }; const b = { type: 'assistant', n: 2 }; const c = { type: 'system', n: 3 };
  const f = file(line(a) + line(b) + line(c));
  const size = bytes(line(a) + line(b) + line(c));

  const all = await collect(f, 0);
  assert.deepEqual(all.seen, [[a, bytes(line(a))], [b, bytes(line(a) + line(b))], [c, size]]);
  assert.deepEqual(all.result, { offset: size, size, shrunk: false });

  const rest = await collect(f, bytes(line(a)));
  assert.deepEqual(rest.seen, [[b, bytes(line(a) + line(b))], [c, size]]);
  assert.deepEqual(rest.result, { offset: size, size, shrunk: false });

  const none = await collect(f, size);
  assert.deepEqual(none.seen, []);
  assert.deepEqual(none.result, { offset: size, size, shrunk: false });
});

test('a torn last line is left for the next read', async () => {
  const a = { type: 'user' };
  const f = file(line(a) + '{"type":"assis');
  const seen = [];
  const r1 = await readRecords(f, 0, (r) => seen.push(r));
  assert.deepEqual([seen.length, r1.offset], [1, Buffer.byteLength(line(a))]);
  assert.equal(r1.size, bytes(line(a) + '{"type":"assis'));
  fs.appendFileSync(f, 'tant"}\n');
  await readRecords(f, r1.offset, (r) => seen.push(r));
  assert.deepEqual(seen.map((r) => r.type), ['user', 'assistant']);
});

test('a malformed or oversize line reports null and reading continues', async () => {
  const ok1 = { type: 'user', n: 1 }; const ok2 = { type: 'user', n: 2 };
  const text = line(ok1) + '{bad\n' + 'x'.repeat(5000) + '\n' + line(ok2);
  const { seen, result } = await collect(file(text), 0, { maxLineBytes: 1000 });
  assert.deepEqual(seen, [[ok1, bytes(line(ok1))], [null, bytes(line(ok1) + '{bad\n')],
    [null, bytes(line(ok1) + '{bad\n' + 'x'.repeat(5000) + '\n')], [ok2, bytes(text)]]);
  assert.deepEqual(result, { offset: bytes(text), size: bytes(text), shrunk: false });
});

test('a blank line, and a line that is JSON but not an object, report null', async () => {
  const ok = { type: 'user' };
  const text = line(ok) + '\n' + '123\n' + '"x"\n' + 'null\n' + '[1]\n' + line(ok);
  const { seen } = await collect(file(text), 0);
  assert.deepEqual(seen.map(([r]) => r), [ok, null, null, null, null, null, ok]);
  assert.equal(seen[6][1], bytes(text));
});

test('a line of exactly maxLineBytes is read, one byte more is not, wherever the chunks fall', async () => {
  const pad = (len) => JSON.stringify({ t: 'u', s: 'x'.repeat(len - '{"t":"u","s":""}'.length) });
  const exact = pad(1000); const over = pad(1001);
  assert.deepEqual([exact.length, over.length], [1000, 1001]);
  const text = `${exact}\n${over}\n${exact}\n`;
  for (const chunkBytes of [1, 7, 999, 1000, 1001, 1002, 4096, CHUNK_BYTES]) {
    const { seen, result } = await collect(file(text), 0, { chunkBytes, maxLineBytes: 1000 });
    assert.deepEqual(seen.map(([r, end]) => [r === null ? null : r.s.length, end]),
      [[1000 - '{"t":"u","s":""}'.length, 1001], [null, 2003], [1000 - '{"t":"u","s":""}'.length, 3004]], `chunkBytes ${chunkBytes}`);
    assert.equal(result.offset, 3004);
  }
});

test('a character split across chunks decodes whole', async () => {
  const text = 'é—✓';
  const rec = { type: 'user', text };
  const content = line(rec) + line({ type: 'user', text: text.repeat(5) });
  for (const chunkBytes of [1, 2, 3, 5, 7, 11]) {
    const { seen, result } = await collect(file(content), 0, { chunkBytes });
    assert.deepEqual(seen.map(([r]) => r.text), [text, text.repeat(5)], `chunkBytes ${chunkBytes}`);
    assert.deepEqual(seen.map(([, end]) => end), [bytes(line(rec)), bytes(content)]);
    assert.equal(result.offset, bytes(content));
  }
});

test('a file smaller than the offset is reported as shrunk', async () => {
  const f = file(line({ type: 'user' }));
  const seen = [];
  const r = await readRecords(f, 10_000, (x) => seen.push(x));
  assert.equal(r.shrunk, true);
  assert.deepEqual([seen.length, r.offset, r.size], [0, 10_000, bytes(line({ type: 'user' }))]);
});

test('a file truncated during the read is reported as shrunk, with the offset of the last whole line', async () => {
  const a = { type: 'user', n: 1, pad: 'a'.repeat(20) }; const b = { type: 'user', n: 2, pad: 'b'.repeat(40) };
  const f = file(line(a) + line(b));
  const seen = [];
  const r = await readRecords(f, 0, (rec, end) => { seen.push([rec, end]); fs.truncateSync(f, bytes(line(a))); }, { chunkBytes: 4 });
  assert.deepEqual(seen, [[a, bytes(line(a))]]);
  assert.deepEqual(r, { offset: bytes(line(a)), size: bytes(line(a) + line(b)), shrunk: true });
});

test('a missing file rejects instead of reporting an empty read', async () => {
  await assert.rejects(readRecords(path.join(dir, 'nope.jsonl'), 0, () => {}), { code: 'ENOENT' });
});

test('it yields between chunks', async () => {
  const rec = line({ type: 'assistant', text: 'y'.repeat(900) });
  const f = file(rec.repeat(Math.ceil((4 * 1024 * 1024) / bytes(rec))));
  const size = fs.statSync(f).size;
  const chunks = Math.ceil(size / (64 * 1024));
  // Two views of the same property. The reader's own setImmediate calls are counted (one per chunk), and a loop
  // that re-arms a setImmediate of its own counts the turns the event loop took: it can not run fewer than one
  // per chunk, and a loaded machine only adds turns, so half the chunks is a floor with room to spare.
  const realImmediate = globalThis.setImmediate;
  let yields = 0; let turns = 0; let h;
  const spin = () => { turns++; h = realImmediate(spin); };
  let count = 0; let r;
  globalThis.setImmediate = (...args) => { yields++; return realImmediate(...args); };
  try {
    spin();
    r = await readRecords(f, 0, () => count++, { chunkBytes: 64 * 1024 });
  } finally {
    globalThis.setImmediate = realImmediate;
    clearImmediate(h);
  }
  assert.ok(yields >= chunks, `${yields} yields for ${chunks} chunks`);
  assert.ok(turns >= chunks / 2, `the event loop turned ${turns} times during ${chunks} chunks`);
  assert.deepEqual([r.offset, r.size, count], [size, size, size / bytes(rec)]);
});

test('one 3.9 MB line among normal lines, read in small chunks, is linear and reported once', async () => {
  const small1 = { type: 'user', n: 1 }; const small2 = { type: 'assistant', n: 2 };
  const big = { type: 'assistant', blob: 'z'.repeat(3_900_000) };
  const text = line(small1) + line(big) + line(small2);
  const f = file(text);
  const want = [[small1, bytes(line(small1))], [big, bytes(line(small1) + line(big))], [small2, bytes(text)]];
  const timed = async (name, opts) => {
    let best = Infinity;
    for (let attempt = 0; attempt < 3; attempt++) {
      const t0 = performance.now();
      await readRecords(name, 0, () => {}, opts);
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };

  // Every line exactly once, with its end offset, at the real chunk size and at a small one.
  for (const chunkBytes of [64 * 1024, 4096]) {
    const { seen, result } = await collect(f, 0, { chunkBytes });
    assert.deepEqual(seen, want, `chunkBytes ${chunkBytes}`);
    assert.deepEqual(result, { offset: bytes(text), size: bytes(text), shrunk: false });
  }

  // At the real chunk size the whole read is a few milliseconds; a second is a ceiling no load reaches.
  const real = await timed(f, { chunkBytes: 64 * 1024 });
  assert.ok(real < 1000, `64 KB chunks: ${Math.round(real)} ms`);

  // In 256-byte chunks the 3.9 MB line is 15,000+ chunks. Joining or rescanning its carry for every chunk costs
  // seconds there (a naive reader: 1 s alone, 10 times a reader that keeps the pieces), but per-chunk I/O costs
  // whatever the machine's load makes it. So the line is timed against 3.9 MB of ordinary lines read in the same
  // chunks, which has the same number of chunks and none of the carry: the two scale together with load.
  const ordinary = file(line({ type: 'user', pad: 'p'.repeat(80) }).repeat(Math.ceil(3_900_000 / 100)));
  const base = await timed(ordinary, { chunkBytes: 256 });
  const one = await timed(f, { chunkBytes: 256 });
  assert.ok(one < base * 3 + 150, `one 3.9 MB line took ${Math.round(one)} ms, 3.9 MB of ordinary lines ${Math.round(base)} ms`);
});

test('a line far past maxLineBytes is dropped as it streams: one null, the lines around it intact', async () => {
  const small1 = { type: 'user', n: 1 }; const small2 = { type: 'user', n: 2 };
  const huge = 'q'.repeat(9_000_000);
  const text = line(small1) + huge + '\n' + line(small2);
  const { seen, result } = await collect(file(text), 0, { chunkBytes: 4096 });
  assert.deepEqual(seen, [[small1, bytes(line(small1))], [null, bytes(line(small1) + huge + '\n')], [small2, bytes(text)]]);
  assert.deepEqual(result, { offset: bytes(text), size: bytes(text), shrunk: false });
});

test('a 64 MB line is never held whole: memory stays near maxLineBytes while it streams by', async () => {
  const f = path.join(dir, `t${n++}.jsonl`);
  const fd = fs.openSync(f, 'w');
  const head = line({ type: 'user', n: 1 }); const tail = line({ type: 'user', n: 2 });
  const mb = Buffer.alloc(1024 * 1024, 'q');
  fs.writeSync(fd, head);
  for (let i = 0; i < 64; i++) fs.writeSync(fd, mb);
  fs.writeSync(fd, '\n' + tail);
  fs.closeSync(fd);
  const size = bytes(head) + 64 * 1024 * 1024 + 1 + bytes(tail);
  assert.equal(fs.statSync(f).size, size);
  // Buffers count as arrayBuffers: sample them at every turn of the loop, which the reader gives once per chunk.
  const base = process.memoryUsage().arrayBuffers;
  let peak = 0; let h;
  const sample = () => { peak = Math.max(peak, process.memoryUsage().arrayBuffers); h = setImmediate(sample); };
  sample();
  const { seen, result } = await collect(f, 0, { chunkBytes: 64 * 1024 });
  clearImmediate(h);
  assert.deepEqual(seen.map(([r, end]) => [r && r.n, end]), [[1, bytes(head)], [null, bytes(head) + 64 * 1024 * 1024 + 1], [2, size]]);
  assert.deepEqual(result, { offset: size, size, shrunk: false });
  const grew = Math.round((peak - base) / (1024 * 1024));
  assert.ok(grew < 16, `buffer memory grew by ${grew} MB while reading a 64 MB line`);
});

test('an oversize line still being written is not reported, and the offset stays before it', async () => {
  const ok = { type: 'user' };
  const f = file(line(ok) + 'w'.repeat(5000));
  const { seen, result } = await collect(f, 0, { chunkBytes: 100, maxLineBytes: 1000 });
  assert.deepEqual(seen, [[ok, bytes(line(ok))]]);
  assert.equal(result.offset, bytes(line(ok)));
  fs.appendFileSync(f, 'w\n');
  const next = await collect(f, result.offset, { chunkBytes: 100, maxLineBytes: 1000 });
  assert.deepEqual(next.seen, [[null, bytes(line(ok)) + 5002]]);
});

test('200,000 tiny lines are read in well under a second, and the loop is not starved', async () => {
  const total = 200_000;
  const parts = [];
  for (let i = 0; i < total; i++) parts.push(`{"n":${i}}\n`);
  const text = parts.join('');
  const f = file(text);
  const size = bytes(text);
  let turns = 0; let h;
  const spin = () => { turns++; h = setImmediate(spin); };
  spin();
  let count = 0; let sum = 0; let lastEnd = 0; let forward = true;
  const t0 = performance.now();
  const r = await readRecords(f, 0, (rec, end) => {
    count++; sum += rec.n; if (end <= lastEnd) forward = false; lastEnd = end;
  }, { chunkBytes: 16 * 1024 });
  const ms = performance.now() - t0;
  clearImmediate(h);
  assert.deepEqual([count, sum, lastEnd, forward], [total, (total * (total - 1)) / 2, size, true]);
  assert.deepEqual(r, { offset: size, size, shrunk: false });
  assert.ok(turns >= Math.floor(size / (16 * 1024)) / 2, `the event loop turned ${turns} times during the read`);
  assert.ok(ms < 1000, `${Math.round(ms)} ms`);
});
