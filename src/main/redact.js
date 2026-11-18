'use strict';

/**
 * Remove API keys from text before it reaches a log, an error dialog, or the pill.
 * Provider error bodies sometimes echo the credential ("Incorrect API key provided: ..."),
 * and those bodies flow into error messages that are shown on screen.
 *
 * Two layers: (1) exact replacement of the keys we KNOW, (2) well-known key shapes, for keys
 * we do not hold (a key from a previous run, a masked echo). Layer 2 is best-effort by nature.
 */
const SHAPES = [
  /\bnvapi-[A-Za-z0-9_-]{8,}/g,
  /\bxai-[A-Za-z0-9_-]{8,}/g,
  /\bAIza[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{12,}/gi,
  /\bBearer\s+(?=[A-Za-z._~+\/=-]*[0-9])[A-Za-z0-9._~+\/=-]{6,11}\b/gi,   // a short token (it has a digit, so ordinary words are left alone)
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,                // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,              // AWS access key id
  /\bgsk_[A-Za-z0-9]{16,}/g,                      // Groq
  /\bhf_[A-Za-z0-9]{16,}/g,                       // Hugging Face
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,             // Slack
  /\bcsk-[A-Za-z0-9_-]{12,}/g,                    // Cerebras
  /\bglpat-[A-Za-z0-9_-]{16,}/g,                  // GitLab
];
const MIN_SECRET = 8;   // shorter "secrets" would shred ordinary words

function redact(text, secrets = []) {
  let out = String(text == null ? '' : text);
  for (const s of secrets) if (typeof s === 'string' && s.length >= MIN_SECRET) out = out.split(s).join('[redacted]');
  for (const re of SHAPES) out = out.replace(re, '[redacted]');
  return out;
}
module.exports = { redact };
