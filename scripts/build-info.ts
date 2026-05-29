import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const outputPath = path.join(
	root,
	'packages/server/src/build-info.generated.ts'
);

await writeFile(outputPath, buildInfoSource(await gitVersion()));

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
