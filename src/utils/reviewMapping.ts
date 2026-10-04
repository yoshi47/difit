// Maps difit comment threads into GitHub pull request review comments and
// validates each against the diff that difit is currently serving.
//
// This is the inverse of the read path in src/cli/github.ts (which turns GitHub
// review threads INTO difit positions). GitHub rejects an entire review POST if
// any single comment targets a line outside the diff hunks ("Line could not be
// resolved", HTTP 422 — verified against the live API), so we pre-validate here
// and report out-of-range comments as `skipped` instead of letting one bad
// comment drop the whole review.

import type {
  DiffCommentMessage,
  DiffCommentThread,
  DiffFile,
  DiffLineRange,
  DiffSide,
  SkippedReviewComment,
} from '../types/diff.js';

export interface ReviewCommentPayload {
  path: string;
  body: string;
  side: 'LEFT' | 'RIGHT';
  line: number;
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
}

export interface MappedReview {
  comments: Array<{ threadId: string; payload: ReviewCommentPayload }>;
  skipped: SkippedReviewComment[];
}

function toGitHubSide(side: DiffSide): 'LEFT' | 'RIGHT' {
  return side === 'new' ? 'RIGHT' : 'LEFT';
}

function rangeEnd(line: DiffLineRange): number {
  return typeof line === 'number' ? line : line.end;
}

function foldThreadBody(messages: DiffCommentMessage[]): string {
  const [root, ...replies] = messages;
  const rootBody = root?.body?.trim() ?? '';
  if (replies.length === 0) {
    return rootBody;
  }
  const replyText = replies
    .map((message) => {
      const who = message.author && message.author !== 'User' ? ` (@${message.author})` : '';
      return `> reply${who}: ${message.body.trim()}`;
    })
    .join('\n\n');
  return rootBody ? `${rootBody}\n\n${replyText}` : replyText;
}

function threadToPayload(thread: DiffCommentThread): ReviewCommentPayload | null {
  const body = foldThreadBody(thread.messages);
  if (!body) {
    return null;
  }
  const side = toGitHubSide(thread.position.side);
  const { line } = thread.position;
  if (typeof line === 'number') {
    return { path: thread.filePath, body, side, line };
  }
  return {
    path: thread.filePath,
    body,
    side,
    line: line.end,
    start_line: line.start,
    start_side: side,
  };
}

interface CommentableLines {
  right: Set<number>;
  left: Set<number>;
}

// RIGHT (new side) = lines present on the new side (additions + context).
// LEFT (old side) = lines present on the old side (deletions + context).
function buildCommentableLines(files: DiffFile[]): Map<string, CommentableLines> {
  const map = new Map<string, CommentableLines>();
  for (const file of files) {
    const lines: CommentableLines = { right: new Set(), left: new Set() };
    for (const chunk of file.chunks) {
      for (const line of chunk.lines) {
        if (line.newLineNumber !== undefined) {
          lines.right.add(line.newLineNumber);
        }
        if (line.oldLineNumber !== undefined) {
          lines.left.add(line.oldLineNumber);
        }
      }
    }
    map.set(file.path, lines);
    if (file.oldPath) {
      map.set(file.oldPath, lines);
    }
  }
  return map;
}

/**
 * Convert threads into GitHub review-comment payloads, validating each comment
 * against the served diff. Threads with an empty body or a position outside the
 * diff hunks are returned in `skipped` rather than `comments`.
 */
export function mapThreadsToReviewComments(
  threads: DiffCommentThread[],
  files: DiffFile[],
): MappedReview {
  const commentable = buildCommentableLines(files);
  const comments: MappedReview['comments'] = [];
  const skipped: SkippedReviewComment[] = [];

  for (const thread of threads) {
    const side = toGitHubSide(thread.position.side);
    const payload = threadToPayload(thread);
    if (!payload) {
      skipped.push({
        threadId: thread.id,
        path: thread.filePath,
        side,
        line: rangeEnd(thread.position.line),
        reason: 'empty comment body',
      });
      continue;
    }

    const lines = commentable.get(payload.path);
    const validSet = payload.side === 'RIGHT' ? lines?.right : lines?.left;
    const lineInRange = validSet !== undefined && validSet.has(payload.line);
    const startInRange =
      payload.start_line === undefined ||
      (validSet !== undefined && validSet.has(payload.start_line));

    if (!lineInRange || !startInRange) {
      skipped.push({
        threadId: thread.id,
        path: payload.path,
        side: payload.side,
        line: payload.line,
        reason: lines ? 'line is outside the diff hunks' : 'file is not part of the diff',
      });
      continue;
    }

    comments.push({ threadId: thread.id, payload });
  }

  return { comments, skipped };
}
