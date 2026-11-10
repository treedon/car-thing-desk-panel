// The four preset buttons, by screen: 1 Tasks, 2 Agents (pressed again it
// walks sessions → usage → NucBox), 3 the queue — where, with a permission on
// screen, 3 is the card's own action: Deny — and 4 the rest of the house
// (pressed again it walks Home → Audio).

var AGENTS_CYCLE = { list: '#/usage', usage: '#/nucbox', nucbox: '#/list' };
var HOUSE_CYCLE = { home: '#/audio', audio: '#/home' };

// Whether preset 3 has a card to act on: any hero on the queue (it denies a
// permission, dismisses an expired card, or finishes a multi-select), or a
// permission on its own prompt screen.
export function cardOnScreen(routeName, hero, ask) {
  if (routeName === 'queue') return !!hero;
  if (routeName === 'ask') return !!ask && ask.kind === 'permission';
  return false;
}

export function presetTarget(key, routeName, permissionOnScreen) {
  if (key === '1') return '#/tasks';
  if (key === '2') return AGENTS_CYCLE[routeName] || '#/list';
  if (key === '3') {
    if (permissionOnScreen && (routeName === 'queue' || routeName === 'ask')) return 'deny';
    return '#/queue';
  }
  if (key === '4') return HOUSE_CYCLE[routeName] || '#/home';
  return null;
}

var SECTIONS = {
  tasks: 0, task: 0, focusset: 0, focus: 0,
  list: 1, session: 1, agent: 1, digest: 1, usage: 1, nucbox: 1, new: 1,
  queue: 2, ask: 2, prompt: 2,
  home: 3, audio: 3,
};

// Which of the four top-bar dots is lit; -1 for screens outside them.
export function sectionOf(routeName) {
  return routeName in SECTIONS ? SECTIONS[routeName] : -1;
}
