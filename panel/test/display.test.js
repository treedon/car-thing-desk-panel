import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisplay } from '../src/display.js';

const MIN = 60000;
const ON = { display: 'on', sleeping: false };
const OFF = { display: 'off', sleeping: false };
const REC = 'http://127.0.0.1:8095';

function flush() {
  return new Promise(function (r) { setImmediate(r); });
}

async function settle() {
  for (let i = 0; i < 5; i++) await flush();
}

// A display with a fake clock, fake timers, a fake overlay and a fake
// recorder. log records overlay calls and fetches in the order they happened.
// light is the room reading GET /light returns; mode 'ok', 'reject' or 'hang'.
function make(opts) {
  opts = opts || {};
  const clock = { t: 1000000 };
  const timers = [];
  const log = [];
  const calls = [];
  const env = { light: opts.light || 1500, mode: opts.mode || 'ok', lightMode: 'ok' };
  const overlay = {
    on: false,
    show() { overlay.on = true; log.push('show'); },
    hide() { overlay.on = false; log.push('hide'); },
  };
  function fetchImpl(url, init) {
    const method = (init && init.method) || 'GET';
    const path = url.slice(REC.length);
    calls.push({ method, path });
    log.push(method + ' ' + path);
    if (env.mode === 'reject') return Promise.reject(new Error('ECONNREFUSED'));
    if (path === '/light') {
      if (env.lightMode === 'hang') return new Promise(function () {});
      const ch0 = env.light;
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ch0: ch0, ch1: 0 }); } });
    }
    return Promise.resolve({ ok: true, status: 204 });
  }
  function setTimer(fn, ms) { timers.push({ at: clock.t + ms, fn }); }
  function runTimers() {
    for (;;) {
      timers.sort(function (a, b) { return a.at - b.at; });
      if (!timers.length || timers[0].at > clock.t) return;
      timers.shift().fn();
    }
  }
  const d = createDisplay({
    recorder: opts.recorder === undefined ? REC : opts.recorder,
    fetchImpl,
    now: function () { return clock.t; },
    setTimer,
    overlay,
  });
  // Advance the clock by ms, firing timers on the way, without ticking.
  async function advance(ms) {
    const end = clock.t + ms;
    while (clock.t < end) {
      clock.t = Math.min(end, clock.t + 50);
      runTimers();
      await settle();
    }
  }
  // Run seconds of the main.js 1 s tick.
  async function run(seconds) {
    for (let i = 0; i < seconds; i++) {
      await advance(1000);
      d.tick();
      await settle();
    }
  }
  function posts() {
    return calls.filter(function (c) { return c.method === 'POST'; }).map(function (c) {
      return Number(/permille=(\d+)/.exec(c.path)[1]);
    });
  }
  return { d, clock, overlay, log, calls, env, advance, run, posts };
}

// A display whose link to the Mac is up, with the Mac in the given state.
async function lit(opts, state) {
  const h = make(opts);
  h.d.linkUp();
  h.d.macPower(state || ON);
  await settle();
  return h;
}

async function dark(opts) {
  const h = await lit(opts, ON);
  h.d.macPower(OFF);
  await h.advance(1500);
  assert.equal(h.overlay.on, true, 'precondition: the screen is dark');
  return h;
}

test("gate('dial','knob') while lit → true; while dark → false, and the screen is then lit", async () => {
  const a = await lit({}, ON);
  assert.equal(a.d.gate('dial', 'knob'), true);

  const b = await dark({});
  assert.equal(b.d.gate('dial', 'knob'), false, 'the waking turn is swallowed');
  await b.advance(400);
  assert.equal(b.overlay.on, false, 'the screen is lit');
});

test("gate('preset','key') and gate('tap','touch') while dark → false and the screen stays dark", async () => {
  const h = await dark({});
  assert.equal(h.d.gate('preset', 'key'), false);
  assert.equal(h.d.gate('tap', 'touch'), false);
  assert.equal(h.d.gate('dial', 'touch'), false, 'a touch drag does not wake it either');
  assert.equal(h.d.gate('back', 'key'), false);
  assert.equal(h.d.gate('m-hold', 'key'), false);
  await h.run(5);
  assert.equal(h.overlay.on, true, 'still dark');
});

test('isLit follows the screen', async () => {
  assert.equal((await lit({}, ON)).d.isLit(), true); assert.equal((await dark({})).d.isLit(), false);
});

test('touch and keys pass while lit', async () => {
  const h = await lit({}, ON);
  assert.equal(h.d.gate('preset', 'key'), true);
  assert.equal(h.d.gate('tap', 'touch'), true);
});

test('going dark shows the overlay, then posts permille=0 after 1 s', async () => {
  const h = await lit({}, ON);
  h.d.macPower(OFF);
  assert.equal(h.overlay.on, true, 'the overlay shows at once, so the fade starts');
  assert.equal(h.posts().indexOf(0), -1, 'the backlight stays on during the fade');
  await h.advance(950);
  assert.equal(h.posts().indexOf(0), -1);
  await h.advance(100);
  assert.notEqual(h.posts().indexOf(0), -1, 'then the backlight goes off');
});

test('a wake during the fade cancels the backlight off', async () => {
  const h = await lit({}, ON);
  h.d.macPower(OFF);
  await h.advance(500);
  h.d.gate('dial', 'knob');
  await h.advance(2000);
  assert.equal(h.overlay.on, false);
  assert.equal(h.posts().indexOf(0), -1, 'the backlight never went off');
});

test('waking posts a non-zero permille before hiding the overlay', async () => {
  const h = await dark({});
  h.log.length = 0;
  h.d.gate('select', 'knob');
  await h.advance(400);
  const hide = h.log.indexOf('hide');
  assert.notEqual(hide, -1, 'the overlay hid');
  const post = h.log.findIndex(function (e) { return /^POST \/backlight\?permille=[1-9]/.test(e); });
  assert.notEqual(post, -1, 'a non-zero backlight was posted');
  assert.ok(post < hide, 'the backlight comes on before the overlay goes');
  const read = h.log.indexOf('GET /light');
  assert.ok(read !== -1 && read < post, 'a fresh light reading is taken first');
});

test('waking in a dark room posts the dark level, not a stale one', async () => {
  const h = await lit({}, ON);
  await h.run(30); // a bright room
  h.d.macPower(OFF);
  await h.advance(1500);
  h.env.light = 10; // the lamp went off while the screen was dark
  await h.advance(10 * MIN);
  h.d.gate('dial', 'knob');
  await h.advance(400);
  const p = h.posts();
  assert.ok(p[p.length - 1] <= 610, 'woke at about the dark level, got ' + p[p.length - 1]);
});

test('a slow light read delays the wake by at most 300 ms', async () => {
  const h = await dark({});
  h.env.lightMode = 'hang';
  h.d.gate('dial', 'knob');
  await h.advance(250);
  await h.advance(100);
  assert.equal(h.overlay.on, false, 'lit within 350 ms with no reading');
  const p = h.posts();
  assert.ok(p[p.length - 1] > 0, 'the backlight came on at the current level');
});

test('an ask while dark wakes the screen; Claude can wake it', async () => {
  const h = await dark({});
  h.d.asks(1);
  await h.advance(400);
  assert.equal(h.overlay.on, false);
});

test('the sensor is read every 2 s while lit and not at all while dark', async () => {
  const h = await lit({}, ON);
  const reads = function () { return h.calls.filter(function (c) { return c.path === '/light'; }).length; };
  const before = reads();
  await h.run(10);
  const litReads = reads() - before;
  assert.ok(litReads >= 4 && litReads <= 6, '10 s lit → about 5 reads, got ' + litReads);
  h.d.macPower(OFF);
  await h.advance(1500);
  const darkStart = reads();
  await h.run(20);
  assert.equal(reads(), darkStart, 'no reads while dark');
});

test('recorder null → no fetch calls; sleep still toggles the overlay', async () => {
  const h = await lit({ recorder: null }, ON);
  await h.run(5);
  h.d.macPower(OFF);
  assert.equal(h.overlay.on, true);
  await h.run(5);
  assert.equal(h.d.gate('dial', 'knob'), false);
  await h.advance(10);
  assert.equal(h.overlay.on, false, 'woke without a recorder');
  await h.run(5);
  assert.equal(h.calls.length, 0);
});

test('fetch rejects → no throw; console.warn at most once over 10 ticks', async () => {
  const warn = console.warn;
  let warned = 0;
  console.warn = function () { warned++; };
  try {
    const h = await lit({ mode: 'reject' }, ON);
    await h.run(10);
    h.d.macPower(OFF);
    await h.run(3);
    assert.equal(h.overlay.on, true, 'the overlay alone darkens it');
    h.d.gate('dial', 'knob');
    await h.run(10);
    assert.equal(h.overlay.on, false, 'and the knob still wakes it');
    assert.ok(h.calls.length > 5, 'it kept retrying the sensor');
    assert.ok(warned <= 1, 'warned ' + warned + ' times');
  } finally {
    console.warn = warn;
  }
});

test('light reading 10 for a long time → a POST with permille 600', async () => {
  const h = await lit({ light: 10 }, ON);
  await h.run(120);
  assert.notEqual(h.posts().indexOf(600), -1, 'posts ' + h.posts().join(','));
});

test('a room going dark steps the backlight down to about the dark level', async () => {
  const h = await lit({}, ON);
  await h.run(30); // a lit room first
  h.env.light = 10;
  await h.run(120);
  const p = h.posts();
  assert.ok(p.length >= 3, 'stepped down gradually: ' + p.join(','));
  assert.ok(p[p.length - 1] < 630, 'ended within a step of 600: ' + p.join(','));
});

// Wiring choice: after the link drops, the Mac's last state and the store's
// ask count are stale. A link up (daemonAlive) is not enough to trust them
// again; only a fresh claude.mac.power is, and the service sends it right
// after claude.queue.sync on every hello, so the asks are reconciled first.
test('a lost link does not light the screen from a stale Mac state or ask count', async () => {
  const h = await lit({}, ON);
  h.d.asks(0);
  h.d.linkDown();
  await h.run(3 * 60);
  assert.equal(h.overlay.on, true, 'dark 2 min after the link went down');

  h.d.asks(2);                 // the store still holds asks from before
  h.d.linkUp();                // some frame arrived: daemonAlive
  await h.run(3);
  assert.equal(h.overlay.on, true, 'not lit by the stale "display on" nor stale asks');

  h.d.asks(0);                 // claude.queue.sync drops the stale asks
  h.d.macPower(OFF);           // then the fresh state: the Mac display is off
  await h.run(3);
  assert.equal(h.overlay.on, true, 'still dark: the Mac is dark and nothing waits');
  await h.run(60);
  assert.equal(h.overlay.on, true, 'and the sync did not start a 10-minute wake');

  h.d.macPower(ON);
  await h.advance(400);
  assert.equal(h.overlay.on, false, 'a fresh "display on" lights it');
});

test('a short link blip with the Mac display on does not blank the screen', async () => {
  const h = await lit({}, ON);
  h.d.linkDown();
  await h.run(30);
  assert.equal(h.overlay.on, false, 'lit during the grace');
  h.d.linkUp();
  h.d.asks(0);
  h.d.macPower(ON);
  await h.run(5 * 60);
  assert.equal(h.overlay.on, false, 'still lit after the link came back');
});
