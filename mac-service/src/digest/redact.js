// Strips secrets from text before the digest stores, persists or sends it.
// Pure: no I/O. Rules run in order; the first ones remove whole blobs (keys,
// tokens) so the later, looser ones (assignments, hex, base64) see what is left.
//
// Input is cut to MAX_INPUT (256 KB) before any rule runs, and text past the cap
// is dropped from the output: the rules are linear on ordinary text, and the cap
// bounds the cost of anything degenerate on the hook-serving event loop. "Redact
// first, then cap" still holds, because every display cap downstream (500 and
// 1,200 chars) is far smaller than MAX_INPUT, so a secret that straddles a
// display cap lies wholly inside the scanned region and is caught.
export const REDACTED = '[redacted]';
export const MAX_INPUT = 256 * 1024;

const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abeprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(Bearer)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, '$1 ' + REDACTED],
  // name = value: the name may be quoted (JSON) or backslash-quoted (JSON inside a shell string); the
  // value is a quoted run that may hold spaces (an unterminated quote runs to the end of the line) or
  // an unquoted run up to whitespace, so ';' ',' '&' inside it do not leak a tail. The match starts at
  // the keyword (whatever precedes it in the word is left alone, so no length limit on a long prefix)
  // and \w{0,40} bounds the rest of the name: an unbounded \w* rescans the whole word for every
  // keyword in it (quadratic).
  [/((?:key|token|secret|passw(?:or)?d)\w{0,40})(\\?["']?\s*[=:]\s*)(?:\\?"[^"\n]{4,}"?|\\?'[^'\n]{4,}'?|[^\s"'`]{4,})/gi, '$1$2' + REDACTED],
  [/\b[0-9a-fA-F]{32,}\b/g, REDACTED], // long hex; shas are stored at <= 12 chars
  // 40+ base64/base64url chars are a secret when some '/'-separated piece of 24+ chars mixes a digit,
  // a lower- and an upper-case letter; path pieces are short and plain
  [/[A-Za-z0-9+\/_=-]{40,}/g, (m) => m.split('/').some((p) => p.length >= 24 && /\d/.test(p) && /[a-z]/.test(p) && /[A-Z]/.test(p)) ? REDACTED : m],
];

export function redact(text) {
  if (typeof text !== 'string') return '';
  let out = text.length > MAX_INPUT ? text.slice(0, MAX_INPUT) : text;
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}
