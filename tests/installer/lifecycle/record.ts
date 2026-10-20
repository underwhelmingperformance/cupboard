import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = process.env.TRIAL_LIFECYCLE_DIRECTORY;
const environmentFile = process.env.GITHUB_ENV;
if (directory === undefined || environmentFile === undefined) {
	throw new Error('The lifecycle fixture was not initialised');
}
async function recordHook(directory: string): Promise<string> {
	const store = process.argv[2];
	if (store === 'local-filesystem') {
		assert.equal(
			process.env.NIX_CONFIG ?? '',
			await readFile(path.join(directory, 'NIX_CONFIG'), 'utf8')
		);
		return '';
	}
	if (store !== 'daemon') {
		throw new Error('The expected store type is required');
	}
	const matches = (process.env.NIX_CONFIG ?? '')
		.matchAll(/^build-hook = (.+)$/gmu)
		.toArray();
	const exported = matches.at(-1)?.[1];
	if (exported === undefined) {
		throw new Error('The composite action did not export its build hook');
	}
	await access(exported);
	return exported;
}
const hook = await recordHook(directory);
await writeFile(path.join(directory, 'hook'), hook);
for (const key of ['NIX_CONFIG', 'NIX_USER_CONF_FILES', 'NIX_SSHOPTS']) {
	const delimiter = randomUUID();
	await appendFile(
		environmentFile,
		`${key}<<${delimiter}\n${await readFile(path.join(directory, key), 'utf8')}\n${delimiter}\n`
	);
}
