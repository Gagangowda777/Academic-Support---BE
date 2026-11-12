const https = require('https');

const DEFAULT_MODEL = 'gemini-3.8-flash';
const DEFAULT_TIMEOUT_MS = 300000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function responseDetail(body) {
  try {
    const parsed = JSON.parse(body);
    return String(parsed?.error?.message || body || '').slice(0, 300);
  } catch {
    return String(body || '').slice(0, 300);
  }
}

function requestOnce({ apiKey, model, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-goog-api-key': apiKey,
        },
      },
      (res) => {
        let raw = '';
        let size = 0;

        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            const error = new Error('Google AI Studio returned an unexpectedly large response');
            error.code = 'ERESPONSETOOLARGE';
            req.destroy(error);
            return;
          }
          raw += chunk;
        });

        res.on('end', () => {
          const status = res.statusCode || 0;
          if (status >= 200 && status < 300) {
            try {
              resolve(JSON.parse(raw));
            } catch {
              reject(new Error('Google AI Studio returned an invalid JSON response'));
            }
            return;
          }

          const detail = responseDetail(raw);
          const error = new Error(
            `Google AI Studio request failed (HTTP ${status})${detail ? `: ${detail}` : ''}`
          );
          error.statusCode = status;
          error.retryAfter = Number(res.headers['retry-after']) || 0;
          reject(error);
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      const error = new Error(`Google AI Studio did not respond within ${timeoutMs} ms`);
      error.code = 'ETIMEDOUT';
      req.destroy(error);
    });

    req.on('error', (error) => {
      if (error.code === 'ETIMEDOUT') {
        reject(new Error(`Google AI Studio did not respond within ${timeoutMs} ms`));
        return;
      }
      if (error.code === 'ERESPONSETOOLARGE') {
        reject(error);
        return;
      }
      const network = new Error(
        `Unable to contact Google AI Studio${error.code ? ` (${error.code})` : ''}: ${error.message}`
      );
      network.code = error.code;
      reject(network);
    });

    req.end(payload);
  });
}

/**
 * Calls Gemini generateContent over Node's HTTPS client. The global fetch
 * implementation in some local Node runtimes stalls on large POST requests;
 * this client also retries transient overload responses with a short backoff.
 */
async function requestGoogleAiJson({
  apiKey,
  model = DEFAULT_MODEL,
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = 3,
}) {
  if (!apiKey) throw new Error('GOOGLE_AI_STUDIO_API_KEY is required');

  const attempts = Math.max(1, Math.min(Number(maxAttempts) || 1, 4));
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestOnce({ apiKey, model, body, timeoutMs });
    } catch (error) {
      lastError = error;
      const retryable =
        RETRYABLE_STATUSES.has(error.statusCode) ||
        RETRYABLE_NETWORK_CODES.has(error.code);
      if (!retryable || attempt === attempts) break;

      const retryAfterMs = Math.max(0, error.retryAfter || 0) * 1000;
      await sleep(retryAfterMs || Math.min(1000 * 2 ** (attempt - 1), 5000));
    }
  }

  if (lastError?.statusCode === 503) {
    throw new Error(
      `${lastError.message}. The model is temporarily in high demand; try again shortly.`
    );
  }
  throw lastError || new Error('Google AI Studio request failed');
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  requestGoogleAiJson,
};