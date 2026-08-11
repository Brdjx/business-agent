import { defineConfig } from 'vitest/config';

/**
 * Minimal on purpose.
 *
 * The unit suite covers the parts that must hold without a model or a
 * database — budgets, argument validation, trace shaping, proposal
 * preconditions. Anything that spends money or needs live records is a script,
 * not a test, because a suite that costs a dollar to run stops being run.
 */
export default defineConfig({
  test: {
    // No DOM. The default of a browser-shaped environment would hand these
    // tests a `window` that nothing in src/ has, so a file that accidentally
    // depends on one would pass here and fail everywhere else.
    environment: 'node',

    // Tests live beside the code they test, and the pattern says so. A broad
    // default would also collect anything under db/ or docs/ that happens to
    // match.
    include: ['src/**/*.test.ts'],

    // Paired with "types": ["vitest/globals"] in tsconfig.json. Turning this
    // off without removing that leaves tests which typecheck and then throw
    // "describe is not defined"; the two settings change together or not at
    // all.
    globals: true,
  },
});
