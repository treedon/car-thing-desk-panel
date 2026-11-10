// A synthetic Claude Code transcript of a chosen size, for measuring what reading a big one costs
// (scripts/hook-latency.js and test/digest-latency.test.js). Nothing in it comes from a real session; the
// same arguments always write the same bytes. Shaped like the real thing where the digest looks:
//   - a turn, 39 lines, is a human prompt (origin.kind "human"), 18 Bash calls with their results (20-200 KB of
//     stdout each, and every seventh an `npm test` that ends in a pass/fail count), then an assistant reply
//     with stop_reason "end_turn" and the stop_hook_summary system record that closes the turn;
//   - one 2 MB attachment line per 8 MB asked for (three at the most), spread through the file, since the
//     largest lines in real transcripts are attachments and a reader must not hold them whole;
//   - timestamps a quarter of a second apart, ending before nowMs, so every record is inside the digest's
//     24 h window when nowMs is the digest's clock.
import fs from 'node:fs';

const MB = 1024 * 1024;
const MIN_STDOUT = 20_000; // characters
const MAX_STDOUT = 200_000;
const STEPS_PER_TURN = 20; // a prompt, 18 Bash calls (two lines each) and the closing reply (two): 39 lines
const ATTACHMENT_BYTES = 2 * MB;
const MAX_ATTACHMENTS = 3;
const TICK_MS = 250;
const SPAN_BEFORE_NOW_MS = 3_600_000;

// A small seeded generator, so a file is the same every time.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Text with what real output has and a JSON parser has to work for: newlines, quotes, backslashes and
// multi-byte characters, all escaped or decoded on the way.
const OUTPUT_LINE = 'ℹ test "handles a quoted \\ path" at src/digest/reader.js:123:7 ✔ (1.23ms)\n';
const OUTPUT_POOL = OUTPUT_LINE.repeat(Math.ceil(MAX_STDOUT / OUTPUT_LINE.length) + 1);
const outputOf = (chars) => OUTPUT_POOL.slice(0, chars);
const attachmentText = () => OUTPUT_POOL.repeat(Math.ceil(ATTACHMENT_BYTES / OUTPUT_POOL.length)).slice(0, ATTACHMENT_BYTES);
const TEST_TAIL = 'ℹ tests 41\nℹ pass 41\nℹ fail 0\n';

// Writes the transcript to `file`, which must not exist (an existing file is never written over; the
// file is made mode 0600), about `megabytes` MB long, and returns { bytes, lines, turns, attachments }.
export function writeSyntheticTranscript(file, megabytes, { nowMs = Date.now() } = {}) {
  if (!Number.isFinite(megabytes) || megabytes <= 0) throw new RangeError('megabytes must be a number above 0');
  const target = Math.floor(megabytes * MB);
  const attachments = Math.min(MAX_ATTACHMENTS, Math.floor(megabytes / 8));
  const rand = mulberry32(0x5eed);
  const start = nowMs - SPAN_BEFORE_NOW_MS;
  const cwd = '/Users/dev/proj';

  const fd = fs.openSync(file, 'wx', 0o600);
  let bytes = 0;
  let lines = 0;
  let turns = 0;
  let placed = 0;
  let turnOpen = false;
  let n = 0; // records written, for the timestamps
  const put = (record) => {
    const text = JSON.stringify({ ...record, timestamp: new Date(start + n++ * TICK_MS).toISOString(), cwd }) + '\n';
    bytes += fs.writeSync(fd, text);
    lines++;
  };
  const endTurn = () => {
    put({ type: 'assistant', message: { role: 'assistant', model: 'claude-synthetic', stop_reason: 'end_turn',
      content: [{ type: 'text', text: `Done. All ${turns + 1} checks pass.` }] } });
    put({ type: 'system', subtype: 'stop_hook_summary' });
    turnOpen = false;
    turns++;
  };

  try {
    for (let step = 0; bytes < target; step++) {
      // the attachments go in at a quarter, a half and three quarters of the way
      if (placed < attachments && bytes >= ((placed + 1) / (attachments + 1)) * target) {
        put({ type: 'attachment', attachment: { type: 'file', content: attachmentText() } });
        placed++;
      }
      const at = step % STEPS_PER_TURN;
      if (at === 0) {
        put({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: `Please run check number ${turns + 1} and tell me what you find.` } });
        turnOpen = true;
      } else if (at === STEPS_PER_TURN - 1) {
        endTurn();
      } else {
        const id = `toolu_${String(step).padStart(6, '0')}`;
        const isTest = step % 7 === 0;
        const chars = MIN_STDOUT + Math.floor(rand() * (MAX_STDOUT - MIN_STDOUT));
        put({ type: 'assistant', message: { role: 'assistant', model: 'claude-synthetic', stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id, name: 'Bash', input: { command: isTest ? 'npm test' : `ls -l src/part${step}` } }] } });
        const stdout = isTest ? outputOf(chars - TEST_TAIL.length) + TEST_TAIL : outputOf(chars);
        put({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: stdout }] },
          toolUseResult: { stdout, stderr: '' } });
      }
    }
    if (turnOpen) endTurn();
  } finally {
    fs.closeSync(fd);
  }
  return { bytes, lines, turns, attachments: placed };
}
