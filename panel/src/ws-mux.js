// Two session services as one (see ws.js). Pure: it takes createLink(url,
// hooks) -> {connect, request, isReady} and the host list, so the tests drive
// it with fake links.
//
// hosts: [{name, url, label?}], primary first. Sessions and asks from a host
// other than the primary are tagged machine: its label.

// Events only the Mac's link may bring. The digest is the Mac's: a NucBox
// running the same service would otherwise replace it with its own.
var PRIMARY_ONLY = {
  'claude.mac.power': 1, 'claude.usage.update': 1, 'claude.daemon.status': 1, 'claude.digest.update': 1,
};
// Requests about one session: which param names it.
var BY_SESSION = {
  'claude.session.get': 'id', 'claude.session.messages': 'id', 'claude.session.send': 'id',
  'claude.session.focus': 'id', 'claude.subagents.list': 'sessionId', 'claude.subagent.feed': 'sessionId',
  'claude.session.handoff': 'id', 'claude.session.handoff.cancel': 'id', 'claude.session.handoff.now': 'id',
  'claude.session.stop': 'id',
};
// Requests the panel sends to a machine it chose: params.host names it.
var BY_HOST = { 'claude.projects.recent': 1, 'claude.session.start': 1 };
// Requests about one ask.
var BY_ASK = {
  'claude.permission.answer': 'requestId', 'claude.question.answer': 'id', 'claude.prompt.answer': 'id',
  'claude.card.clear': 'id',
};
// Events that bring an ask, and where its id is.
var ASK_EVENTS = {
  'claude.permission.request': 'requestId', 'claude.question.request': 'id', 'claude.prompt.created': 'id',
  'claude.card.posted': 'id',
};

export function createMux(opts) {
  var hosts = opts.hosts;
  var primary = opts.primary || hosts[0].name;
  var links = {};
  var per = {};          // host -> {snap, asks}
  var label = {};
  var sessionHost = {};  // session id -> host
  var askHost = {};      // ask id -> host
  var topicListeners = {};
  var openListeners = [];
  var closeListeners = [];
  var lastWatch = null;

  function emit(topic, data, host) {
    var fns = topicListeners[topic] || [];
    var frame = { type: 'event', topic: topic, data: data, host: host };
    for (var i = 0; i < fns.length; i++) fns[i](data, frame);
  }

  function tag(obj, host) {
    if (obj && typeof obj === 'object' && host !== primary && label[host]) obj.machine = label[host];
    return obj;
  }

  function tagAsks(list, host) {
    var out = list || [];
    for (var i = 0; i < out.length; i++) {
      tag(out[i], host);
      if (out[i] && out[i].id) askHost[out[i].id] = host;
    }
    return out;
  }

  function setSnap(host, snap) {
    if (!snap) return;
    var list = snap.sessions || [];
    for (var i = 0; i < list.length; i++) { tag(list[i], host); sessionHost[list[i].id] = host; }
    per[host].snap = snap;
  }

  function mergedSnap() {
    var base = per[primary].snap || null;
    var out = {};
    var src = base;
    if (!src) for (var h = 0; h < hosts.length && !src; h++) src = per[hosts[h].name].snap;
    for (var k in (src || {})) out[k] = src[k];
    var sessions = [];
    var stats = null;
    for (var i = 0; i < hosts.length; i++) {
      var s = per[hosts[i].name].snap;
      if (!s) continue;
      sessions = sessions.concat(s.sessions || []);
      if (s.stats) {
        stats = stats || {};
        for (var n in s.stats) if (typeof s.stats[n] === 'number') stats[n] = (stats[n] || 0) + s.stats[n];
      }
    }
    out.sessions = sessions;
    if (stats) out.stats = stats;
    return out;
  }

  function mergedAsks() {
    var all = [];
    for (var i = 0; i < hosts.length; i++) all = all.concat(per[hosts[i].name].asks || []);
    all.sort(function (a, b) { return (a.createdTs || 0) - (b.createdTs || 0); });
    return all;
  }

  function onFrame(host, f) {
    var topic = f.topic;
    var data = f.data;
    if (PRIMARY_ONLY[topic] && host !== primary) return;
    if (topic === 'claude.sessions.update') {
      setSnap(host, data);
      return emit(topic, mergedSnap(), host);
    }
    if (topic === 'claude.queue.sync') {
      per[host].asks = tagAsks((data && data.asks) || [], host);
      return emit(topic, { asks: mergedAsks() }, host);
    }
    if (ASK_EVENTS[topic] && data) {
      var id = data[ASK_EVENTS[topic]];
      if (id) askHost[id] = host;
      tag(data, host);
    }
    if (topic === 'claude.session.update') tag(data, host);
    emit(topic, data, host);
  }

  function up(host) { return links[host].isReady(); }

  // Each host's list, the last one known for a host that doesn't answer now.
  function fetchSessions(names) {
    return Promise.all(names.map(function (h) {
      return links[h].request('claude.sessions.list', {}).then(function (snap) {
        setSnap(h, snap);
        return null;
      }, function (e) { return e; });
    }));
  }

  function fetchAsks(names) {
    return Promise.all(names.map(function (h) {
      return links[h].request('claude.queue.list', {}).then(function (res) {
        per[h].asks = tagAsks((res && res.asks) || [], h);
        return null;
      }, function (e) { return e; });
    }));
  }

  function others() {
    var out = [];
    for (var i = 0; i < hosts.length; i++) if (hosts[i].name !== primary && up(hosts[i].name)) out.push(hosts[i].name);
    return out;
  }

  // A request for the machine the panel chose. The service doesn't get the
  // host param; the rest goes through as given.
  function requestHost(method, p, timeoutMs) {
    var host = p.host;
    if (typeof host !== 'string' || !Object.prototype.hasOwnProperty.call(links, host)) {
      return Promise.reject(new Error('unknown-host'));
    }
    if (!up(host)) return Promise.reject(new Error('not-answering'));
    var rest = {};
    for (var k in p) if (k !== 'host') rest[k] = p[k];
    return links[host].request(method, rest, timeoutMs);
  }

  function request(method, params, timeoutMs) {
    var p = params || {};
    if (method === 'claude.sessions.list') {
      var names = [primary].concat(others());
      return fetchSessions(names).then(function (errs) {
        // The Mac's answer decides success, as before; the NucBox's sessions
        // show even while the Mac is away.
        if (errs[0]) {
          if (names.length > 1) emit('claude.sessions.update', mergedSnap(), names[1]);
          throw errs[0];
        }
        return mergedSnap();
      });
    }
    if (method === 'claude.queue.list') {
      var qn = [primary].concat(others());
      return fetchAsks(qn).then(function (errs) {
        for (var i = 0; i < errs.length; i++) if (!errs[i]) return { asks: mergedAsks() };
        throw errs[0];
      });
    }
    if (method === 'claude.session.watch') {
      lastWatch = p;
      var wn = [primary].concat(others());
      return Promise.all(wn.map(function (h) {
        return links[h].request(method, p, timeoutMs).then(function (r) { return { ok: true, r: r }; }, function (e) { return { ok: false, e: e }; });
      })).then(function (rs) {
        for (var i = 0; i < rs.length; i++) if (rs[i].ok) return rs[i].r;
        throw rs[0].e;
      });
    }
    if (BY_HOST[method]) return requestHost(method, p, timeoutMs);
    var host = primary;
    if (BY_SESSION[method]) host = sessionHost[p[BY_SESSION[method]]] || primary;
    else if (BY_ASK[method]) host = askHost[p[BY_ASK[method]]] || primary;
    var res = links[host].request(method, p, timeoutMs);
    if (method === 'claude.session.get' && host !== primary) res = res.then(function (d) { return tag(d, host); });
    return res;
  }

  // The NucBox's link: its lists are fetched and merged as it comes, and
  // dropped as it goes, so its cards never outlive it.
  function secondaryOpen(h) {
    if (lastWatch) links[h].request('claude.session.watch', lastWatch).catch(function () {});
    fetchSessions([h]).then(function () { emit('claude.sessions.update', mergedSnap(), h); });
    fetchAsks([h]).then(function () { emit('claude.queue.sync', { asks: mergedAsks() }, h); });
  }

  function secondaryClose(h) {
    if (!per[h].snap && !(per[h].asks || []).length) return;
    per[h] = { snap: null, asks: [] };
    emit('claude.sessions.update', mergedSnap(), h);
    emit('claude.queue.sync', { asks: mergedAsks() }, h);
  }

  hosts.forEach(function (def) {
    per[def.name] = { snap: null, asks: [] };
    label[def.name] = def.label || def.name;
    var isPrimary = def.name === primary;
    links[def.name] = opts.createLink(def.url, {
      onFrame: function (f) { onFrame(def.name, f); },
      onOpen: function () {
        if (!isPrimary) return secondaryOpen(def.name);
        for (var i = 0; i < openListeners.length; i++) openListeners[i]();
      },
      onClose: function () {
        if (!isPrimary) return secondaryClose(def.name);
        for (var i = 0; i < closeListeners.length; i++) closeListeners[i]();
      },
    });
  });

  return {
    start: function () { for (var h in links) links[h].connect(); },
    request: request,
    on: function (topic, fn) { (topicListeners[topic] = topicListeners[topic] || []).push(fn); },
    // Runs after every (re)connect of the Mac's link: the place for boot fetches.
    onOpen: function (fn) { openListeners.push(fn); if (up(primary)) fn(); },
    onClose: function (fn) { closeListeners.push(fn); },
    primaryReady: function () { return up(primary); },
    // Every machine, in host order (the Mac first), as the picker lists them.
    machines: function () {
      return hosts.map(function (def) { return { name: def.name, label: label[def.name], ready: up(def.name) }; });
    },
  };
}
