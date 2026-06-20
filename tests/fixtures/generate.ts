import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { withTemporaryDirectory } from '../support/filesystem.ts';
import { collectProcess, runCommand } from '../support/process.ts';

const fixtureDirectory = path.resolve(import.meta.dirname, 'simple');
const sourceDirectory = path.join(fixtureDirectory, 'source');
const narPath = path.join(fixtureDirectory, 'source.nar');
const metadataPath = path.join(fixtureDirectory, 'metadata.json');

const storePathPattern = /^\/nix\/store\/[0-9a-df-np-sv-z]{32}-/;

await mkdir(fixtureDirectory, { recursive: true });

await withTemporaryDirectory(
	'cupboard-fixtures-',
	async (directory) => {
		const storeRoot = path.join(directory, 'store');
		const additionResult = await runCommand('nix-store', [
			'--store',
			`local?root=${storeRoot}`,
			'--add',
			sourceDirectory
		]);
		const storePath = additionResult.stdout.trim();

		if (!storePathPattern.test(storePath)) {
			throw new InvalidStorePathError(storePath);
		}

		const physicalStorePath = path.join(storeRoot, storePath);
		const dump = spawn('nix-store', ['--dump', physicalStorePath], {
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const narHash = createHash('sha256');
		let narSize = 0;
		const hasher = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				narHash.update(chunk);
				narSize += chunk.byteLength;
				callback(undefined, chunk);
			}
		});

		const dumpResultPromise = collectProcess('nix-store', ['--dump'], dump);
		await pipeline(dump.stdout, hasher, createWriteStream(narPath));
		const dumpResult = await dumpResultPromise;

		if (dumpResult.stderr !== '') {
			throw new UnexpectedCommandStderrError('nix-store', dumpResult.stderr);
		}

		await writeFile(
			metadataPath,
			`${JSON.stringify(
				{
					storePath,
					narSize,
					narSha256: narHash.digest('hex')
				},
				undefined,
				2
			)}\n`
		);
	},
	{ makeWritableBeforeCleanup: true }
);

class InvalidStorePathError extends Error {
	readonly storePath: string;

	constructor(storePath: string) {
		super(`Invalid generated store path: ${storePath}`);
		this.name = 'InvalidStorePathError';
		this.storePath = storePath;
	}
}

class UnexpectedCommandStderrError extends Error {
	readonly command: string;
	readonly stderr: string;

	constructor(command: string, stderr: string) {
		super(`Command wrote unexpected stderr: ${command}`);
		this.name = 'UnexpectedCommandStderrError';
		this.command = command;
		this.stderr = stderr;
	}
}
