// Small pure helpers, kept free of the UI so they can be tested with `npm test`.

/** Lines [from, to] (1-based, inclusive) of the paragraph holding `line`. */
export function paragraphRange(getLine, lineCount, line) {
  const blank = (n) => getLine(n).trim() === '';
  if (blank(line)) return [line, line];
  let from = line, to = line;
  while (from > 1 && !blank(from - 1)) from--;
  while (to < lineCount && !blank(to + 1)) to++;
  return [from, to];
}

/**
 * Line-by-line comparison of two versions (longest common subsequence).
 * Returns rows of { type: 'same' | 'left' | 'right', text }.
 */
export function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  // Guard against pathological sizes: fall back to "all different".
  if (n * m > 4_000_000) {
    return [...A.map((t) => ({ type: 'left', text: t })), ...B.map((t) => ({ type: 'right', text: t }))];
  }
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ type: 'same', text: A[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ type: 'left', text: A[i++] });
    else out.push({ type: 'right', text: B[j++] });
  }
  while (i < n) out.push({ type: 'left', text: A[i++] });
  while (j < m) out.push({ type: 'right', text: B[j++] });
  return out;
}

export function wordCount(text) {
  text = text.replace(/<!--[\s\S]*?(-->|$)/g, ''); // notes to self don't count
  return (text.match(/\S+/g) || []).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export function formatCount(n) {
  return n.toLocaleString('en-US');
}

/** "2026.11.23 1405" in local time, matching the folder rulebook's date format. */
export function stamp(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Take a snapshot of a book when it is being edited and the last one is over an hour old. */
export function snapshotDue(lastMs, nowMs, everyMs = 60 * 60 * 1000) {
  return !lastMs || nowMs - lastMs >= everyMs;
}

/** Someone else (the other Mac) touched this section recently. */
export function otherDeviceOn(activities, me, rel, nowMs, withinMs = 10 * 60 * 1000) {
  return activities.find((a) => a.device !== me && a.section === rel && nowMs - a.at < withinMs) || null;
}

/** Where to drop: index in `list` (without the dragged item) for a drop before `beforeName`. */
export function dropIndex(list, dragged, beforeName) {
  const rest = list.filter((n) => n !== dragged);
  if (beforeName == null) return rest.length;
  const i = rest.indexOf(beforeName);
  return i < 0 ? rest.length : i;
}

export function minutesAgo(ms, now = Date.now()) {
  const m = Math.round((now - ms) / 60000);
  if (m <= 0) return 'just now';
  if (m === 1) return '1 minute ago';
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  return h === 1 ? '1 hour ago' : `${h} hours ago`;
}
