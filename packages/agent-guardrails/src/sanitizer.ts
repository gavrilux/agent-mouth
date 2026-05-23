const INJECTION_PATTERNS: RegExp[] = [
  /<\s*system\s*>/gi,
  /<\s*\/\s*system\s*>/gi,
  /ignore (previous|all|the) (instructions|prompt|rules)/gi,
  /you are now/gi,
  /\[\[SYSTEM\]\]/gi,
];

export function sanitize(text: string): string {
  let out = text;
  for (const p of INJECTION_PATTERNS) out = out.replace(p, "[REDACTED]");
  return out;
}
