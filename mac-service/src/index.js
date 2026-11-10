import fs from 'node:fs';
import { DAEMON_VERSION, PID_FILE, MOCK_SESSIONS, BT_SAFE_SESSION_LIMIT, DIGEST_ENABLED, CLAUDE_PROJECTS_DIR, digestPersists } from './config.js';
import { createHub } from './hub.js';
import { createStore } from './sessions/store.js';
import { createPermissionBridge } from './permission-bridge.js';
import { createQuestionBridge } from './question-bridge.js';
import { createMessageBridge, chooseDelivery } from './message-bridge.js';
import { transcribe, MAX_AUDIO_BYTES } from './dictation.js';
import { createSources } from './sessions/index.js';
import { MOCK_PROJECTS_DIR } from './sessions/source-mock.js';
import { createDigest } from './digest/index.js';
import { emptyDigest } from './digest/card.js';
import { createHttpServer } from './http-server.js';
import { createFocus, detectHost, lookupSession, readProc } from './focus.js';
import { createHostTracker } from './host-tracker.js';
import { isBackgroundSession, isWindowlessBackground, deliveredFields } from './background.js';
import { createHandoff } from './handoff.js';
import { createDesktopOpener } from './desktop-open.js';
import { createStarter, createMockStarter, recentProjects, sessionStartFolder } from './new-session.js';
import { createQueue } from './queue.js';
import { createInbox, inboxStorage } from './inbox.js';
import { createChime, LOUD_TOPICS } from './chime.js';
import { createServicePrefs } from './service-prefs.js';
import { readState, writeState } from './persist.js';
import { promptLine } from './sessions/source-hooks.js';
import { createUsage, slimUsage } from './usage.js';
import { createMacPower } from './mac-power.js';
import { helloEvents } from './hello.js';
import { log } from './log.js';
import { readRecentMessages } from './sessions/recent-messages.js';
import { transcriptFileFor, transcriptCandidates } from './sessions/tails.js';
import { readSubagents, readSubagentFeed, subagentCounts } from './sessions/subagents.js';

// Broadcast the whole waiting list and the Mac's power state whenever a client
// turns up (see hello.js), so a screen that watched the last daemon die stops
// showing asks this one has never heard of, and learns at once if the Mac's
// display is off. Not a response to the new client alone: every screen behind
// the same relay is just as stale, and both are small.
const hub = createHub({
  onHello: () => {
    for (const [topic, data] of helloEvents({ queueSnapshot, macPower })) hub.emit(topic, data);
  },
  // The last panel left (simulator closed, Wi-Fi drop): release every held
  // permission so the Mac's own prompt takes over within the second.
  onClose: () => {
    if (hub.panelOnline()) return;
    permissionBridge.releaseAll('panel-gone');
    questionBridge.releaseAll('panel-gone');
  },
});
const store = createStore();
const ON_WINDOWS = process.platform === 'win32';
// The NucBox's service has no desktop to open VS Code on; its opener asks a helper in the owner's
// session (see desktop-open.js). The Mac and the demo have no use for one.
const opener = ON_WINDOWS && !MOCK_SESSIONS ? createDesktopOpener() : null;
const focus = createFocus({ desktopOpener: opener });

// The folder to open or raise VS Code on for a session: the one it started in, read from its transcript
// (see sessionStartFolder). Its record's cwd moves with it into a git worktree, and opening that starts a
// second window beside the one that hosts the session. Both places its transcript may be are tried (see
// transcriptCandidates); a session with no readable transcript, or whose start folder is gone, gets its
// record's cwd, as before.
const folderFor = (id, raw) => sessionStartFolder(transcriptCandidates(id, raw), raw && raw.cwd);

// The Mac's own chime and its setting. The setting is read on every ring, so
// flipping it from the panel takes effect at once. The NucBox's copy of this
// service (Windows, no afplay) never rings.
const servicePrefs = createServicePrefs({ read: () => readState('prefs'), write: (v) => writeState('prefs', v) });
const chime = createChime({ enabled: () => process.platform !== 'win32' && servicePrefs.get().chime });

// The asks that need the owner chime as they are announced: permissions, held
// questions and plans, upstream questions. Loud inbox cards chime through
// onLoud, since only the inbox knows a card going quiet must stay silent.
const emit = (topic, data) => {
  hub.emit(topic, data);
  if (LOUD_TOPICS.includes(topic)) chime.ring();
};

// One card per session for its latest finished turn. The file holds message
// text, so it is owner-only; demo cards (mock mode) are never written to it.
const inbox = createInbox({
  emit: hub.emit,
  ...inboxStorage({ mock: MOCK_SESSIONS, readState, writeState }),
  onLoud: () => chime.ring(),
});

const queue = createQueue({ emit, store, focus, folderFor });
const macPower = createMacPower({ onChange: (state) => hub.emit('claude.mac.power', state) });
// Starting a background session from the panel (see new-session.js). Demo mode starts nothing real.
const starter = MOCK_SESSIONS
  ? createMockStarter({ store })
  : createStarter({ recent: () => recentProjects({ projectsDir: CLAUDE_PROJECTS_DIR }) });
// A background session with no window: nothing to hand an ask back to, so both
// bridges hold it for the panel instead. That includes one this service just started,
// until the poller has tagged its kind (see isBackgroundSession).
const isBackground = (id) => isBackgroundSession(store.raw(id), starter.started, id);
const permissionBridge = createPermissionBridge({ emit, store, queue, panelOnline: hub.panelOnline, isBackground });
const questionBridge = createQuestionBridge({ emit, panelOnline: hub.panelOnline, store, isBackground });
// A reply from the panel starts the next turn, so what the owner said there is
// that turn's intent line; a wake also marks a background session's turn as running
// (see deliveredFields). The listener must stay synchronous: the bridge's
// try/catch only guards a synchronous throw.
const messageBridge = createMessageBridge({
  emit: hub.emit,
  onDelivered: (id, text, via) => store.touch(id, deliveredFields(store.raw(id), via, promptLine(text))),
});
const usage = createUsage({ emit: hub.emit });
// What the last day of sessions did, read from their transcripts (see digest/index.js). Off with
// CLAUDE_PANEL_DIGEST=0, and always on Windows (see digestEnabled in config.js): then there is no digest
// at all, no timers and no files. A card is live when the session is in the store.
const digest = DIGEST_ENABLED
  ? createDigest({
    emit: hub.emit,
    projectsDir: MOCK_SESSIONS ? MOCK_PROJECTS_DIR : CLAUDE_PROJECTS_DIR,
    isLive: (id) => !!store.raw(id),
    // The demo keeps its digest in memory unless CLAUDE_THING_STATE_DIR gives it a folder of its own.
    persist: digestPersists(process.env, MOCK_SESSIONS),
  })
  : null;
// In demo mode a churn stop is heard as a real Stop would be. A real hook reaching a demo service is
// ignored by the digest: its transcript is outside MOCK_PROJECTS_DIR.
const sources = createSources({
  store, permissionBridge, queue, inbox,
  onMockStop: (id, file) => digest && digest.onHook('Stop', { session_id: id, transcript_path: file }),
});

// Everything waiting on the owner: asks, plus a card per finished turn.
function queueSnapshot() {
  return {
    asks: [
      ...permissionBridge.list(), ...questionBridge.list(), ...queue.list(), ...inbox.list(),
    ].sort((a, b) => a.createdTs - b.createdTs),
  };
}

store.onSnapshot = (snap) => hub.emit('claude.sessions.update', snap);
store.onDetail = (detail) => hub.emit('claude.session.update', detail);

// Claude Code keeps a session's subagents beside its transcript:
// <transcript without .jsonl>/subagents/.
function sessionDirFor(id) {
  const file = id && transcriptFileFor(id, store.raw(id));
  return file ? file.replace(/\.jsonl$/, '') : null;
}

// Which app hosts each session (VS Code or a terminal), found asynchronously.
// On Windows (the NucBox) there is no ps to walk, and Claude Code runs in VS
// Code there, so every session is a VS Code one.
const hosts = createHostTracker({
  store, lookup: lookupSession, detect: ON_WINDOWS ? async () => 'vscode' : (pid) => detectHost(pid, readProc),
});

// Moving a background session into VS Code, and stopping one (see handoff.js). Only a windowless
// background job is ever stopped; a demo session is not a process at all. On the NucBox the move opens
// VS Code through the desktop opener, and it asks first whether that can work (a desktop session to open
// in, and the helper installed), because a stop VS Code cannot follow would strand the session.
const handoff = createHandoff({
  store,
  focus: opener ? { ...focus, openInVsCode: opener.open } : focus,
  canOpen: opener ? opener.check : undefined,
  folderFor,
  // The owner is at the session now, so its card has done its job (as with any SWITCH). Called for
  // every move that ends in VS Code: the press, OPEN NOW, and the Stop hook that fires a waiting one.
  onOpened: (id) => inbox.clear(id, 'switched'),
  isWindowless: (id) => !MOCK_SESSIONS && isWindowlessBackground(store.raw(id)),
  stopAgent: MOCK_SESSIONS ? async () => {} : undefined, // undefined takes the real `claude stop`
});

// Subagent counts for the tile badge. Re-read every SUBAGENT_REFRESH_MS for
// live sessions, written only when they change so a quiet session sends nothing.
const SUBAGENT_REFRESH_MS = 2_000;
setInterval(() => {
  for (const [id, raw] of store.entries()) {
    if (raw.ended) continue;
    hosts.refresh(id);
    const dir = sessionDirFor(id);
    if (!dir) continue;
    const next = subagentCounts(readSubagents(dir, { sessionEnded: false }));
    const prev = raw.subagents || { running: 0, finished: 0 };
    if (next.running !== prev.running || next.finished !== prev.finished) store.upsert(id, { subagents: next });
  }
}, SUBAGENT_REFRESH_MS).unref();

// A loud card goes quiet and an ended session's UPDATE card expires on this
// clock; the inbox has no timer of its own. Both timers are unref'd, so
// shutdown has nothing to stop.
const INBOX_TICK_MS = 15_000;
setInterval(inbox.tick, INBOX_TICK_MS).unref();

// Cards outlive the daemon, sessions do not. A minute after boot the sources
// have had time to find the live sessions; a card whose session is not among
// them will never get a SessionEnd, so it is treated as ended now.
const INBOX_RETIRE_AFTER_MS = 60_000;
setTimeout(
  () => inbox.retireMissing(new Set([...store.entries()].map(([id]) => id))),
  INBOX_RETIRE_AFTER_MS,
).unref();

hub.setMethods({
  'claude.ping': async () => ({ daemonVersion: DAEMON_VERSION, sessions: store.count() }),
  // Relay roles sit behind the Bluetooth link, whose synchronous responses
  // cannot span chunks — an uncapped list past ~6 sessions simply never
  // arrives there. Cap those roles even when the client forgot to ask, and
  // follow up with the full grid as an async push (those chunk fine) so the
  // screen fills in seconds instead of waiting out the snapshot heartbeat.
  'claude.sessions.list': async ({ limit } = {}, { role }) => {
    const cap = limit || ((role === 'connector' || role === 'emulator') ? BT_SAFE_SESSION_LIMIT : 0);
    const snap = store.snapshot(cap);
    if (cap > 0 && store.count() > snap.sessions.length) {
      setTimeout(() => hub.emit('claude.sessions.update', store.snapshot()), 0);
    }
    return snap;
  },
  'claude.session.get': async ({ id }) => {
    const d = store.get(id);
    if (!d) throw new Error('unknown session');
    return d;
  },
  // The recent conversation, for the panel's session view: what was said, with
  // no tool lines or background-task notices. An unknown file reads as an empty
  // conversation rather than an error.
  'claude.session.messages': async ({ id, limit } = {}) => {
    const file = transcriptFileFor(id, store.raw(id));
    return { messages: file ? readRecentMessages(file, { limit: limit || 40, conversationOnly: true }) : [] };
  },
  'claude.subagents.list': async ({ sessionId } = {}) => {
    const dir = sessionDirFor(sessionId);
    const raw = store.raw(sessionId);
    return { subagents: dir ? readSubagents(dir, { sessionEnded: !!(raw && raw.ended) }) : [] };
  },
  'claude.subagent.feed': async ({ sessionId, agentId } = {}) => {
    const dir = sessionDirFor(sessionId);
    if (!dir || !agentId) return { steps: [], report: null };
    return readSubagentFeed(dir, String(agentId).replace(/[^a-zA-Z0-9_-]/g, ''), 20);
  },
  'claude.permission.answer': async ({ requestId, decision }) => ({
    accepted: permissionBridge.answer(requestId, decision),
  }),

  // everything waiting on a human, for clients that connect mid-flight
  'claude.queue.list': async () => queueSnapshot(),
  // CLEAR from the panel: the card goes with no other effect. False when it is
  // already gone (replaced, or the session switched).
  'claude.card.clear': async ({ id } = {}) => ({ ok: inbox.clearById(id, 'cleared') }),
  // The Mac's own settings: {chime} is whether it plays a sound when a session
  // needs the owner. Anything but a boolean in a patch is ignored.
  'claude.prefs.get': async () => servicePrefs.get(),
  'claude.prefs.set': async (patch = {}) => servicePrefs.set(patch),
  // answers is number[][] — one entry per question of the ask, each the option
  // indices chosen for it. optionIndex is the pre-grouping single-question form.
  'claude.question.answer': async ({ id, answers, optionIndex }) =>
    queue.answerQuestion(id, answers ?? optionIndex),

  // Bring a session's terminal window to the front, as if it were clicked.
  // Through the same lock as answering: a raise landing between an answer's
  // focus and its keystrokes would send them to the window it just raised.
  // A question or plan held by the PreToolUse hook. answer: {kind:'choice',
  // answers:{[questionText]: label}} | {kind:'approve'} | {kind:'feedback', text}
  // | {kind:'vscode'}. False when the prompt is already gone.
  'claude.prompt.answer': async ({ id, answer } = {}) => ({ accepted: questionBridge.answer(id, answer) }),

  // Hold-to-talk from the panel: {audioBase64, mime} -> {text}. Errors:
  // 'too-long' (over 30 s or 2 MB), 'dictation-not-set-up', 'transcription-failed'.
  'claude.dictation.transcribe': async ({ audioBase64, mime } = {}) => {
    const b64 = String(audioBase64 || '');
    if (b64.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4) throw new Error('too-long');
    return { text: await transcribe(Buffer.from(b64, 'base64'), String(mime || '')) };
  },

  // A message dictated on the panel. A question or plan the session is asking
  // takes it as the answer (plan: feedback); a working session gets it at its
  // next tool call; an idle one is woken by the Stop hook's rewake poller.
  'claude.session.send': async ({ id, text } = {}) => {
    const body = String(text || '').trim();
    if (!id || !body) throw new Error('empty-message');
    const held = questionBridge.list().find((p) => p.sessionId === id);
    const raw = store.raw(id);
    const detail = store.get(id);
    const working = !!(raw && raw.thinking) || !!(detail && detail.state === 'busy');
    const delivery = chooseDelivery({
      known: !!raw, promptHeld: !!held, promptParts: held && held.questions ? held.questions.length : 1,
      working, pollerWaiting: messageBridge.hasWaiter(id),
    });
    if (delivery === 'unknown-session' || delivery === 'answer-on-panel') return { delivery };
    if (delivery === 'answer') {
      const answer = held.tool === 'ExitPlanMode'
        ? { kind: 'feedback', text: body }
        : { kind: 'choice', answers: { [held.questions[0].question]: body } };
      if (questionBridge.answer(held.id, answer)) hub.emit('claude.message.delivered', { sessionId: id, via: 'answer' });
    } else if (delivery !== 'cannot-wake') {
      messageBridge.send(id, body);
    }
    // The owner has replied, so the card for that session has been dealt with.
    // A cannot-wake reply went nowhere: the card stays, with SWITCH as the way on.
    if (delivery === 'wake' || delivery === 'next-tool' || delivery === 'answer') inbox.clear(id, 'replied');
    return { delivery };
  },

  // The five most recent projects, newest first: [{name, path, lastUsed, trusted}]. The panel offers
  // these and nothing else (see new-session.js).
  'claude.projects.recent': async () => ({ projects: await starter.recent() }),
  // Start a background session in one of those projects: {path, prompt} -> {shortId}. Errors, as
  // the message: 'empty-prompt', 'prompt-too-long', 'not-a-recent-project', 'not-trusted'
  // (Claude Code has not been told to trust the folder), 'start-failed' (nothing started) and
  // 'start-unconfirmed' (it may have: exit 0 with no job id, or killed / timed out).
  'claude.session.start': async ({ path, prompt } = {}) => starter.start({ path, prompt }),

  'claude.session.focus': async ({ id }) => {
    const raw = store.raw(id) || {};
    const result = await focus.exclusive(() => focus.focusSession(id, { host: raw.host, cwd: folderFor(id, raw), kind: raw.kind }));
    // SWITCH: the owner is at the session now, so its card has done its job.
    if (result && result.focused) inbox.clear(id, 'switched');
    return result;
  },

  // The session view's "Open in VS Code" row, for the panel that knows a session is a background one.
  // A windowless background job is stopped and opened in VS Code once its turn has ended; any other
  // session is just raised. {id} -> {result: 'opened' | 'waiting' | 'raised' | 'cancelled' | 'failed',
  // reason?}. 'cancelled': a STOP or a cancel landed while the press waited on the desktop check, so it did
  // nothing. Reasons: 'unknown-session', 'not-background', 'stop-failed', 'stop-timeout', 'open-failed',
  // or the reason a window could not be raised. On the NucBox also 'no-desktop' and 'not-set-up': nothing
  // was stopped.
  'claude.session.handoff': async ({ id } = {}) => {
    const out = await handoff.request(id);
    // A raise is a SWITCH, as in claude.session.focus. (A move clears its card itself: onOpened.)
    if (out.result === 'raised') inbox.clear(id, 'switched');
    return out;
  },
  // The same row pressed while waiting: stop waiting. Always {result: 'cancelled'}.
  'claude.session.handoff.cancel': async ({ id } = {}) => handoff.cancel(id),
  // OPEN NOW: stop the agent and open it in VS Code at once, with "Continue where you left off."
  // typed (not sent) into the session. {result: 'opened' | 'failed', reason?}.
  'claude.session.handoff.now': async ({ id } = {}) => handoff.now(id),
  // The STOP row: end the background agent. {result: 'stopped' | 'failed', reason?}.
  'claude.session.stop': async ({ id } = {}) => handoff.stop(id),

  // {slim} returns the device-rendered subset — see slimUsage() — so the
  // synchronous boot response stays well inside one Bluetooth chunk.
  'claude.usage.get': async ({ slim } = {}) => (slim ? slimUsage(usage.get()) : usage.get()),

  // The whole digest, for a panel that just connected; updates follow as claude.digest.update. Rebuilt
  // on each call (about a millisecond), which is fine at once per connect. With the digest off, the
  // empty one: no cards, summarizer off.
  'claude.digest.get': async () => (digest ? digest.get() : emptyDigest(Date.now())),
});

let server;
try {
  server = await createHttpServer({ hub, store, permissionBridge, sources, questionBridge, messageBridge, digest, handoff });
} catch (err) {
  console.error(`daemon startup failed: ${err.message}`);
  process.exit(1);
}

// Usage is the account's, read once on the Mac; the display and sleep watcher
// is a Mac helper. The NucBox's copy of this service does neither, and the
// panel takes both from the Mac only.
if (!ON_WINDOWS) {
  usage.start();
  macPower.start();
}
// The digest's catch-up scan reads the last day's transcripts. It runs in the background, after the
// server is listening and never awaited, so hooks are answered from the first moment.
if (digest) {
  digest.start().catch((err) => log('DG', `start failed: ${(err && (err.code || err.name)) || 'error'}`));
}
fs.writeFileSync(PID_FILE, String(process.pid));
log('--', `claude-thing daemon v${DAEMON_VERSION} (${MOCK_SESSIONS ? 'MOCK sessions' : 'real sources'})`);

function shutdown() {
  try { fs.unlinkSync(PID_FILE); } catch {}
  // First, and contained: the state file is written at most every 10 s, so this is what saves the rest.
  try { if (digest) digest.stop(); } catch {}
  usage.stop();
  macPower.stop();
  sources.stop();
  server.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
