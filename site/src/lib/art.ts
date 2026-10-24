import figlet from "figlet";

/** Render figlet art at build time. Lines are trimmed of trailing spaces. */
export function art(text: string, font = "ANSI Shadow"): string {
  const out = figlet.textSync(text, { font });
  return out
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, i, arr) => !(line === "" && (i === 0 || i === arr.length - 1)))
    .join("\n");
}
