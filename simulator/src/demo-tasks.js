// SIM_DEMO=1's work list: the real NucBox tasks service (nucbox/tasks-service.js)
// on 8126, against a made-up TickTick in memory, with dictation that always
// hears the same thing. Exercises the same routes the Car Thing uses.
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const svc = require('../../nucbox/tasks-service.js');

export const TASKS_PORT = 8126;
const TOKEN = 'demo';

function fakeTickTick() {
  let n = 100;
  const tasks = [
    { id: 't1', title: 'Review Q4 roadmap draft', status: 0, sortOrder: 1, priority: 5, items: [
      { id: 'i1', title: 'Read the draft', status: 1, sortOrder: 0 },
      { id: 'i2', title: 'Comment on hiring plan', status: 0, sortOrder: 1048576 },
      { id: 'i3', title: 'Send notes to Priya', status: 0, sortOrder: 2097152 },
    ] },
    { id: 't2', title: 'Fix flaky login test', status: 0, sortOrder: 2, priority: 3, items: [] },
    { id: 't3', title: 'Expense report for October', status: 0, sortOrder: 3, priority: 0, items: [] },
    { id: 't4', title: 'Prep 1:1 agenda', status: 0, sortOrder: 4, priority: 0, items: [
      { id: 'i4', title: 'Career goals', status: 0, sortOrder: 0 },
    ] },
    { id: 't5', title: 'Update on-call runbook', status: 0, sortOrder: 5, priority: 1, items: [] },
    { id: 't6', title: 'Book flights for offsite', status: 0, sortOrder: 6, priority: 0, items: [] },
    { id: 't7', title: 'Write design doc for sync v2', status: 0, sortOrder: 7, priority: 3, items: [] },
  ];
  const find = (id) => tasks.find((t) => t.id === id);
  const gone = () => Object.assign(new Error('ticktick-404'), { status: 404 });
  return {
    projects: async () => [{ id: 'w', name: 'Work' }],
    projectData: async () => ({ tasks: JSON.parse(JSON.stringify(tasks)) }),
    task: async (l, id) => { const t = find(id); if (!t) throw gone(); return JSON.parse(JSON.stringify(t)); },
    createTask: async (body) => { const t = Object.assign({ id: 'n' + n++, status: 0, sortOrder: 100 + n, items: [] }, body); tasks.push(t); return t; },
    updateTask: async (l, id, fields) => {
      const t = find(id);
      if (!t) throw gone();
      if (fields.items) fields.items = fields.items.map((i) => Object.assign({ id: i.id || 'n' + n++ }, i));
      Object.assign(t, fields);
      return t;
    },
    complete: async (l, id) => { const t = find(id); if (t) t.status = 2; },
  };
}

export function startDemoTasks() {
  const server = svc.createService({
    tasks: svc.createTasks(fakeTickTick(), 'Work', Date.now),
    focus: svc.createFocus(path.join(os.tmpdir(), 'claude-panel-demo-focus.json'), Date.now),
    transcribe: async () => 'Draft the launch email',
    panelToken: TOKEN,
  });
  return new Promise((resolve) => server.listen(TASKS_PORT, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${TASKS_PORT}`, token: TOKEN });
  }));
}
