/**
 * Apply an alternative dataset over the business tables.
 *
 *   npx tsx scripts/seed.ts seeds/<name>.sql
 *   npx tsx scripts/seed.ts seeds/<name>.sql --reset-agent
 *   npx tsx scripts/seed.ts --help
 *
 * Three lines, on purpose. `tsconfig.json` has `"include": ["src"]`, so nothing in this
 * directory is read by `npm run typecheck` and nothing under it is collected by vitest
 * (`include: ['src/**\/*.test.ts']`). A swap that empties five tables is not code to
 * keep outside both, so the whole of it — the order of the statements, the refusals, the
 * report — lives in `src/seed.ts` next to its tests, and this file only decides where
 * argv comes from and where the exit code goes.
 *
 * `process.exitCode` rather than `process.exit()`: the second kills the process mid-write,
 * so the refusal explaining WHY it exited can be truncated or lost entirely on a piped
 * stdout. Setting the code lets Node exit once the streams have drained.
 */

import { main, nodeDeps } from '../src/seed';

process.exitCode = await main(process.argv.slice(2), nodeDeps());
