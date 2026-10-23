/*
 * How well a name someone typed matches a name in the books: forgiving about case, "the", spacing,
 * punctuation and a small typo ("young jethros" → "The Young Jethros", "flagday" → "Flag Day").
 * For Abel's search (src/server/abel/find.ts).
 */

/** "The Young Jethros!" → "young jethros". */
export function normalizeName(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(the|a|an) /, "");
}

/** Edits between two strings (insert, delete, change one letter), stopping early past `max`. */
function distance(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Typos allowed in a word this long: none in short words, one or two in longer ones. */
const allowed = (word: string) => (word.length <= 3 ? 0 : word.length <= 7 ? 1 : 2);

/**
 * 0 (no match) to 100 (the same name). Whole-name matches score highest, then the name starting with
 * or containing what was typed, then every typed word found (allowing a typo in each).
 */
export function nameScore(query: string, name: string): number {
  const q = normalizeName(query);
  const n = normalizeName(name);
  if (!q || !n) return 0;
  if (q === n) return 100;
  const qc = q.replace(/ /g, "");
  const nc = n.replace(/ /g, "");
  if (qc === nc) return 95;
  if (n.startsWith(q)) return 80;
  if (n.includes(q) || nc.includes(qc)) return 70;
  if (distance(qc, nc, allowed(qc)) <= allowed(qc)) return 65;
  const words = n.split(" ");
  const qWords = q.split(" ");
  const found = qWords.filter((w) => words.some((x) => x === w || (x.startsWith(w) && w.length >= 3) || distance(w, x, allowed(w)) <= allowed(w)));
  if (found.length === qWords.length) return 50 + Math.min(10, qWords.length * 2);
  // Most of a longer name's words.
  if (qWords.length >= 3 && found.length >= qWords.length - 1) return 40;
  return 0;
}
