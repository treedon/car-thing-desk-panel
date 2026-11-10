// What a Stop payload says is still running when the turn ends: background
// tasks (shells, subagents) and one-shot scheduled wakeups. A session in that
// state has not finished — it will resume without the owner — so it reads busy
// rather than done, and the panel says what it is waiting on.
//
// Claude Code puts these on the hook payload as `background_tasks` and
// `session_crons`. Both are Claude Code-internal and have changed shape
// between builds, so every access is defensive and a field that is missing or
// the wrong type means "nothing in flight", never an error.

const LABEL_MAX = 60;

// Most telling first: the command a shell runs, then what the task was asked to
// do, then what kind of agent it is.
const LABEL_FIELDS = ['command', 'description', 'agent_type', 'name', 'type'];

function isObject(v) {
  return !!v && typeof v === 'object';
}

function taskLabel(task) {
  for (const field of LABEL_FIELDS) {
    const v = task[field];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, LABEL_MAX);
  }
  return 'background task';
}

// A one-shot cron is "minute hour day month weekday" with the first two pinned
// to numbers, e.g. '40 15 6 11 *' -> 15:40. Anything else (ranges, steps,
// wildcards) is still a wakeup, just one with no single time to print.
function wakeLabel(cron) {
  const [minute, hour] = String(cron.schedule || '').trim().split(/\s+/);
  if (/^\d+$/.test(minute || '') && /^\d+$/.test(hour || '')) {
    return `wakes at ${Number(hour)}:${String(Number(minute)).padStart(2, '0')}`;
  }
  return 'scheduled wakeup';
}

export function waitingOnFrom(payload, nowMs) {
  const out = [];
  const p = isObject(payload) ? payload : {};
  const tasks = Array.isArray(p.background_tasks) ? p.background_tasks : [];
  for (const task of tasks) {
    if (!isObject(task)) continue;
    out.push({ type: typeof task.type === 'string' && task.type ? task.type : 'task', label: taskLabel(task), since: nowMs });
  }
  // Only a one-shot is a run in flight. A recurring cron is a standing
  // schedule: counting it would pin every session that has one to busy forever.
  const crons = Array.isArray(p.session_crons) ? p.session_crons : [];
  for (const cron of crons) {
    if (!isObject(cron) || cron.recurring !== false) continue;
    out.push({ type: 'cron', label: wakeLabel(cron), since: nowMs });
  }
  return out;
}
