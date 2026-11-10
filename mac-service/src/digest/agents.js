// A session's subagents as digest facts: how many finished, how many run, and the last six with
// their descriptions and reports. Read from the subagents' meta files, and from the tail of the
// transcript of each of the last six that finished; never every transcript (readSubagents reads a
// 64 KB tail of all of them). Text from a meta or a report is redacted first and cut after.
import { LIMITS } from './extract.js';
import { redact } from './redact.js';
import { listSubagentMetas, readSubagentReport } from '../sessions/subagents.js';

const DESCRIPTION_CHARS = 120;
const TYPE_CHARS = 40;
// A report is read whole (the tail read is 64 KB at most) so that it is redacted whole: cutting it
// to 300 first could leave the first characters of a key that straddles the cut.
const REPORT_READ_CHARS = 64 * 1024;

function cap(text, max) {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// One line of redacted text, cut to max.
const oneLine = (text, max) => cap(redact(text).replace(/\s+/g, ' ').trim(), max);

// AgentFacts. `running` is an agent whose meta does not say finished, that the owner did not stop,
// in a session that has not ended; every other agent counts as finished. `list` is the last six in
// the order of the metas (oldest first), with ids A<n> for the agent's place among all of them. A
// report is read only for an agent whose meta says finished: true.
export function readAgentFacts(sessionDir, { ended = false } = {}) {
  const metas = listSubagentMetas(sessionDir);
  const running = metas.map((m) => !m.finished && !m.stoppedByUser && !ended);
  let runningCount = 0;
  for (const r of running) if (r) runningCount++;
  const list = [];
  for (let i = Math.max(0, metas.length - LIMITS.agents); i < metas.length; i++) {
    const m = metas[i];
    const type = oneLine(m.agentType, TYPE_CHARS);
    const text = m.finished ? readSubagentReport(sessionDir, m.id, REPORT_READ_CHARS) : null;
    const report = text === null ? '' : cap(redact(text).trim(), LIMITS.reportChars);
    list.push({
      id: 'A' + (i + 1),
      description: oneLine(m.description, DESCRIPTION_CHARS) || type || 'agent',
      agentType: type,
      finished: !running[i],
      report: report || null,
    });
  }
  return { finished: metas.length - runningCount, running: runningCount, list };
}
