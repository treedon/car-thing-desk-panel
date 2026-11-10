// Dictation from the panel, transcribed on this Mac and nowhere else: ffmpeg
// turns the recording into 16 kHz mono WAV, whisper.cpp (whisper-cli) reads
// it, and both temp files are deleted whatever happens. No cloud service.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { TOKEN_DIR } from './config.js';

export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export const MAX_SECONDS = 30;
const WAV_BYTES_PER_SECOND = 16000 * 2; // 16 kHz, mono, 16-bit
const WAV_HEADER_BYTES = 44;
const RUN_TIMEOUT_MS = 60_000;

export const WHISPER_MODEL = process.env.CLAUDE_PANEL_WHISPER_MODEL || path.join(TOKEN_DIR, 'ggml-base.en.bin');

// Homebrew's bin is not on a LaunchAgent's minimal PATH everywhere.
const PATH_EXTRA = ['/opt/homebrew/bin', '/usr/local/bin'];

function execRun(cmd, args) {
  const env = { ...process.env, PATH: [process.env.PATH || '', ...PATH_EXTRA].join(':') };
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: RUN_TIMEOUT_MS, env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
    });
  });
}

function fail(code) {
  return new Error(code);
}

function extensionFor(mime) {
  if (/ogg/.test(mime)) return '.ogg';
  if (/mp4|m4a|aac/.test(mime)) return '.m4a';
  if (/wav/.test(mime)) return '.wav';
  return '.webm';
}

// Whisper prints one line per segment; [BLANK_AUDIO] and the like mean nothing
// was said.
function cleanText(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\[[A-Z_ ]+\]$/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function transcribe(audio, mime, { run = execRun, model = WHISPER_MODEL, tmpDir = os.tmpdir() } = {}) {
  if (!audio || audio.length > MAX_AUDIO_BYTES) throw fail('too-long');
  if (!fs.existsSync(model)) throw fail('dictation-not-set-up');
  const base = path.join(tmpDir, `panel-dictation-${crypto.randomBytes(6).toString('hex')}`);
  const input = base + extensionFor(String(mime || ''));
  // Its own name: a WAV recording would otherwise be both ffmpeg's input and
  // output, which ffmpeg refuses.
  const wav = base + '.16k.wav';
  try {
    fs.writeFileSync(input, audio, { mode: 0o600 });
    try {
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', input, '-ar', '16000', '-ac', '1', wav]);
    } catch (err) {
      throw fail(err && err.code === 'ENOENT' ? 'dictation-not-set-up' : 'transcription-failed');
    }
    const seconds = (fs.statSync(wav).size - WAV_HEADER_BYTES) / WAV_BYTES_PER_SECOND;
    if (seconds > MAX_SECONDS) throw fail('too-long');
    let out;
    try {
      out = await run('whisper-cli', ['-m', model, '-f', wav, '-nt', '-np']);
    } catch (err) {
      throw fail(err && err.code === 'ENOENT' ? 'dictation-not-set-up' : 'transcription-failed');
    }
    return cleanText(out.stdout);
  } finally {
    for (const f of [input, wav]) { try { fs.unlinkSync(f); } catch {} }
  }
}
