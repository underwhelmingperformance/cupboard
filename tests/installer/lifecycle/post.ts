import assert from 'node:assert/strict';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const directory = process.env.STATE_directory;
if (directory === undefined) {
	throw new Error('The lifecycle fixture lost its action state');
}
try {
	const hook = await readFile(path.join(directory, 'hook'), 'utf8');
	await assert.rejects(access(path.dirname(hook)), { code: 'ENOENT' });
	process.stdout.write(
		'Nested builder action cleanup verified after its post step.\n'
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
