import { supabase } from './supabase';
import { BUILD_INFO } from './buildInfo';

// Lightweight, self-hosted instrumentation on top of Supabase — no third-party
// SDK, no native rebuild, no keys. `track` records funnel events; the global
// handler logs JS crashes. Both are fire-and-forget so they never block or
// throw into the app. (Upgrade to Sentry/PostHog later if you want richer data;
// native-level crashes still need Sentry — this catches JS errors.)

// Both synchronous client failures and rejected requests must stay outside
// the user's flow. Do not call logError here: that could recurse indefinitely.
function write(table: 'analytics_events' | 'error_logs', row: Record<string, unknown>): void {
  try {
    void Promise.resolve(supabase.from(table).insert(row)).catch(() => {});
  } catch {
    // Telemetry is best-effort, including while offline or signing out.
  }
}

export function track(event: string, props: Record<string, unknown> = {}): void {
  write('analytics_events', { event, props: { ...props, ...BUILD_INFO } });
}

export function logError(error: unknown, fatal = false, context: Record<string, unknown> = {}): void {
  const e = error as { message?: string; stack?: string } | undefined;
  write('error_logs', {
    message: String(e?.message ?? error ?? 'unknown').slice(0, 500),
    stack: typeof e?.stack === 'string' ? e.stack.slice(0, 4000) : null,
    fatal,
    context: { ...context, ...BUILD_INFO },
  });
}

let installed = false;
/** Route uncaught JS errors to error_logs (keeps the app's own handler too). */
export function installErrorLogging(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as unknown as {
    ErrorUtils?: { getGlobalHandler?: () => (e: unknown, fatal?: boolean) => void; setGlobalHandler?: (h: (e: unknown, fatal?: boolean) => void) => void };
  };
  const prev = g.ErrorUtils?.getGlobalHandler?.();
  g.ErrorUtils?.setGlobalHandler?.((error, isFatal) => {
    logError(error, !!isFatal, { source: 'uncaught' });
    prev?.(error, isFatal);
  });
}
