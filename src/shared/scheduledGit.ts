export type ScheduledGitAction = 'fetch' | 'pull' | 'refresh';

export type ScheduledGitResult = { status: 'success' } | { status: 'skipped'; reason: string };
