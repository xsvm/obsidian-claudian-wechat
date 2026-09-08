/**
 * Optimal-string-alignment distance (Levenshtein + adjacent-transposition,
 * each substring used at most once) - used by suggestBridgeCommand() in
 * main.ts to catch typos like a swapped pair of letters ("usgae" -> "usage",
 * one transposition) as well as the ordinary single-letter add/drop/
 * substitute cases, in one edit rather than two.
 */
export function damerauLevenshtein(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  const d: number[][] = Array.from({ length: la + 1 }, () => new Array<number>(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost); // transposition
      }
    }
  }
  return d[la][lb];
}

/**
 * Pulls the literal command word(s) a route's regex matches right after the
 * leading `^\/`, e.g. `/^\/goto\s+(\d+)/i` -> `['goto']`, or
 * `/^\/(model|effort|permission)\s+(\S+)/i` -> `['model', 'effort',
 * 'permission']` for a route whose first group is an alternation. Used to
 * derive the bridge's own command-word list straight from commandRoutes()
 * instead of hand-maintaining a second, parallel list that can drift out of
 * sync with what's actually registered.
 */
export function extractCommandWords(pattern: RegExp): string[] {
  const m = pattern.source.match(/^\^\\\/(?:\(([a-zA-Z|]+)\)|([a-zA-Z]+))/);
  if (!m) return [];
  return (m[1] ?? m[2]).split('|');
}
