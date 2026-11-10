import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMux } from '../src/ws-mux.js';

// Fake links: each answers requests from a table and records what it was asked.
function setup(tables) {
  const links = {};
  const mux = createMux({
    hosts: [{ name: 'mac', url: 'ws://mac' }, { name: 'nucbox', url: 'ws://nuc', label: 'NucBox' }],
    primary: 'mac',
    createLink(url, hooks) {
      const name = url === 'ws://mac' ? 'mac' : 'nucbox';
      const link = {
        ready: false, asked: [], hooks,
        connect() {},
        isReady() { return link.ready; },
        request(method, params) {
          link.asked.push({ method, params });
          if (!link.ready) return Promise.reject(new Error('socket not open'));
          const t = (tables[name] || {})[method];
          if (t instanceof Error) return Promise.reject(t);
          return Promise.resolve(typeof t === 'function' ? t(params) : JSON.parse(JSON.stringify(t === undefined ? {} : t)));
        },
        open() { link.ready = true; hooks.onOpen(); },
        close() { link.ready = false; hooks.onClose(); },
        event(topic, data) { hooks.onFrame({ type: 'event', topic, data }); },
      };
      links[name] = link;
      return link;
    },
  });
  const seen = [];
  for (const t of ['claude.sessions.update', 'claude.queue.sync', 'claude.mac.power', 'claude.permission.request']) {
    mux.on(t, (data, f) => seen.push({ t, data, host: f.host }));
  }
  return { mux, links, seen };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

const MAC = {
  'claude.sessions.list': { sessions: [{ id: 'm1', name: 'Mirror' }], stats: { active: 1, attention: 0 }, serverNowMs: 5, tzOffsetMin: -480 },
  'claude.queue.list': { asks: [{ id: 'a-mac', kind: 'permission', createdTs: 2 }] },
};
const NUC = {
  'claude.sessions.list': { sessions: [{ id: 'n1', name: 'Bridge' }], stats: { active: 2, attention: 1 }, serverNowMs: 999 },
  'claude.queue.list': { asks: [{ id: 'a-nuc', kind: 'question', createdTs: 1 }] },
};

test('the session list and the waiting list come from both machines, NucBox ones tagged', async () => {
  const { mux, links } = setup({ mac: MAC, nucbox: NUC });
  links.mac.open(); links.nucbox.open();
  await tick();
  const snap = await mux.request('claude.sessions.list');
  assert.deepEqual(snap.sessions.map((s) => [s.id, s.machine]), [['m1', undefined], ['n1', 'NucBox']]);
  assert.deepEqual(snap.stats, { active: 3, attention: 1 });
  assert.equal(snap.serverNowMs, 5, "the Mac's clock");
  const q = await mux.request('claude.queue.list');
  assert.deepEqual(q.asks.map((a) => a.id), ['a-nuc', 'a-mac'], 'oldest first');
});

test('requests about a session or an ask go to the machine that has it', async () => {
  const { mux, links } = setup({ mac: MAC, nucbox: NUC });
  links.mac.open(); links.nucbox.open();
  await tick();
  await mux.request('claude.sessions.list');
  await mux.request('claude.queue.list');
  await mux.request('claude.session.messages', { id: 'n1', limit: 40 });
  await mux.request('claude.subagents.list', { sessionId: 'm1' });
  await mux.request('claude.question.answer', { id: 'a-nuc', answers: {} });
  await mux.request('claude.permission.answer', { requestId: 'a-mac', decision: 'allow' });
  await mux.request('claude.usage.get', { slim: 1 });
  const on = (h) => links[h].asked.map((a) => a.method).filter((m) => !/^claude\.(sessions|queue)\.list$/.test(m));
  assert.deepEqual(on('nucbox'), ['claude.session.messages', 'claude.question.answer']);
  assert.deepEqual(on('mac'), ['claude.subagents.list', 'claude.permission.answer', 'claude.usage.get']);
});

test('an ask raised on the NucBox is answered there', async () => {
  const { mux, links, seen } = setup({ mac: MAC, nucbox: NUC });
  links.mac.open(); links.nucbox.open();
  links.nucbox.event('claude.permission.request', { requestId: 'p9', sessionId: 'n1' });
  assert.equal(seen.find((s) => s.t === 'claude.permission.request').data.machine, 'NucBox');
  await mux.request('claude.permission.answer', { requestId: 'p9', decision: 'deny' });
  assert.equal(links.nucbox.asked.at(-1).method, 'claude.permission.answer');
});

test('a card from the NucBox is tagged, and clearing it goes to the NucBox', async () => {
  const { mux, links } = setup({ mac: MAC, nucbox: NUC });
  const cards = [];
  mux.on('claude.card.posted', (data) => cards.push(data));
  links.mac.open(); links.nucbox.open();
  links.nucbox.event('claude.card.posted', { kind: 'card', id: 'card:n1:5', sessionId: 'n1', tag: 'asking' });
  assert.equal(cards[0].machine, 'NucBox');
  await mux.request('claude.card.clear', { id: 'card:n1:5' });
  assert.equal(links.nucbox.asked.at(-1).method, 'claude.card.clear');
  assert.equal(links.mac.asked.filter((a) => a.method === 'claude.card.clear').length, 0);
  links.mac.event('claude.card.posted', { kind: 'card', id: 'card:m1:6', sessionId: 'm1', tag: 'update' });
  assert.equal(cards[1].machine, undefined, "the Mac's own cards carry no machine");
  await mux.request('claude.card.clear', { id: 'card:m1:6' });
  assert.equal(links.mac.asked.at(-1).method, 'claude.card.clear');
});

test('only the Mac speaks for the Mac: its power and its link', async () => {
  const { mux, links, seen } = setup({ mac: MAC, nucbox: NUC });
  let opened = 0; let closed = 0;
  mux.onOpen(() => opened++); mux.onClose(() => closed++);
  links.nucbox.open();
  links.nucbox.event('claude.mac.power', { display: 'off' });
  links.nucbox.close();
  assert.equal(opened, 0); assert.equal(closed, 0);
  assert.equal(seen.filter((s) => s.t === 'claude.mac.power').length, 0);
  links.mac.open(); links.mac.close();
  assert.equal(opened, 1); assert.equal(closed, 1);
});

test('the digest is the Mac\'s: the request goes to the Mac and a NucBox digest event is dropped', async () => {
  const { mux, links } = setup({ mac: { ...MAC, 'claude.digest.get': { cards: [{ sessionId: 'm1' }] } }, nucbox: NUC });
  const from = []; mux.on('claude.digest.update', (d, f) => from.push(f.host));
  links.mac.open(); links.nucbox.open(); await tick();
  assert.deepEqual((await mux.request('claude.digest.get', {})).cards, [{ sessionId: 'm1' }]);
  links.nucbox.event('claude.digest.update', { cards: [] }); links.mac.event('claude.digest.update', { cards: [] });
  assert.deepEqual(from, ['mac']); assert.ok(!links.nucbox.asked.some((a) => /digest/.test(a.method)));
});

test('with only the NucBox up the digest request fails and the NucBox is not asked', async () => {
  const { mux, links } = setup({ mac: MAC, nucbox: NUC }); links.nucbox.open(); await tick();
  await assert.rejects(mux.request('claude.digest.get', {}), /socket not open/);
  assert.ok(!links.nucbox.asked.some((a) => /digest/.test(a.method)));
});

test("the NucBox's sessions and cards arrive with its link and go with it", async () => {
  const { links, seen } = setup({ mac: MAC, nucbox: NUC });
  links.mac.open();
  links.mac.event('claude.sessions.update', MAC['claude.sessions.list']);
  links.nucbox.open();
  await tick(); await tick();
  const last = (t) => seen.filter((s) => s.t === t).at(-1);
  assert.deepEqual(last('claude.sessions.update').data.sessions.map((s) => s.id), ['m1', 'n1']);
  assert.equal(last('claude.sessions.update').host, 'nucbox');
  assert.deepEqual(last('claude.queue.sync').data.asks.map((a) => a.id), ['a-nuc']);
  links.nucbox.close();
  assert.deepEqual(last('claude.sessions.update').data.sessions.map((s) => s.id), ['m1']);
  assert.deepEqual(last('claude.queue.sync').data.asks, []);
});

test('with the Mac away the list call fails as before, but the NucBox sessions still show', async () => {
  const { mux, links, seen } = setup({ mac: MAC, nucbox: NUC });
  links.nucbox.open();
  await tick(); await tick();
  await assert.rejects(mux.request('claude.sessions.list'), /socket not open/);
  const last = seen.filter((s) => s.t === 'claude.sessions.update').at(-1);
  assert.deepEqual(last.data.sessions.map((s) => s.id), ['n1']);
  assert.equal(last.host, 'nucbox');
  const q = await mux.request('claude.queue.list');
  assert.deepEqual(q.asks.map((a) => a.id), ['a-nuc']);
});

test('watching a session tells both machines, and a NucBox that comes back is told again', async () => {
  const { mux, links } = setup({ mac: MAC, nucbox: NUC });
  links.mac.open();
  await mux.request('claude.session.watch', { id: 'n1' });
  links.nucbox.open();
  assert.deepEqual(links.nucbox.asked[0], { method: 'claude.session.watch', params: { id: 'n1' } });
});

test('machines lists the hosts with their readiness, labels as the mux stores them', async () => {
  const { mux, links } = setup({ mac: MAC, nucbox: NUC });
  links.mac.open();
  assert.deepEqual(mux.machines(), [
    { name: 'mac', label: 'mac', ready: true },
    { name: 'nucbox', label: 'NucBox', ready: false },
  ]);
  links.nucbox.open(); links.mac.close();
  assert.deepEqual(mux.machines().map((m) => [m.name, m.ready]), [['mac', false], ['nucbox', true]]);
});

test('starting a session, and the recent projects, go to the named host only', async () => {
  const { mux, links } = setup({
    mac: { ...MAC, 'claude.session.start': { shortId: 'mac-1' }, 'claude.projects.recent': { projects: [{ path: '/m' }] } },
    nucbox: { ...NUC, 'claude.session.start': { shortId: 'nuc-1' }, 'claude.projects.recent': { projects: [{ path: 'C:\\n' }] } },
  });
  links.mac.open(); links.nucbox.open();
  await tick();
  const only = (h, m) => links[h].asked.filter((a) => a.method === m);
  assert.deepEqual(await mux.request('claude.session.start', { host: 'nucbox', path: 'p', prompt: 'x' }), { shortId: 'nuc-1' });
  assert.deepEqual(only('nucbox', 'claude.session.start'), [{ method: 'claude.session.start', params: { path: 'p', prompt: 'x' } }], 'the service gets no host param');
  assert.equal(only('mac', 'claude.session.start').length, 0);
  assert.deepEqual(await mux.request('claude.projects.recent', { host: 'mac' }), { projects: [{ path: '/m' }] });
  assert.equal(only('mac', 'claude.projects.recent').length, 1);
  assert.equal(only('nucbox', 'claude.projects.recent').length, 0);
  assert.deepEqual(await mux.request('claude.projects.recent', { host: 'nucbox' }), { projects: [{ path: 'C:\\n' }] });
});

test("a host that isn't ready rejects not-answering, without asking its link", async () => {
  const { mux, links } = setup({ mac: MAC, nucbox: NUC });
  links.mac.open();
  const before = links.nucbox.asked.length;
  await assert.rejects(mux.request('claude.session.start', { host: 'nucbox', path: 'p', prompt: 'x' }), { message: 'not-answering' });
  await assert.rejects(mux.request('claude.projects.recent', { host: 'nucbox' }), { message: 'not-answering' });
  assert.equal(links.nucbox.asked.length, before);
  links.mac.close();
  await assert.rejects(mux.request('claude.projects.recent', { host: 'mac' }), { message: 'not-answering' });
});

test('an unknown or missing host rejects unknown-host, as a rejected promise', async () => {
  const { mux, links } = setup({ mac: MAC, nucbox: NUC });
  links.mac.open(); links.nucbox.open();
  for (const params of [{ host: 'laptop', path: 'p', prompt: 'x' }, { path: 'p', prompt: 'x' }, { host: 'constructor' }]) {
    let p;
    assert.doesNotThrow(() => { p = mux.request('claude.session.start', params); });
    await assert.rejects(p, { message: 'unknown-host' });
  }
  await assert.rejects(mux.request('claude.projects.recent', { host: 'laptop' }), { message: 'unknown-host' });
  assert.equal(links.mac.asked.filter((a) => /session\.start|projects/.test(a.method)).length, 0);
  assert.equal(links.nucbox.asked.filter((a) => /session\.start|projects/.test(a.method)).length, 0);
});

test("handoff and stop requests follow the session's host", async () => {
  const { mux, links } = setup({ mac: MAC, nucbox: NUC });
  links.mac.open(); links.nucbox.open();
  await tick();
  await mux.request('claude.sessions.list');
  const methods = ['claude.session.handoff', 'claude.session.handoff.cancel', 'claude.session.handoff.now', 'claude.session.stop'];
  for (const m of methods) {
    await mux.request(m, { id: 'n1' });
    await mux.request(m, { id: 'm1' });
  }
  const got = (h) => links[h].asked.filter((a) => methods.includes(a.method));
  assert.deepEqual(got('nucbox'), methods.map((method) => ({ method, params: { id: 'n1' } })));
  assert.deepEqual(got('mac'), methods.map((method) => ({ method, params: { id: 'm1' } })));
});
