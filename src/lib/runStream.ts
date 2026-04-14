/**
 * When the DB says `running` and the client reconnects, wait at least this long
 * before opening a new stream so the server can treat the lock as stale.
 * Keep >= Vercel default STALE_RUNNING_MS (25s) in orchestrator + jitter.
 */
export const RUNNING_STREAM_RECONNECT_BASE_MS = 28_000;
export const RUNNING_STREAM_RECONNECT_JITTER_MS = 4_000;
