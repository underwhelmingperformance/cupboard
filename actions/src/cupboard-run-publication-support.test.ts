import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hasPublicationResultSupport } from './cupboard-run.ts';

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

async function executable(stdout: string, stderr = '', status = 0) {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-hidden-help-'));
	directories.push(directory);
	const binary = path.join(directory, 'cupboard.cjs');
	const argvFile = path.join(directory, 'argv.json');
	await writeFile(
		binary,
		`#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write(${JSON.stringify(stderr)});
process.exit(${String(status)});
`
	);
	await chmod(binary, 0o755);
	return { binary, argvFile };
}

describe('publication-result hidden-command help detection', () => {
	it('probes the hidden command itself, not top-level help', async () => {
		const { binary, argvFile } = await executable(
			'Usage: cupboard publication-result [options] <url>\n  --request-file <path>  JSON workflow request\n'
		);
		await expect(hasPublicationResultSupport(binary)).resolves.toBe(true);
		expect(JSON.parse(await readFile(argvFile, 'utf8'))).toEqual([
			'publication-result',
			'--help'
		]);
	});

	it('accepts only an explicit old-parser unknown-command rejection as non-support', async () => {
		const { binary } = await executable(
			'',
			"error: unknown command 'publication-result'\n",
			2
		);
		await expect(hasPublicationResultSupport(binary)).resolves.toBe(false);
	});

	it.each([
		['Usage: cupboard [options] [command]\n', '', 0],
		['Usage: cupboard publication-result [options] <url>\n', '', 0],
		['', 'error: authentication provider unavailable\n', 2],
		['', "error: unknown command 'publication-result'\n", 1]
	])(
		'rejects malformed help and operational failure (%s)',
		async (stdout, stderr, status) => {
			const { binary } = await executable(stdout, stderr, status);
			await expect(hasPublicationResultSupport(binary)).rejects.toThrow(
				'unexpected publication-result help'
			);
		}
	);

	it('does not disguise a missing executable as an old CLI', async () => {
		await expect(
			hasPublicationResultSupport('/nonexistent/cupboard')
		).rejects.toThrow();
	});
});
