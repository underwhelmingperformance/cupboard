import { constants } from 'node:fs';
import { access, appendFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { requireEnvironment } from '../inputs.ts';

async function main(): Promise<void> {
	const result = process.argv[2];
	const command = process.argv[3];
	if (result === undefined || command === undefined) {
		throw new Error(
			'The build-hook probe requires a result path and an executable'
		);
	}
	await writeFile(result, 'started\n');
	const candidates = command.includes('/')
		? [path.resolve(command)]
		: requireEnvironment(process.env, 'PATH')
				.split(path.delimiter)
				.map((directory) => path.resolve(directory, command));
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
			const metadata = await stat(candidate);
			if (!metadata.isFile()) {
				continue;
			}
			await appendFile(result, candidate);
			process.stderr.write('# decline-permanently\n');
			return;
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!('code' in error) ||
				!['ENOENT', 'EACCES', 'ENOTDIR'].includes(String(error.code))
			) {
				throw error;
			}
		}
	}
}

void main().catch((error: unknown) => {
	process.stderr.write(`${String(error)}\n`);
	process.exitCode = 1;
});
