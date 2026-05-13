// Retry helpers with exponential backoff.
// Use for: LLM calls, GitHub API, Supabase REST writes, integrator JSON parsing.

export const DEFAULTS = {
  retries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 15000,
  factor: 2,
  jitter: 0.25,           // 0..1 fraction of delay to randomize
};

// Decide whether an error is retryable. Override per call when needed.
export function isRetryableError(err) {
  if (!err) return false;
  const m = (err && err.message) ? String(err.message) : String(err);
  // Aborted requests are NOT retryable
  if (m.includes("aborted") || (err.name === "AbortError")) return false;
  // Network / fetch errors
  if (m.includes("NetworkError") || m.includes("Failed to fetch") || m.includes("ECONN")) return true;
  // HTTP 5xx pattern from our API clients: "Anthropic 500", "OpenAI 503", "GitHub 502", "Supabase 504"
  if (/(\b)([5][0-9]{2})\b/.test(m)) return true;
  // Rate limits
  if (/\b429\b/.test(m) || /rate.?limit/i.test(m)) return true;
  // Anthropic-specific transient
  if (/overloaded|temporarily unavailable|internal server error/i.test(m)) return true;
  // JSON parse failures from the integrator — worth retrying once or twice
  if (/Unbalanced JSON|No JSON found|Invalid JSON|Empty response/i.test(m)) return true;
  return false;
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function backoffDelay(attempt, opts) {
  const o = { ...DEFAULTS, ...opts };
  const raw = Math.min(o.maxDelayMs, o.baseDelayMs * Math.pow(o.factor, attempt - 1));
  const jitter = raw * o.jitter * (Math.random() * 2 - 1);
  return Math.max(0, Math.floor(raw + jitter));
}

// Retry an async function. `fn(attempt)` is called with 1-based attempt number.
// onAttempt({attempt, error, willRetry, nextDelayMs}) — optional callback for logging.
export async function retryAsync(fn, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const isRetryable = o.isRetryable || isRetryableError;
  let lastErr;
  for (let attempt = 1; attempt <= o.retries + 1; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const canRetry = attempt <= o.retries && isRetryable(err);
      const nextDelayMs = canRetry ? backoffDelay(attempt, o) : 0;
      if (o.onAttempt) {
        try { o.onAttempt({ attempt, error: err, willRetry: canRetry, nextDelayMs }); } catch {}
      }
      if (!canRetry) throw err;
      await delay(nextDelayMs);
    }
  }
  // Unreachable, but keep TypeScript-style flow analysis happy
  throw lastErr;
}
