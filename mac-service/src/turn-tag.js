// Tags a finished turn's closing message: 'asking' when Claude ended on a
// question for the owner, 'update' otherwise. Deterministic and free, so the
// queue can tag every Stop without calling a model. A wrong tag only changes
// how loud the card is. Code is stripped before classifying so a "?" in a
// regex or a shell snippet never reads as a question; the card's excerpt keeps
// inline code (just unwrapped) so the question the owner reads stays whole.

const EXCERPT_MAX = 400;

// A "?" closing a sentence, allowing trailing quotes, a bracket or markdown
// emphasis ("**merge now?**", '"Should I?"').
const QUESTION = /\?["'”’)\]*_]*(?=\s|$)/;

// A fenced block; an unterminated fence runs to the end of the text.
const FENCE = /```[\s\S]*?(?:```|$)/g;
// Inline code is single-line, so a stray backtick cannot swallow later text.
const INLINE = /`([^`\n]*)`/g;

function lastParagraphOf(text) {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paragraphs.length ? paragraphs[paragraphs.length - 1] : '';
}

// Fenced blocks and inline code spans removed.
export function stripCode(text) {
  return String(text ?? '').replace(FENCE, '').replace(INLINE, '');
}

// The last non-empty blank-line-separated paragraph, code removed, trimmed.
export function lastParagraph(text) {
  return lastParagraphOf(stripCode(text));
}

export function tagTurn(text) {
  return QUESTION.test(lastParagraph(text)) ? 'asking' : 'update';
}

// What the card shows: the closing paragraph with fenced blocks dropped and
// inline code unwrapped (`foo` -> foo), clipped.
export function excerptOf(text) {
  const p = lastParagraphOf(String(text ?? '').replace(FENCE, '').replace(INLINE, '$1'));
  if (!p) return 'finished with no message';
  return p.length > EXCERPT_MAX ? `${p.slice(0, EXCERPT_MAX)}…` : p;
}
