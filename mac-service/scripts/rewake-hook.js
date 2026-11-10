#!/usr/bin/env node
// Claude Code Stop hook, installed with "asyncRewake": true. It runs in the
// background after a turn ends and long-polls the Mac service for a message
// the owner dictated on the desk panel. With one: print it to stderr and exit
// 2, which wakes Claude with the text as a system reminder. Otherwise (owner
// typed, service down, hold over): exit 0 and change nothing.
// A Stop that ends a woken turn (stop_hook_active) polls again: this is the only
// Stop hook that continues a turn, and a poller fires only on a message the
// owner sent, so it can't loop, and a second reply from the panel can land.
import http from 'node:http';

// The installer passes the service's port as the first argument; the
// environment variables are fallbacks.
const PORT = Number(process.argv[2]) || Number(process.env.CLAUDE_THING_PORT) || Number(process.env.CLAUDE_PANEL_PORT) || 8790;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

let input = {};
try { input = JSON.parse(await readStdin() || '{}'); } catch {}
const session = input.session_id;
if (!session) process.exit(0);

const req = http.get({
  host: '127.0.0.1', port: PORT, path: `/hook/rewake?session=${encodeURIComponent(session)}`,
}, (res) => {
  let body = '';
  res.setEncoding('utf8');
  res.on('data', (c) => { body += c; });
  res.on('end', () => {
    if (res.statusCode === 200 && body.trim()) {
      process.stderr.write(body.trim() + '\n', () => process.exit(2));
    } else {
      process.exit(0);
    }
  });
});
req.on('error', () => process.exit(0));
