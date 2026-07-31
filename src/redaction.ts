const SENSITIVE_KEY =
  /(?:^|[_-])(api[_-]?key|token|secret|password|passwd|credential|authorization|cookie|private[_-]?key)(?:$|[_-])/i;
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi,
];

export function redactString(value: string, maxLength = 8_192): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, '[REDACTED]');
  if (redacted.length > maxLength) return `${redacted.slice(0, maxLength)}…[TRUNCATED]`;
  return redacted;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[DEPTH_LIMIT]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(item, depth + 1);
    }
    return output;
  }
  return value;
}

export function containsSecret(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}
