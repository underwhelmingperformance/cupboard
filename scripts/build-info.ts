import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveBuildVersion } from '../packages/cli/src/deploy/build-version.ts';

const root = path.resolve(import.meta.dirname, '..');
const outputPath = path.join(
	root,
	'packages/server/src/build-info.generated.ts'
);

// `pnpm check` runs this script (through `cf:typegen` and the server tests) while
// ESLint and tsc read the output. Write to a unique temp file and rename it into
// place: the rename is atomic, so a reader sees either the complete old file or
// the complete new one, never an empty or half-written file.
const temporaryPath = `${outputPath}.${String(process.pid)}.tmp`;

await writeFile(
	temporaryPath,
	buildInfoSource(await resolveBuildVersion(root))
);
await rename(temporaryPath, outputPath);

function buildInfoSource(version: string): string {
	return `export const buildVersion = ${JSON.stringify(version)};\n`;
}
