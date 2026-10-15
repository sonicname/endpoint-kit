/**
 * App-wide TanStack Query error typing. Import once (e.g. from your QueryClient module).
 */
import type { RouteError } from '../src/index.js';

import type { NotFoundError, RateLimitedError, UnauthorizedError } from './api.js';

/** Every error the app's routes can produce: the built-ins plus the custom ones. */
export type AppError = RouteError | NotFoundError | UnauthorizedError | RateLimitedError;

/**
 * Make `useQuery(...).error` and `useMutation(...).error` default to `AppError` everywhere,
 * so `error._tag === 'NotFoundError'` narrows without any helper.
 */
declare module '@tanstack/react-query' {
  interface Register {
    defaultError: AppError;
  }
}
