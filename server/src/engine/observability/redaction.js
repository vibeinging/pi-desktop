const DEFAULT_MAX_TEXT_CHARS = 16_000;
const SENSITIVE_KEY = /(?:api[_-]?key|authorization|cookie|password|secret|session[_-]?token|access[_-]?token|refresh[_-]?token|token)$/i;

function clip(text, maxTextChars) {
  const limit = Math.max(0, Number(maxTextChars || DEFAULT_MAX_TEXT_CHARS));
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}…[truncated]`;
}

export function redactTraceText(value, { maxTextChars = DEFAULT_MAX_TEXT_CHARS } = {}) {
  const text = String(value ?? "")
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;"'}]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token|session[_-]?token)\s*["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1[REDACTED]");
  return clip(text, maxTextChars);
}

export function sanitizeTraceValue(value, options = {}, depth = 0) {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return redactTraceText(value, options);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[binary ${value.byteLength} bytes]`;
  }
  if (depth >= 8) return "[max depth]";
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeTraceValue(item, options, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      out[key] = SENSITIVE_KEY.test(key)
        ? "[REDACTED]"
        : sanitizeTraceValue(item, options, depth + 1);
    }
    return out;
  }
  return redactTraceText(value, options);
}

export function traceText(value, options = {}) {
  if (value == null || value === "") return "";
  if (typeof value === "string") return redactTraceText(value, options);
  try {
    return redactTraceText(JSON.stringify(sanitizeTraceValue(value, options)), options);
  } catch {
    return redactTraceText(String(value), options);
  }
}
