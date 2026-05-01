import { NPM_TOP, PYPI_TOP } from "./top-packages.js";
import type { Ecosystem, ScanSignal } from "./types.js";

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

function normalize(name: string, ecosystem: Ecosystem): string {
  const lower = name.toLowerCase();
  if (ecosystem === "pypi") return lower.replace(/[_.]/g, "-");
  return lower;
}

export function checkTyposquat(name: string, ecosystem: Ecosystem): ScanSignal | null {
  const top = ecosystem === "npm" ? NPM_TOP : PYPI_TOP;
  const normalizedTop = top.map((n) => normalize(n, ecosystem));
  const candidate = normalize(name, ecosystem);

  if (normalizedTop.includes(candidate)) return null; // it IS a top package

  let bestMatch: { name: string; distance: number } | null = null;
  for (let i = 0; i < normalizedTop.length; i++) {
    const target = normalizedTop[i];
    if (Math.abs(target.length - candidate.length) > 2) continue;
    const d = levenshtein(candidate, target);
    if (d > 0 && d <= 2 && (!bestMatch || d < bestMatch.distance)) {
      bestMatch = { name: top[i], distance: d };
    }
  }

  if (!bestMatch) return null;

  return {
    kind: "typosquat",
    severity: bestMatch.distance === 1 ? "high" : "medium",
    message: `name is ${bestMatch.distance} edit(s) from popular package "${bestMatch.name}"`,
    data: { suspected: bestMatch.name, distance: bestMatch.distance },
  };
}
