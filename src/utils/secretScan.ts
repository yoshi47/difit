// Heuristic secret scanner for review comment bodies.
//
// A pending (draft) review's comment bodies are sent to GitHub at POST time,
// even though the review is not yet submitted/visible to others. We therefore
// scan each body before posting and surface anything that looks like a leaked
// credential or internal hostname so the comment can be excluded and reported
// rather than silently shipped to GitHub's servers.

const SECRET_PATTERNS: { label: string; pattern: RegExp }[] = [
  {
    label: 'GitHub token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  },
  {
    label: 'GitHub fine-grained token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  },
  { label: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    label: 'Private key block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  },
  {
    label: 'JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  },
];

// Internal hostnames that should not be pushed to GitHub in plain text.
// Tune INTERNAL_HOST_PATTERN to your organization's domains.
const INTERNAL_HOST_PATTERN = /\b[\w-]+(?:\.[\w-]+)*\.meetsmore(?:-inc)?\.com\b/i;

/**
 * Returns a list of human-readable labels for any secret-like content found in
 * `text`. An empty array means nothing suspicious was detected.
 */
export function scanForSecrets(text: string): string[] {
  const labels: string[] = [];
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      labels.push(label);
    }
  }
  if (INTERNAL_HOST_PATTERN.test(text)) {
    labels.push('Internal hostname');
  }
  return labels;
}
