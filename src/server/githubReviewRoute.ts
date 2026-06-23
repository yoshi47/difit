import type { Express, Request } from 'express';

import {
  createPendingReview,
  getMyPendingReview,
  getPrHeadSha,
  GitHubReviewError,
} from '../cli/github.js';
import type { DiffCommentThread, DiffFile, DiffSelection } from '../types/diff.js';
import { mapThreadsToReviewComments } from '../utils/reviewMapping.js';
import { scanForSecrets } from '../utils/secretScan.js';

export interface GitHubReviewRouteDeps {
  prContext: { prUrl: string; headSha: string };
  // One-time token handed to the client via /api/diff. Required on every POST.
  reviewPostToken: string;
  // False when the server is bound to a non-loopback host (e.g. 0.0.0.0).
  isLoopbackBind: boolean;
  getPort: () => number;
  resolveSelection: (query: Record<string, unknown>) => DiffSelection;
  getThreads: (selection: DiffSelection) => DiffCommentThread[];
  getDiffFiles: () => DiffFile[];
}

// Defense-in-depth against DSRF: only accept same-origin loopback requests.
// The X-Difit-Token header is the primary guard; this rejects cross-origin /
// cross-port pages and DNS-rebinding attempts even if the token were guessed.
function isAllowedLocalRequest(req: Request, port: number): boolean {
  const host = req.headers.host;
  if (typeof host !== 'string') {
    return false;
  }
  const allowedHosts = [`localhost:${port}`, `127.0.0.1:${port}`];
  if (!allowedHosts.includes(host)) {
    return false;
  }

  const origin = req.headers.origin;
  if (origin !== undefined) {
    const allowedOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
    if (typeof origin !== 'string' || !allowedOrigins.includes(origin)) {
      return false;
    }
  }
  return true;
}

function parseThreadIds(body: unknown): string[] | null {
  const value =
    typeof body === 'string'
      ? (() => {
          try {
            return JSON.parse(body) as unknown;
          } catch {
            return null;
          }
        })()
      : body;
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const threadIds = (value as { threadIds?: unknown }).threadIds;
  if (
    !Array.isArray(threadIds) ||
    threadIds.length === 0 ||
    !threadIds.every((id) => typeof id === 'string')
  ) {
    return null;
  }
  return threadIds as string[];
}

/**
 * Registers POST /api/github-review, which posts the selected comment threads to
 * GitHub as a PENDING (draft) review. The route never submits the review — the
 * user finishes it from GitHub's own UI.
 */
export function registerGitHubReviewRoute(app: Express, deps: GitHubReviewRouteDeps): void {
  app.post('/api/github-review', (req, res) => {
    // 1) Refuse to expose a GitHub write capability on a non-loopback bind.
    if (!deps.isLoopbackBind) {
      res.status(403).json({
        success: false,
        posted: 0,
        skipped: [],
        error: 'Posting to GitHub is disabled when difit is bound to a non-loopback host.',
      });
      return;
    }

    // 2) CSRF/DSRF guards.
    const token = req.header('x-difit-token');
    if (!token || token !== deps.reviewPostToken) {
      res.status(403).json({
        success: false,
        posted: 0,
        skipped: [],
        error: 'Invalid difit token.',
      });
      return;
    }
    if (!isAllowedLocalRequest(req, deps.getPort())) {
      res.status(403).json({
        success: false,
        posted: 0,
        skipped: [],
        error: 'Cross-origin request rejected.',
      });
      return;
    }

    const threadIds = parseThreadIds(req.body);
    if (!threadIds) {
      res.status(400).json({
        success: false,
        posted: 0,
        skipped: [],
        error: 'threadIds must be a non-empty array of strings.',
      });
      return;
    }

    try {
      // 3) Map only the selected threads, validating each against the served diff.
      const selection = deps.resolveSelection(req.query as Record<string, unknown>);
      const threads = deps.getThreads(selection);
      const selected = threads.filter((thread) => threadIds.includes(thread.id));
      const { comments, skipped } = mapThreadsToReviewComments(selected, deps.getDiffFiles());

      // 4) Secret scan: never ship a body that looks like it leaks a credential.
      const safe: typeof comments = [];
      for (const comment of comments) {
        const labels = scanForSecrets(comment.payload.body);
        if (labels.length > 0) {
          skipped.push({
            threadId: comment.threadId,
            path: comment.payload.path,
            side: comment.payload.side,
            line: comment.payload.line,
            reason: `possible secret in body (${labels.join(', ')})`,
          });
        } else {
          safe.push(comment);
        }
      }

      if (safe.length === 0) {
        res.status(422).json({
          success: false,
          posted: 0,
          skipped,
          error: 'No postable comments after validation.',
        });
        return;
      }

      // 5) Only one pending review per user per PR — check before posting.
      const existingPending = getMyPendingReview(deps.prContext.prUrl);
      if (existingPending) {
        res.status(409).json({
          success: false,
          posted: 0,
          skipped,
          pendingConflict: true,
          pendingReviewUrl: existingPending.htmlUrl,
          error: 'You already have a pending review on this PR. Submit or discard it first.',
        });
        return;
      }

      // 6) Stale-head guard: refuse if the PR advanced since the diff was loaded.
      const currentHead = getPrHeadSha(deps.prContext.prUrl);
      if (currentHead !== deps.prContext.headSha) {
        res.status(409).json({
          success: false,
          posted: 0,
          skipped,
          error: 'The PR has new commits since this diff was loaded. Reload difit and retry.',
        });
        return;
      }

      const created = createPendingReview(deps.prContext.prUrl, {
        commitId: deps.prContext.headSha,
        comments: safe.map((comment) => comment.payload),
      });

      res.json({
        success: true,
        posted: safe.length,
        skipped,
        htmlUrl: created.htmlUrl,
        reviewId: created.reviewId,
      });
    } catch (error) {
      if (error instanceof GitHubReviewError) {
        res.status(error.kind === 'pending_conflict' ? 409 : 422).json({
          success: false,
          posted: 0,
          skipped: [],
          pendingConflict: error.kind === 'pending_conflict',
          error: error.message,
        });
        return;
      }
      console.error('Error posting GitHub review:', error);
      res.status(500).json({
        success: false,
        posted: 0,
        skipped: [],
        error: error instanceof Error ? error.message : 'Failed to post review.',
      });
    }
  });
}
