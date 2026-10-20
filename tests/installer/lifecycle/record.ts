import { randomUUID } from 'node:crypto';
import { access, appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = process.env.TRIAL_LIFECYCLE_DIRECTORY;
const environmentFile = process.env.GITHUB_ENV;
if (directory === undefined || environmentFile === undefined) {
	throw new Error('The lifecycle fixture was not initialised');
}
const matches = (process.env.NIX_CONFIG ?? '')
	.matchAll(/^build-hook = (.+)$/gmu)
	.toArray();
const hook = matches.at(-1)?.[1];
if (hook === undefined) {
	throw new Error('The composite action did not export its build hook');
}
await access(hook);
await writeFile(path.join(directory, 'hook'), hook);
for (const key of ['NIX_CONFIG', 'NIX_USER_CONF_FILES', 'NIX_SSHOPTS']) {
	const delimiter = randomUUID();
	await appendFile(
		environmentFile,
		`${key}<<${delimiter}\n${await readFile(path.join(directory, key), 'utf8')}\n${delimiter}\n`
	);
}
