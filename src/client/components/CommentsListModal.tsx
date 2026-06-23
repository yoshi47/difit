import { X } from 'lucide-react';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useHotkeys, useHotkeysContext } from 'react-hotkeys-hook';

import type { CommentThread, GitHubReviewResult } from '../../types/diff';

import { CommentThreadCard } from './CommentThreadCard';
import type { AppearanceSettings } from './SettingsModal';

interface GitHubReviewPostState {
  status: 'idle' | 'posting' | 'done' | 'error';
  result?: GitHubReviewResult;
}

interface CommentsListModalProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (thread: CommentThread) => void;
  comments: CommentThread[];
  showAuthorBadges?: boolean;
  onRemoveThread: (threadId: string) => void;
  onGenerateThreadPrompt: (thread: CommentThread) => string;
  onReplyToThread: (threadId: string, body: string) => Promise<void>;
  onRemoveMessage: (threadId: string, messageId: string) => void;
  onUpdateMessage: (threadId: string, messageId: string, newBody: string) => void;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
  // Post-to-GitHub (pending review) selection — only set in --pr mode.
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggleSelected?: (threadId: string) => void;
  onSelectAll?: () => void;
  onSelectNone?: () => void;
  onSelectHighSeverity?: () => void;
  onPostToGitHub?: () => void;
  postState?: GitHubReviewPostState;
}

export function CommentsListModal({
  isOpen,
  onClose,
  onNavigate,
  comments,
  showAuthorBadges = false,
  onRemoveThread,
  onGenerateThreadPrompt,
  onReplyToThread,
  onRemoveMessage,
  onUpdateMessage,
  syntaxTheme,
  selectable = false,
  selectedIds,
  onToggleSelected,
  onSelectAll,
  onSelectNone,
  onSelectHighSeverity,
  onPostToGitHub,
  postState,
}: CommentsListModalProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const commentRefs = useRef<(HTMLDivElement | null)[]>([]);
  const { enableScope, disableScope } = useHotkeysContext();

  const sortedThreads = [...comments].sort((a, b) => {
    const fileCompare = a.file.localeCompare(b.file);
    if (fileCompare !== 0) return fileCompare;

    const aLine = Array.isArray(a.line) ? a.line[0] : a.line;
    const bLine = Array.isArray(b.line) ? b.line[0] : b.line;
    if (aLine !== bLine) return aLine - bLine;

    return a.createdAt.localeCompare(b.createdAt);
  });

  const handleThreadClick = useCallback(
    (thread: CommentThread) => {
      onNavigate(thread);
      onClose();
    },
    [onClose, onNavigate],
  );

  const handleDeleteThread = useCallback(
    (thread: CommentThread) => {
      const preview = thread.messages[0]?.body || '';
      if (confirm(`Resolve this thread?\n\n"${preview}"`)) {
        onRemoveThread(thread.id);
        if (selectedIndex >= sortedThreads.length - 1 && selectedIndex > 0) {
          setSelectedIndex(selectedIndex - 1);
        }
      }
    },
    [onRemoveThread, selectedIndex, sortedThreads.length],
  );

  useEffect(() => {
    if (isOpen) {
      enableScope('comments-list');
      disableScope('navigation');
    } else {
      enableScope('navigation');
      disableScope('comments-list');
      setSelectedIndex(0);
    }

    return () => {
      enableScope('navigation');
      disableScope('comments-list');
    };
  }, [disableScope, enableScope, isOpen]);

  const hotkeyOptions = { scopes: 'comments-list', enableOnFormTags: false };

  useHotkeys('escape', () => onClose(), hotkeyOptions, [onClose]);

  useHotkeys(
    'j, down',
    () => setSelectedIndex((prev) => Math.min(prev + 1, sortedThreads.length - 1)),
    hotkeyOptions,
    [sortedThreads.length],
  );

  useHotkeys('k, up', () => setSelectedIndex((prev) => Math.max(prev - 1, 0)), hotkeyOptions, []);

  useHotkeys(
    'enter',
    () => {
      if (sortedThreads[selectedIndex]) {
        handleThreadClick(sortedThreads[selectedIndex]);
      }
    },
    hotkeyOptions,
    [handleThreadClick, selectedIndex, sortedThreads],
  );

  useHotkeys(
    'd',
    () => {
      if (sortedThreads[selectedIndex]) {
        handleDeleteThread(sortedThreads[selectedIndex]);
      }
    },
    hotkeyOptions,
    [handleDeleteThread, selectedIndex, sortedThreads],
  );

  useEffect(() => {
    if (commentRefs.current[selectedIndex]) {
      commentRefs.current[selectedIndex]?.scrollIntoView({
        block: 'nearest',
      });
    }
  }, [selectedIndex]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative max-h-[80vh] w-full max-w-4xl overflow-hidden rounded-lg border border-github-border bg-github-bg-primary shadow-lg">
        <div className="sticky top-0 border-b border-github-border bg-github-bg-primary px-6 py-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-github-text-primary">All Comments</h2>
            <button
              onClick={onClose}
              className="text-github-text-secondary transition-colors hover:text-github-text-primary"
              aria-label="Close comments list"
            >
              <X size={20} />
            </button>
          </div>
          <div className="text-xs text-github-text-secondary">
            <span className="font-mono">j/k</span> or <span className="font-mono">↑/↓</span> to
            navigate • <span className="font-mono">Enter</span> to jump •{' '}
            <span className="font-mono">d</span> to resolve • <span className="font-mono">Esc</span>{' '}
            to close
          </div>
          {selectable && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-github-border pt-3">
              <span className="text-xs text-github-text-secondary">
                {selectedIds?.size ?? 0} selected
              </span>
              <button
                type="button"
                onClick={onSelectAll}
                className="rounded border border-github-border bg-github-bg-tertiary px-2 py-0.5 text-xs text-github-text-primary hover:bg-github-bg-primary"
              >
                All
              </button>
              <button
                type="button"
                onClick={onSelectNone}
                className="rounded border border-github-border bg-github-bg-tertiary px-2 py-0.5 text-xs text-github-text-primary hover:bg-github-bg-primary"
              >
                None
              </button>
              <button
                type="button"
                onClick={onSelectHighSeverity}
                className="rounded border border-github-border bg-github-bg-tertiary px-2 py-0.5 text-xs text-github-text-primary hover:bg-github-bg-primary"
              >
                Critical + Important
              </button>
              <button
                type="button"
                onClick={onPostToGitHub}
                disabled={(selectedIds?.size ?? 0) === 0 || postState?.status === 'posting'}
                className="ml-auto rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {postState?.status === 'posting' ? 'Posting…' : 'Post to GitHub'}
              </button>
              {postState?.result && postState.status !== 'posting' && (
                <div className="w-full text-xs">
                  {postState.result.success ? (
                    <span className="text-green-700">
                      ✓ Posted {postState.result.posted} comment(s) as a pending review.{' '}
                      {postState.result.htmlUrl && (
                        <a
                          href={postState.result.htmlUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          Open on GitHub
                        </a>
                      )}
                      {postState.result.skipped.length > 0 &&
                        ` (${postState.result.skipped.length} skipped, out of diff range)`}
                    </span>
                  ) : (
                    <span className="text-github-danger">
                      {postState.result.error ?? 'Failed to post review.'}
                      {postState.result.pendingReviewUrl && (
                        <>
                          {' '}
                          <a
                            href={postState.result.pendingReviewUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="underline"
                          >
                            Open pending review
                          </a>
                        </>
                      )}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="max-h-[calc(80vh-120px)] overflow-y-auto">
          <div className="p-6">
            {sortedThreads.length === 0 ? (
              <p className="text-center text-github-text-secondary">No comments yet</p>
            ) : (
              <>
                <div className="space-y-2">
                  {sortedThreads.map((thread, index) => (
                    <div
                      key={thread.id}
                      ref={(el) => {
                        commentRefs.current[index] = el;
                      }}
                      className={selectedIndex === index ? 'rounded ring-2 ring-blue-500' : ''}
                    >
                      <div className={selectable ? 'flex items-start gap-2' : ''}>
                        {selectable && (
                          <input
                            type="checkbox"
                            className="mt-3 ml-1 shrink-0"
                            checked={selectedIds?.has(thread.id) ?? false}
                            onChange={() => onToggleSelected?.(thread.id)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label="Include this comment in the GitHub review"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <CommentThreadCard
                            thread={thread}
                            showAuthorBadges={showAuthorBadges}
                            confirmRootAction={false}
                            onGeneratePrompt={onGenerateThreadPrompt}
                            onRemoveThread={(threadId) => {
                              if (threadId === thread.id) {
                                handleDeleteThread(thread);
                              }
                            }}
                            onReplyToThread={onReplyToThread}
                            onRemoveMessage={onRemoveMessage}
                            onUpdateMessage={onUpdateMessage}
                            syntaxTheme={syntaxTheme}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedIndex(index);
                              handleThreadClick(thread);
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 border-t border-github-border pt-4 text-center text-xs text-github-text-secondary">
                  {selectedIndex + 1} of {sortedThreads.length} threads
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
