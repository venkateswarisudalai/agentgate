// Tiny ANSI color helpers — no chalk dep.
const ESC = "\x1b[";
const useColor = process.stdout.isTTY && process.env.NO_COLOR !== "1";
const wrap = (open: string, close: string) => (s: string) =>
  useColor ? `${ESC}${open}m${s}${ESC}${close}m` : s;

export const c = {
  reset: ESC + "0m",
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  red: wrap("31", "39"),
  green: wrap("32", "39"),
  yellow: wrap("33", "39"),
  blue: wrap("34", "39"),
  magenta: wrap("35", "39"),
  cyan: wrap("36", "39"),
  gray: wrap("90", "39"),
  bgRed: wrap("41", "49"),
  bgYellow: wrap("43", "49"),
  bgGreen: wrap("42", "49"),
};

export function severityColor(sev?: string) {
  if (sev === "high") return c.red;
  if (sev === "medium") return c.yellow;
  return c.gray;
}

export function recoverableColor(rec?: string) {
  if (rec === "no") return c.red;
  if (rec === "partial") return c.yellow;
  if (rec === "yes") return c.green;
  return c.gray;
}
