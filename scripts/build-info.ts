import { execFile } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const outputPath = path.join(
	root,
	'packages/server/src/build-info.generated.ts'
);

// `pnpm check` runs this script (through `cf:typegen` and the server tests) while
// eslint and tsc read the output. Write to a unique temp file and rename it into
// place: the rename is atomic, so a reader sees either the complete old file or
// the complete new one, never an empty or half-written file.
const temporaryPath = `${outputPath}.${String(process.pid)}.tmp`;

await writeFile(temporaryPath, buildInfoSource(await gitVersion()));
await rename(temporaryPath, outputPath);

async function gitVersion(): Promise<string> {
	const revision = await gitOutput(['rev-parse', '--short=12', 'HEAD']);
	const status = await gitOutput(['status', '--porcelain']);

	if (status === '') {
		return revision;
	}

	return `${revision}+dirty`;
}

async function gitOutput(gitArguments: readonly string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', gitArguments, {
		cwd: root
	});

	return stdout.trim();
}

function buildInfoSource(version: string): string {
	return `export const buildVersion = ${JSON.stringify(version)};\n`;
}
