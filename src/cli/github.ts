import { execFileSync } from 'child_process';

import type { CommentImport, DiffCommentPosition, DiffLineRange } from '../types/diff.js';
import type { ReviewCommentPayload } from '../utils/reviewMapping.js';

interface PullRequestInfo {
  owner: string;
  repo: string;
  pullNumber: number;
  hostname: string;
}

interface GitHubReviewThreadAuthor {
  login?: string | null;
}

interface GitHubReviewThreadCommentNode {
  id?: string | null;
  body?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  author?: GitHubReviewThreadAuthor | null;
}

interface GitHubReviewThreadNode {
  id?: string | null;
  isResolved?: boolean | null;
  isOutdated?: boolean | null;
  subjectType?: string | null;
  path?: string | null;
  diffSide?: string | null;
  startDiffSide?: string | null;
  line?: number | null;
  startLine?: number | null;
  originalLine?: number | null;
  originalStartLine?: number | null;
  comments?: {
    nodes?: GitHubReviewThreadCommentNode[] | null;
  } | null;
}

interface GitHubReviewThreadsPageInfo {
  hasNextPage?: boolean | null;
  endCursor?: string | null;
}

interface GitHubReviewThreadsConnection {
  nodes?: GitHubReviewThreadNode[] | null;
  pageInfo?: GitHubReviewThreadsPageInfo | null;
}

interface GitHubReviewThreadsGraphqlResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: GitHubReviewThreadsConnection | null;
      } | null;
    } | null;
  } | null;
  errors?: Array<{
    message?: string | null;
  }> | null;
}

interface PrCommentImportsPage {
  commentImports: CommentImport[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
}

const PR_REVIEW_THREADS_GRAPHQL_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        nodes {
          id
          isResolved
          isOutdated
          subjectType
          path
          diffSide
          startDiffSide
          line
          startLine
          originalLine
          originalStartLine
          comments(first: 100) {
            nodes {
              id
              body
              createdAt
              updatedAt
              author {
                login
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function formatGhCommandError(error: unknown): Error {
  const stderr = (error as { stderr?: Buffer | string }).stderr;
  const stderrText =
    typeof stderr === 'string'
      ? stderr.trim()
      : Buffer.isBuffer(stderr)
        ? stderr.toString('utf8').trim()
        : '';
  const message =
    stderrText || (error instanceof Error ? error.message : 'Unknown error while running gh');
  return new Error(`${message}\nTry: gh auth login`);
}

function warnPrCommentImport(threadId: string | undefined, message: string): void {
  const threadLabel = threadId ? ` ${threadId}` : '';
  console.warn(`Warning: Skipping PR review thread${threadLabel}: ${message}`);
}

function createSingleLinePosition(side: 'old' | 'new', line: number): DiffCommentPosition {
  return { side, line };
}

function createMultiLinePosition(
  side: 'old' | 'new',
  start: number,
  end: number,
): DiffCommentPosition {
  const line: DiffLineRange = { start, end };
  return { side, line };
}

function createRightSidePosition(thread: GitHubReviewThreadNode): DiffCommentPosition | null {
  if (!isPositiveInteger(thread.line)) {
    warnPrCommentImport(thread.id ?? undefined, 'RIGHT thread is missing line.');
    return null;
  }

  const startLine =
    thread.startLine !== undefined && thread.startLine !== null ? thread.startLine : null;
  const isSingleLineWithRedundantStart =
    startLine !== null && startLine === thread.line && thread.startDiffSide == null;
  const hasMultiLineMetadata =
    thread.startDiffSide !== undefined && thread.startDiffSide !== null
      ? true
      : startLine !== null && !isSingleLineWithRedundantStart;

  if (!hasMultiLineMetadata) {
    return createSingleLinePosition('new', thread.line);
  }

  if (thread.startDiffSide !== 'RIGHT') {
    warnPrCommentImport(thread.id ?? undefined, 'RIGHT thread has mismatched startDiffSide.');
    return null;
  }

  if (!isPositiveInteger(startLine) || startLine > thread.line) {
    warnPrCommentImport(thread.id ?? undefined, 'RIGHT thread has an invalid multi-line range.');
    return null;
  }

  return createMultiLinePosition('new', startLine, thread.line);
}

function createLeftSidePosition(thread: GitHubReviewThreadNode): DiffCommentPosition | null {
  if (!isPositiveInteger(thread.originalLine)) {
    warnPrCommentImport(thread.id ?? undefined, 'LEFT thread is missing originalLine.');
    return null;
  }

  const originalStartLine =
    thread.originalStartLine !== undefined && thread.originalStartLine !== null
      ? thread.originalStartLine
      : null;
  const isSingleLineWithRedundantStart =
    originalStartLine !== null &&
    originalStartLine === thread.originalLine &&
    thread.startDiffSide == null;
  const hasMultiLineMetadata =
    thread.startDiffSide !== undefined && thread.startDiffSide !== null
      ? true
      : originalStartLine !== null && !isSingleLineWithRedundantStart;

  if (!hasMultiLineMetadata) {
    return createSingleLinePosition('old', thread.originalLine);
  }

  if (thread.startDiffSide !== 'LEFT') {
    warnPrCommentImport(thread.id ?? undefined, 'LEFT thread has mismatched startDiffSide.');
    return null;
  }

  if (!isPositiveInteger(originalStartLine) || originalStartLine > thread.originalLine) {
    warnPrCommentImport(thread.id ?? undefined, 'LEFT thread has an invalid multi-line range.');
    return null;
  }

  return createMultiLinePosition('old', originalStartLine, thread.originalLine);
}

function getThreadPosition(thread: GitHubReviewThreadNode): DiffCommentPosition | null {
  if (thread.diffSide === 'RIGHT') {
    return createRightSidePosition(thread);
  }

  if (thread.diffSide === 'LEFT') {
    return createLeftSidePosition(thread);
  }

  warnPrCommentImport(thread.id ?? undefined, 'Unsupported diffSide.');
  return null;
}

function toSortedComments(thread: GitHubReviewThreadNode): GitHubReviewThreadCommentNode[] {
  return [...(thread.comments?.nodes ?? [])].sort((left, right) =>
    (left.createdAt ?? '').localeCompare(right.createdAt ?? ''),
  );
}

function toCommentImportsForThread(thread: GitHubReviewThreadNode): CommentImport[] {
  if (thread.isResolved || thread.isOutdated || thread.subjectType !== 'LINE') {
    return [];
  }

  if (typeof thread.path !== 'string' || thread.path.trim().length === 0) {
    warnPrCommentImport(thread.id ?? undefined, 'Thread is missing path.');
    return [];
  }
  const filePath = thread.path;

  const position = getThreadPosition(thread);
  if (!position) {
    return [];
  }

  const comments = toSortedComments(thread);
  if (comments.length === 0) {
    warnPrCommentImport(thread.id ?? undefined, 'Thread has no comments.');
    return [];
  }

  const rootComment = comments[0];
  if (
    !rootComment ||
    typeof rootComment.id !== 'string' ||
    typeof rootComment.body !== 'string' ||
    typeof rootComment.createdAt !== 'string' ||
    typeof rootComment.updatedAt !== 'string'
  ) {
    warnPrCommentImport(thread.id ?? undefined, 'Thread has a comment with missing fields.');
    return [];
  }

  const commentImports: CommentImport[] = [
    {
      type: 'thread',
      id: rootComment.id,
      filePath,
      position,
      body: rootComment.body,
      author: rootComment.author?.login ?? undefined,
      createdAt: rootComment.createdAt,
      updatedAt: rootComment.updatedAt,
    },
  ];

  for (const comment of comments.slice(1)) {
    if (
      typeof comment.id !== 'string' ||
      typeof comment.body !== 'string' ||
      typeof comment.createdAt !== 'string' ||
      typeof comment.updatedAt !== 'string'
    ) {
      warnPrCommentImport(thread.id ?? undefined, 'Thread has a comment with missing fields.');
      continue;
    }

    commentImports.push({
      type: 'reply',
      id: comment.id,
      filePath,
      position,
      body: comment.body,
      author: comment.author?.login ?? undefined,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    });
  }

  return commentImports;
}

export function parseGitHubPrUrl(url: string): PullRequestInfo | null {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);

    if (pathParts.length < 4 || pathParts[2] !== 'pull') {
      return null;
    }

    const owner = pathParts[0];
    const repo = pathParts[1];
    const pullNumber = parseInt(pathParts[3], 10);

    if (isNaN(pullNumber)) {
      return null;
    }

    return { owner, repo, pullNumber, hostname: urlObj.hostname };
  } catch {
    return null;
  }
}

export function getPrPatch(prArg: string): string {
  try {
    const patch = execFileSync('gh', ['pr', 'diff', prArg], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (!patch.trim()) {
      throw new Error('No diff content returned from gh pr diff');
    }

    return patch;
  } catch (error) {
    throw formatGhCommandError(error);
  }
}

export function parsePrCommentImportsResponse(
  response: GitHubReviewThreadsGraphqlResponse,
): PrCommentImportsPage {
  const errors = response.errors?.map((error) => error.message).filter((message) => message) ?? [];
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  const reviewThreads = response.data?.repository?.pullRequest?.reviewThreads;
  if (!reviewThreads) {
    return {
      commentImports: [],
      pageInfo: {
        hasNextPage: false,
        endCursor: null,
      },
    };
  }

  return {
    commentImports: (reviewThreads.nodes ?? []).flatMap((thread) =>
      toCommentImportsForThread(thread),
    ),
    pageInfo: {
      hasNextPage: reviewThreads.pageInfo?.hasNextPage === true,
      endCursor: reviewThreads.pageInfo?.endCursor ?? null,
    },
  };
}

export function getPrCommentImports(prArg: string): Promise<CommentImport[]> {
  const pullRequestInfo = parseGitHubPrUrl(prArg);
  if (!pullRequestInfo) {
    throw new Error('Invalid GitHub PR URL');
  }

  const { owner, repo, pullNumber, hostname } = pullRequestInfo;
  const commentImports: CommentImport[] = [];
  let endCursor: string | null = null;

  while (true) {
    try {
      const args = [
        'api',
        'graphql',
        '--hostname',
        hostname,
        '-f',
        `query=${PR_REVIEW_THREADS_GRAPHQL_QUERY}`,
        '-F',
        `owner=${owner}`,
        '-F',
        `repo=${repo}`,
        '-F',
        `number=${pullNumber}`,
      ];

      if (endCursor) {
        args.push('-F', `endCursor=${endCursor}`);
      }

      const stdout = execFileSync('gh', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const parsed = JSON.parse(stdout) as GitHubReviewThreadsGraphqlResponse;
      const page = parsePrCommentImportsResponse(parsed);
      commentImports.push(...page.commentImports);

      if (!page.pageInfo.hasNextPage) {
        return Promise.resolve(commentImports);
      }

      if (!page.pageInfo.endCursor) {
        throw new Error('GitHub GraphQL response indicated more pages without endCursor.');
      }

      endCursor = page.pageInfo.endCursor;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Invalid JSON returned from gh api graphql');
      }

      if (error instanceof Error && !('stderr' in (error as object))) {
        throw error;
      }

      throw formatGhCommandError(error);
    }
  }
}

// ---------------------------------------------------------------------------
// Write path: post curated comments to GitHub as a PENDING (draft) review.
// The inverse of the read path above. We never submit the review automatically
// (event is omitted), so the user finishes/submits it from GitHub's own UI.
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWED_GH_HOSTS = ['github.com'];

function allowedGitHubHosts(): string[] {
  const extra = (process.env.DIFIT_ALLOWED_GH_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  return [...DEFAULT_ALLOWED_GH_HOSTS, ...extra];
}

// parseGitHubPrUrl does not validate the hostname, so the write path must
// refuse to push to anything but github.com (or an explicitly allowed GHE host).
function resolveWriteTarget(prArg: string): PullRequestInfo {
  const info = parseGitHubPrUrl(prArg);
  if (!info) {
    throw new Error('Invalid GitHub PR URL');
  }
  if (!allowedGitHubHosts().includes(info.hostname)) {
    throw new Error(
      `Refusing to write to untrusted host "${info.hostname}". ` +
        `Allowed: ${allowedGitHubHosts().join(', ')} (set DIFIT_ALLOWED_GH_HOSTS to extend).`,
    );
  }
  return info;
}

function hostArgs(hostname: string): string[] {
  return hostname === 'github.com' ? [] : ['--hostname', hostname];
}

function ghStderrText(error: unknown): string {
  const stderr = (error as { stderr?: Buffer | string }).stderr;
  if (typeof stderr === 'string') {
    return stderr;
  }
  if (Buffer.isBuffer(stderr)) {
    return stderr.toString('utf8');
  }
  return error instanceof Error ? error.message : '';
}

export type GitHubReviewErrorKind = 'pending_conflict' | 'line_unresolved' | 'unknown';

export class GitHubReviewError extends Error {
  readonly kind: GitHubReviewErrorKind;

  constructor(message: string, kind: GitHubReviewErrorKind) {
    super(message);
    this.name = 'GitHubReviewError';
    this.kind = kind;
  }
}

export function getPrHeadSha(prArg: string): string {
  resolveWriteTarget(prArg);
  try {
    const sha = execFileSync(
      'gh',
      ['pr', 'view', prArg, '--json', 'headRefOid', '-q', '.headRefOid'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    if (!sha) {
      throw new Error('gh pr view returned an empty headRefOid');
    }
    return sha;
  } catch (error) {
    throw formatGhCommandError(error);
  }
}

function getCurrentUserLogin(hostname: string): string {
  try {
    return execFileSync('gh', ['api', ...hostArgs(hostname), 'user', '-q', '.login'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw formatGhCommandError(error);
  }
}

export interface ExistingPendingReview {
  id: number;
  htmlUrl: string;
}

interface GitHubReviewListItem {
  id?: number;
  state?: string;
  html_url?: string;
  user?: { login?: string } | null;
}

// GitHub allows only one pending review per user per PR (a 2nd create returns
// HTTP 422). We check up front so we can show a clear message + deep link
// instead of relying on parsing the 422 body.
export function getMyPendingReview(prArg: string): ExistingPendingReview | null {
  const { owner, repo, pullNumber, hostname } = resolveWriteTarget(prArg);
  const login = getCurrentUserLogin(hostname);
  try {
    const stdout = execFileSync(
      'gh',
      [
        'api',
        ...hostArgs(hostname),
        '--paginate',
        `repos/${owner}/${repo}/pulls/${pullNumber}/reviews`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const reviews = JSON.parse(stdout) as GitHubReviewListItem[];
    const pending = reviews.find(
      (review) => review.state === 'PENDING' && review.user?.login === login,
    );
    if (pending && typeof pending.id === 'number') {
      return { id: pending.id, htmlUrl: pending.html_url ?? '' };
    }
    return null;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Invalid JSON returned from gh api (reviews)');
    }
    throw formatGhCommandError(error);
  }
}

export interface CreatedPendingReview {
  reviewId: number;
  htmlUrl: string;
}

export function createPendingReview(
  prArg: string,
  params: { commitId: string; comments: ReviewCommentPayload[] },
): CreatedPendingReview {
  const { owner, repo, pullNumber, hostname } = resolveWriteTarget(prArg);

  // event omitted => PENDING (draft). Verified against the live API.
  const payload = JSON.stringify({
    commit_id: params.commitId,
    comments: params.comments,
  });

  try {
    const stdout = execFileSync(
      'gh',
      [
        'api',
        ...hostArgs(hostname),
        '-X',
        'POST',
        `repos/${owner}/${repo}/pulls/${pullNumber}/reviews`,
        '--input',
        '-',
      ],
      { input: payload, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const review = JSON.parse(stdout) as { id?: number; html_url?: string };
    if (typeof review.id !== 'number') {
      throw new Error('GitHub did not return a review id');
    }
    return { reviewId: review.id, htmlUrl: review.html_url ?? '' };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Invalid JSON returned from gh api (create review)');
    }
    const stderr = ghStderrText(error);
    if (/one pending review per pull request/i.test(stderr)) {
      throw new GitHubReviewError(
        'You already have a pending review on this pull request.',
        'pending_conflict',
      );
    }
    if (/line could not be resolved/i.test(stderr)) {
      throw new GitHubReviewError(
        'A comment targets a line outside the diff and was rejected by GitHub.',
        'line_unresolved',
      );
    }
    throw formatGhCommandError(error);
  }
}
