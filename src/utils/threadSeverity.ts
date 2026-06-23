// Severity is not a native difit concept. The AI review engine prefixes each
// comment body with a `[Critical] / [Important] / [Suggestion]` tag, and this
// helper reads that tag back so the UI can offer "select by severity" bulk
// actions before posting to GitHub.

export type ThreadSeverity = 'critical' | 'important' | 'suggestion' | null;

const SEVERITY_TAG = /^\s*\[(critical|important|suggestion)\]/i;

export function getThreadSeverity(rootBody: string | undefined): ThreadSeverity {
  if (!rootBody) {
    return null;
  }
  const match = SEVERITY_TAG.exec(rootBody);
  if (!match) {
    return null;
  }
  return match[1].toLowerCase() as ThreadSeverity;
}
