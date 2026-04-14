/** Serializable parts of an unknown throw value for logs and persistence. */
export type ErrorLogParts = {
  message: string;
  stack?: string;
  errorName?: string;
};

export function errorToLogParts(e: unknown): ErrorLogParts {
  if (e instanceof Error) {
    return {
      message: e.message?.trim() ? e.message : e.name || "Error",
      stack: e.stack,
      errorName: e.name,
    };
  }
  if (typeof e === "string") {
    return { message: e };
  }
  try {
    return { message: JSON.stringify(e) };
  } catch {
    return { message: String(e) };
  }
}

/** Emit to stdout (e.g. Vercel function logs). */
export function logServerError(
  scope: string,
  e: unknown,
  extra?: Record<string, unknown>,
): ErrorLogParts {
  const parts = errorToLogParts(e);
  console.error(`[${scope}]`, parts.message, {
    errorName: parts.errorName,
    ...extra,
  });
  if (parts.stack) {
    console.error(parts.stack);
  }
  return parts;
}

/** Format for StrategyRun.error (short message + stack for copy/paste). */
export function formatRunErrorField(parts: ErrorLogParts): string {
  if (parts.stack) {
    return `${parts.message}\n\n${parts.stack}`;
  }
  return parts.message;
}

/** Split a stored run error field back into message + stack. */
export function parseStoredRunError(stored: string): ErrorLogParts {
  const sep = "\n\n";
  const i = stored.indexOf(sep);
  if (i >= 0) {
    return {
      message: stored.slice(0, i).trim(),
      stack: stored.slice(i + sep.length).trim(),
    };
  }
  return { message: stored.trim() };
}
