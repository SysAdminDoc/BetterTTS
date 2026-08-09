/**
 * Renderer-only replacement for ephone's unreachable Node fallback import.
 * The browser path never calls createRequire; keeping the shim explicit avoids
 * Vite's browser-external placeholder and its misleading build warning.
 */
export function createRequire(): never {
  throw new Error('Node module loading is unavailable in the browser renderer.')
}
