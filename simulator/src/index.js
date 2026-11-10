import fs from 'node:fs';
import { HOST, HTTP_PORT, PID_FILE, CACHE_DIR, SERVICE_WS_URL } from './config.js';
import { startHttpServer } from './static-server.js';
import { startCdpThrottle } from './cdp.js';
import { startDemoHouse } from './demo-house.js';
import { startDemoTasks } from './demo-tasks.js';
import { logInfo } from './log.js';

let httpServer;
try {
  // SIM_DEMO=1: a made-up house (mock Home Assistant + LM Studio) instead of the owner's.
  const demoHa = process.env.SIM_DEMO === '1' ? await startDemoHouse() : null;
  const demoTasks = process.env.SIM_DEMO === '1' ? await startDemoTasks() : null;
  httpServer = await startHttpServer({ demoHa, demoTasks });
} catch (err) {
  console.error(`startup failed: ${err.message}`);
  process.exit(1);
}

// Only the simulator run.js manages owns the PID file; a throwaway server (the
// smoke test) must not overwrite or delete it.
const OWNS_PID_FILE = process.env.SIM_NO_PIDFILE !== '1';
if (OWNS_PID_FILE) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
}

if (process.env.SIM_NO_CDP !== '1') startCdpThrottle();

logInfo(`http: http://${HOST}:${HTTP_PORT}/  (faceplate at /__emulator__/)`);
logInfo(`panel talks to ${SERVICE_WS_URL}`);

function shutdown() {
  if (OWNS_PID_FILE) try { fs.unlinkSync(PID_FILE); } catch {}
  httpServer.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
