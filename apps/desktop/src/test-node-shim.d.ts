// Minimal ambient typings for the few Node APIs used by test-only fixture
// regeneration. The app tsconfig deliberately stays DOM-only ("types":
// ["vite/client"]); pulling in @types/node wholesale would let node globals
// leak into renderer code, so only what the fixture writer needs is declared.
declare module 'node:fs' {
  export function writeFileSync(path: string | URL, data: string): void;
}

/** Test-runner process env (vitest runs on Node even in the jsdom environment). */
declare const process: { env: Record<string, string | undefined> } | undefined;
