// Ask Claude: pure text rules for turning a passage into a request that opens in Claude.
// Nothing here talks to Claude; the app only opens a prefilled chat that Nick sends himself.

/** The Claude desktop app cuts `q` at roughly 14,000 characters; stay safely under it. */
export const APP_LIMIT = 13_000;
/** claude.ai in the browser: long links are fragile, so keep these shorter. */
export const WEB_LIMIT = 6_000;

export const ACTIONS = [
  { id: 'critique', key: '1', label: 'Critique', hint: 'An honest editor’s read: what lands, what drags, what’s unclear' },
  { id: 'tighten', key: '2', label: 'Tighten', hint: 'Same meaning in fewer words, in your voice' },
  { id: 'story', key: '3', label: 'Find a story', hint: 'Which story or example would make the point stick' },
  { id: 'ask', key: '4', label: 'Ask anything', hint: 'Type your own question about the passage' },
  { id: 'continue', key: '5', label: 'Continue', hint: 'Draft the next few paragraphs in your voice' },
];

/** Drop notes to self and pictures: they are for Nick, not for the reader or for Claude. */
export function cleanText(text) {
  return text
    .replace(/<!--[\s\S]*?(-->|$)/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => (alt.trim() ? `[Picture: ${alt.trim()}]` : '[Picture]'))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function requestFor(action, { readers, question, whole, stories }) {
  const it = whole ? 'this section' : 'this passage';
  const forReaders = readers ? ', keeping my intended readers in mind' : '';
  switch (action) {
    case 'critique':
      return `Please critique ${it} as a candid editor would${forReaders}. Tell me what lands, what drags, and what is unclear or unconvincing, pointing to specific sentences. Don’t rewrite it. End with the three changes that would help most.`;
    case 'tighten':
      return `Please tighten ${it}. Keep my meaning, my voice and my examples, and cut whatever doesn’t earn its place. Give me the tightened version first, then a short list of the main cuts.`;
    case 'story':
      return `Suggest a story, case or example that would make the point of ${it} stick${forReaders}. `
        + (stories ? 'If one of my story prompts below fits, start there and say which. Otherwise offer two or three options' : 'Offer two or three options')
        + ', and flag any facts I would need to check.';
    case 'continue':
      return `Please draft the next few paragraphs, carrying on from where ${it} ends. Match my voice, rhythm and level of detail, and keep it to about 300 words. I’ll edit it.`;
    case 'ask':
      return (question || '').trim() || `What do you make of ${it}?`;
    default:
      throw new Error('Unknown action: ' + action);
  }
}

/**
 * Build the full request.
 * ctx: { text, whole, bookTitle, about, chapter, section, stories, question }
 * `stories` is the text of Nick's story-prompt notes, used only by Find a story.
 */
export function buildPrompt(action, ctx) {
  const lines = [];
  if (ctx.bookTitle) {
    lines.push(`I’m writing a book called “${ctx.bookTitle}”.` + (ctx.about ? ` ${sentence(ctx.about)}` : ''));
  } else if (ctx.about) lines.push(sentence(ctx.about));
  const sec = ctx.section && `the section “${ctx.section}”`, ch = ctx.chapter && `the chapter “${ctx.chapter}”`;
  if (ctx.whole && sec) lines.push(`Below is ${sec}${ch ? `, from ${ch}` : ''}.`);
  else if (sec || ch) lines.push(`Below is a passage from ${sec || ch}${sec && ch ? `, in ${ch}` : ''}.`);
  if (lines.length) lines.push('');
  const stories = action === 'story' ? cleanText(ctx.stories || '') : '';
  lines.push(requestFor(action, { readers: ctx.about, question: ctx.question, whole: ctx.whole, stories: !!stories }));
  lines.push('', ctx.whole ? '— The section —' : '— The passage —', '', cleanText(ctx.text));
  if (stories) lines.push('', '— My story prompts —', '', stories);
  return lines.join('\n');
}

function sentence(s) {
  s = s.trim();
  return /[.!?…”’)]$/.test(s) ? s : s + '.';
}

/**
 * Where to send the request.
 * Returns { url, copy } — `copy` is true when the text is too long for a link (or is going
 * to a Project, which can't be prefilled), so the app copies it for Nick to paste.
 */
export function claudeTarget(prompt, { via = 'app', project = null } = {}) {
  const base = via === 'web' ? 'https://claude.ai' : 'claude://claude.ai';
  const id = projectId(project);
  if (id) return { url: `${base}/project/${id}`, copy: true };
  const limit = via === 'web' ? WEB_LIMIT : APP_LIMIT;
  if (prompt.length > limit) return { url: `${base}/new`, copy: true };
  return { url: `${base}/new?q=${encodeURIComponent(prompt)}`, copy: false };
}

/** Accepts a Project link (https://claude.ai/project/<id>) or the bare id. */
export function projectId(link) {
  if (!link) return null;
  const m = String(link).trim().match(/(?:^|\/project\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Why a pasted Project link won't work, in plain words, or null when it will (or is empty).
 * The common mix-up: a Claude Code project link (claude.ai/code/…, ids starting chan_)
 * instead of a chat Project from claude.ai › Projects.
 */
export function projectLinkProblem(link) {
  const v = String(link || '').trim();
  if (!v || projectId(v)) return null;
  const example = 'It looks like claude.ai/project/ followed by a long code of letters, numbers and dashes.';
  if (/\bchan_|claude\.ai\/code\b|^claude:\/\/code\b/i.test(v)) {
    return 'That’s a link to a Claude Code project, which can’t hold a chat. Use a Project from Projects in claude.ai’s sidebar instead. ' + example;
  }
  return 'That isn’t a Claude Project link. In claude.ai, open the Project from Projects in the sidebar and copy the address. ' + example;
}

/** Notes whose title mentions stories or prompts are the ones Find a story sends along. */
export const isStoryNote = (title) => /\bstor(y|ies)\b|\bprompts?\b/i.test(title);
