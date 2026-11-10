// The salient argument of a tool call, for screens that have one line for it.
// Shared by the permission card, the conversation view and the subagent list.

export function summarizeTool(toolName, toolInput) {
  if (!toolInput) return toolName;
  const known = toolInput.command || toolInput.file_path || toolInput.url ||
    toolInput.path || toolInput.pattern;
  if (known) return String(known).slice(0, 200);
  // A tool we have no salient key for still has to read as English on a
  // 800x480 screen. Stringifying the whole input put a truncated blob of
  // JSON in the card body, so prefer any string field, then the key names.
  const text = Object.values(toolInput).find((v) => typeof v === 'string' && v.trim());
  if (text) return text.slice(0, 200);
  const keys = Object.keys(toolInput);
  return keys.length ? keys.join(', ').slice(0, 200) : toolName;
}

// "<name>: <salient input>", or just the name when there is nothing to add.
export function toolLine(toolName, toolInput) {
  const s = summarizeTool(toolName, toolInput);
  return s && s !== toolName ? `${toolName}: ${s}` : toolName;
}
