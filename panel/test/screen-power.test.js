import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScreenPower } from '../src/screen-power.js';

const MIN = 60000;
const ON = { display: 'on', sleeping: false };
const OFF = { display: 'off', sleeping: false };

// A screen-power with a fake clock and a healthy link to the Mac.
function make(state) {
  const clock = { t: 1000000 };
  const p = createScreenPower({ now: () => clock.t });
  p.linkUp();
  p.macPower(state || ON);
  return { p, clock };
}

test('mac display on, link up → on', () => {
  const { p, clock } = make(ON);
  assert.equal(p.isOn(), true);
  clock.t += 60 * MIN;
  assert.equal(p.isOn(), true, 'no timers apply while the Mac display is on');
});

test('display off → off at once when no knob within 10 min and no asks', () => {
  const { p, clock } = make(ON);
  clock.t += 30 * MIN;
  p.macPower(OFF);
  assert.equal(p.isOn(), false);
});

test('knob while dark → knob() returns true and isOn() becomes true', () => {
  const { p } = make(OFF);
  assert.equal(p.isOn(), false);
  assert.equal(p.knob(), true, 'the waking input is swallowed');
  assert.equal(p.isOn(), true);
});

test('knob ticks 499 ms after a wake are swallowed, at 501 ms they are not', () => {
  const a = make(OFF);
  assert.equal(a.p.knob(), true);
  a.clock.t += 499;
  assert.equal(a.p.knob(), true, '499 ms: still a swallowed tick');
  assert.equal(a.p.isOn(), true);

  const b = make(OFF);
  assert.equal(b.p.knob(), true);
  b.clock.t += 501;
  assert.equal(b.p.knob(), false, '501 ms: a real input');
});

test('knob wake: still on at 599999 ms, off at 600001 ms after the last knob', () => {
  const { p, clock } = make(OFF);
  p.knob();
  clock.t += 599999;
  assert.equal(p.isOn(), true);
  clock.t += 2;
  assert.equal(p.isOn(), false);
});

test('each knob input restarts the 10 minutes', () => {
  const { p, clock } = make(OFF);
  p.knob();
  clock.t += 9 * MIN;
  assert.equal(p.knob(), false, 'screen is lit: not swallowed');
  clock.t += 9 * MIN;
  assert.equal(p.isOn(), true, '18 min after the first knob, 9 after the second');
  clock.t += MIN - 1;
  assert.equal(p.isOn(), true);
  clock.t += 2;
  assert.equal(p.isOn(), false, '10 min after the second knob');
});

test('ask arrives while display off → on; stays on 30 min later while still waiting', () => {
  const { p, clock } = make(OFF);
  assert.equal(p.isOn(), false);
  p.asks(1);
  assert.equal(p.isOn(), true);
  clock.t += 30 * MIN;
  assert.equal(p.isOn(), true);
});

test('ask resolves (asks(0)) → off 10 min after resolution, not after arrival', () => {
  const { p, clock } = make(OFF);
  p.asks(1);
  clock.t += 30 * MIN;
  p.asks(0);
  assert.equal(p.isOn(), true, 'lit at the moment of resolution');
  clock.t += 599999;
  assert.equal(p.isOn(), true);
  clock.t += 2;
  assert.equal(p.isOn(), false);
});

test('the 10 minutes start only when the last waiting ask resolves', () => {
  const { p, clock } = make(OFF);
  p.asks(1);
  p.asks(2);
  clock.t += 5 * MIN;
  p.asks(1);
  clock.t += 20 * MIN;
  assert.equal(p.isOn(), true, 'one ask is still waiting');
  p.asks(0);
  clock.t += 599999;
  assert.equal(p.isOn(), true);
  clock.t += 2;
  assert.equal(p.isOn(), false);
});

test('display goes off within 10 min of a knob input → stays on until those 10 min pass', () => {
  const { p, clock } = make(ON);
  clock.t += 20 * MIN;
  assert.equal(p.knob(), false, 'screen was lit, so nothing is swallowed');
  clock.t += 5 * MIN;
  p.macPower(OFF);
  assert.equal(p.isOn(), true, 'the knob input 5 min ago keeps it on');
  clock.t += 5 * MIN - 1;
  assert.equal(p.isOn(), true);
  clock.t += 2;
  assert.equal(p.isOn(), false);
});

test('link down with an ask waiting → still on at 119 s, off at 121 s', () => {
  const { p, clock } = make(OFF);
  p.asks(1);
  assert.equal(p.isOn(), true);
  p.linkDown();
  clock.t += 119000;
  assert.equal(p.isOn(), true, 'inside the grace period');
  clock.t += 2000;
  assert.equal(p.isOn(), false, 'asks are ignored once the grace period is over');
});

test('link down past grace, then knob → on for 10 min, then off', () => {
  const { p, clock } = make(ON);
  p.linkDown();
  clock.t += 121000;
  assert.equal(p.isOn(), false, 'the display is on but the link has been gone too long');
  assert.equal(p.knob(), true);
  assert.equal(p.isOn(), true);
  clock.t += 599999;
  assert.equal(p.isOn(), true);
  clock.t += 2;
  assert.equal(p.isOn(), false);
});

test('boot with no Mac state → on, off at 121 s if the link never comes up', () => {
  const clock = { t: 5000 };
  const p = createScreenPower({ now: () => clock.t });
  assert.equal(p.isOn(), true);
  clock.t += 119000;
  assert.equal(p.isOn(), true);
  clock.t += 2000;
  assert.equal(p.isOn(), false);
});

test('sleeping:true with display on → treated as off', () => {
  const { p } = make({ display: 'on', sleeping: true });
  assert.equal(p.isOn(), false);
  assert.equal(p.knob(), true);
  assert.equal(p.isOn(), true);
});

// Controller ruling R3: the swallow window follows a knob wake only.

test('an ask lit the screen: a knob input right after it is not swallowed', () => {
  const { p, clock } = make(OFF);
  p.asks(1);
  clock.t += 100;
  assert.equal(p.knob(), false);
  clock.t += 100;
  assert.equal(p.knob(), false);
});

test('the Mac display came on: a knob input right after it is not swallowed', () => {
  const { p, clock } = make(OFF);
  assert.equal(p.isOn(), false);
  p.macPower(ON);
  clock.t += 100;
  assert.equal(p.knob(), false);
});

test('a knob wake long ago does not swallow a later ask-woken knob input', () => {
  const { p, clock } = make(OFF);
  assert.equal(p.knob(), true);
  clock.t += 11 * MIN;
  assert.equal(p.isOn(), false);
  p.asks(1);
  clock.t += 100;
  assert.equal(p.knob(), false);
});

test('a second knob wake starts its own swallow window', () => {
  const { p, clock } = make(OFF);
  assert.equal(p.knob(), true);
  clock.t += 11 * MIN;
  assert.equal(p.knob(), true, 'dark again: swallowed');
  clock.t += 499;
  assert.equal(p.knob(), true);
  clock.t += 2;
  assert.equal(p.knob(), false);
});

test('a knob input on a lit screen with no recent wake is not swallowed', () => {
  const { p, clock } = make(ON);
  clock.t += 100;
  assert.equal(p.knob(), false);
});

// Smaller rules.

test('an ask count that drops but stays above zero does not start the 10 minutes', () => {
  const { p, clock } = make(OFF);
  p.asks(2);
  clock.t += 15 * MIN;
  p.asks(1);
  clock.t += 15 * MIN;
  assert.equal(p.isOn(), true);
});

test('asks(0) when nothing was waiting does not light a dark screen', () => {
  const { p } = make(OFF);
  p.asks(0);
  assert.equal(p.isOn(), false);
});

test('an ask answered while the Mac display is on does not hold the screen lit once the display goes off', () => {
  const { p, clock } = make(ON);
  p.asks(1);
  clock.t += MIN;
  p.asks(0);
  clock.t += MIN;
  p.macPower(OFF);
  assert.equal(p.isOn(), false, 'dark at once: no knob, no waiting ask');
});

test('an ask still waiting when the display goes off holds the screen, then 10 min from its resolution', () => {
  const { p, clock } = make(ON);
  p.asks(1);
  clock.t += MIN;
  p.macPower(OFF);
  assert.equal(p.isOn(), true, 'the ask is still waiting');
  clock.t += 30 * MIN;
  p.asks(0);
  assert.equal(p.isOn(), true);
  clock.t += 599999;
  assert.equal(p.isOn(), true);
  clock.t += 2;
  assert.equal(p.isOn(), false);
});

test('an ask answered while the Mac is asleep starts the 10 minutes', () => {
  const { p, clock } = make({ display: 'on', sleeping: true });
  p.asks(1);
  clock.t += MIN;
  p.asks(0);
  clock.t += 599999;
  assert.equal(p.isOn(), true);
  clock.t += 2;
  assert.equal(p.isOn(), false);
});

test('a stale ask dropped on reconnect does not wake a dark screen', () => {
  // The path: the Mac slept mid-ask, the link was lost past grace, and on
  // reconnect claude.queue.sync drops the stale ask. Nobody touched anything.
  const { p, clock } = make(OFF);
  p.asks(1);
  p.linkDown();
  clock.t += 121000;
  assert.equal(p.isOn(), false);
  p.asks(0);
  assert.equal(p.isOn(), false, 'still ignored while the link is lost');
  p.linkUp();
  assert.equal(p.isOn(), false, 'the link coming back is not a wake');
  clock.t += 599999;
  assert.equal(p.isOn(), false);
});

test('an ask that shows as waiting after the link returns, then resolves, is lit for 10 min from that resolution', () => {
  const { p, clock } = make(OFF);
  p.asks(1);
  p.linkDown();
  clock.t += 121000;
  assert.equal(p.isOn(), false);
  p.linkUp();
  assert.equal(p.isOn(), true, 'the ask still shows as waiting and the link is back');
  clock.t += 30 * MIN;
  p.asks(0);
  assert.equal(p.isOn(), true);
  clock.t += 599999;
  assert.equal(p.isOn(), true);
  clock.t += 2;
  assert.equal(p.isOn(), false);
});

test('a resolution recorded before the Mac woke does not hold the screen lit after the display goes off again', () => {
  const { p, clock } = make(OFF);
  p.asks(1);
  clock.t += MIN;
  p.asks(0);
  assert.equal(p.isOn(), true, 'recorded while the Mac was dark');
  clock.t += MIN;
  p.macPower(ON);
  assert.equal(p.isOn(), true);
  clock.t += MIN;
  p.macPower(OFF);
  assert.equal(p.isOn(), false, 'dark at once: no knob, no waiting ask');
});

test('a repeated dark Mac state does not forget a recorded resolution', () => {
  const { p, clock } = make(OFF);
  p.asks(1);
  p.asks(0);
  clock.t += MIN;
  p.macPower(OFF);
  p.macPower({ display: 'on', sleeping: true });
  assert.equal(p.isOn(), true, 'still inside the 10 minutes');
});

test('an ask resolved inside the link grace with the display on is not recorded', () => {
  const { p, clock } = make(ON);
  p.asks(1);
  p.linkDown();
  clock.t += 60000;
  p.asks(0);
  p.linkUp();
  p.macPower(OFF);
  assert.equal(p.isOn(), false, 'the Mac still counted as active when it resolved');
});

test('a new ask lights a screen that was dark', () => {
  const { p, clock } = make(OFF);
  p.knob();
  clock.t += 11 * MIN;
  assert.equal(p.isOn(), false);
  p.asks(1);
  assert.equal(p.isOn(), true);
});

test('link back up within the grace period leaves the rules unchanged', () => {
  const { p, clock } = make(OFF);
  p.asks(1);
  p.linkDown();
  clock.t += 100000;
  p.linkUp();
  clock.t += 100000;
  assert.equal(p.isOn(), true, 'the gap was reset by the link coming back');
});

test('the grace period counts from the first linkDown, so repeating it changes nothing', () => {
  const { p, clock } = make(OFF);
  p.asks(1);
  p.linkDown();
  clock.t += 100000;
  p.linkDown();
  clock.t += 21000;
  assert.equal(p.isOn(), false, '121 s after the first linkDown');
});

test('repeating linkUp changes nothing', () => {
  const { p, clock } = make(OFF);
  p.asks(1);
  p.linkUp();
  p.linkUp();
  clock.t += 30 * MIN;
  assert.equal(p.isOn(), true);
});

test('link down past grace: a knob input from before the drop still counts for 10 min', () => {
  const { p, clock } = make(OFF);
  p.knob();
  p.linkDown();
  clock.t += 5 * MIN;
  assert.equal(p.isOn(), true);
  clock.t += 5 * MIN;
  assert.equal(p.isOn(), false);
});

test('link down past grace: a resolved ask does not keep the screen lit', () => {
  const { p, clock } = make(OFF);
  p.asks(1);
  p.asks(0);
  p.linkDown();
  clock.t += 121000;
  assert.equal(p.isOn(), false);
});

test('options override the timings', () => {
  const clock = { t: 0 };
  const p = createScreenPower({
    now: () => clock.t, awakeMs: 1000, linkGraceMs: 2000, swallowMs: 50,
  });
  p.linkUp();
  p.macPower(OFF);
  assert.equal(p.knob(), true);
  clock.t += 49;
  assert.equal(p.knob(), true);
  clock.t += 2;
  assert.equal(p.knob(), false);
  clock.t += 1000;
  assert.equal(p.isOn(), false);
  p.macPower(ON);
  p.linkDown();
  clock.t += 1999;
  assert.equal(p.isOn(), true);
  clock.t += 1;
  assert.equal(p.isOn(), false);
});

test('a missing Mac state is ignored', () => {
  const { p } = make(OFF);
  p.macPower(null);
  p.macPower(undefined);
  assert.equal(p.isOn(), false);
});
