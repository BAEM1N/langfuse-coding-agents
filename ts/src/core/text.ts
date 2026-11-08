// Redaction and size limits applied to everything before it leaves the machine.

const REDACTIONS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\b(sk|pk)-lf-[0-9a-f-]{20,}/gi, '$1-lf-[REDACTED]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, 'sk-ant-[REDACTED]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, 'sk-[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, 'github_pat_[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, 'gh*_[REDACTED]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, 'glpat-[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'xox*-[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED JWT]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{20,}=*/g, '$1 [REDACTED]'],
  // WireGuard / generic key=value secrets
  [/\b(PrivateKey|PresharedKey)(\s*=\s*)[A-Za-z0-9+/]{42,44}=?/g, '$1$2[REDACTED]'],
  [/\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)(\s*[=:]\s*)["']?[^\s"']{8,}["']?/g, '$1$2[REDACTED]'],
];

export function redact(s: string): string {
  let out = s;
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

export function truncate(s: string, max: number): string {
  if (max <= 0 || s.length <= max) return s;
  return `${s.slice(0, max)}… [truncated ${s.length - max} chars]`;
}

export interface SanitizeOptions {
  maxChars: number;
  redact: boolean;
}

/**
 * Deep-copy a value, redacting secrets and truncating long strings.
 * Base64 image payloads are replaced with a placeholder.
 */
export function sanitize(value: unknown, opts: SanitizeOptions, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    const s = opts.redact ? redact(value) : value;
    return truncate(s, opts.maxChars);
  }
  if (typeof value !== 'object') return value;
  if (depth > 12) return '[max depth]';
  if (Array.isArray(value)) return value.map((v) => sanitize(v, opts, depth + 1));
  const obj = value as Record<string, unknown>;
  if (obj.type === 'image' || obj.type === 'input_image') return { type: 'image', note: '[image omitted]' };
  if (obj.type === 'base64' && typeof obj.data === 'string') return { type: 'base64', note: '[binary omitted]' };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = sanitize(v, opts, depth + 1);
  return out;
}

/** Flatten message content (string | content blocks) to plain text. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (typeof b === 'string') return b;
      if (!b || typeof b !== 'object') return '';
      const blk = b as Record<string, unknown>;
      if (typeof blk.text === 'string') return blk.text;
      if (blk.type === 'image' || blk.type === 'input_image') return '[image]';
      if (blk.type === 'tool_result') return contentText(blk.content);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
