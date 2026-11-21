import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { byCodeUnit, storePathHashOf } from '@cupboard/nix-store/store-path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';

import { lockedSourcePath } from '../../actions/src/flake-input-sources.ts';
import { makeWritable, temporaryRoot } from '../support/filesystem.ts';
import {
	type LoopbackServer,
	loopbackServer
} from '../support/loopback-server.ts';
import { isolatedEnvironment } from '../support/nix.ts';
import { runCommand } from '../support/process.ts';

import { describeConformance, type Oracle } from './oracle.ts';

/**
A flake with a `tarball` input and a `file` input, locked against a loopback
origin, and two local binary caches without a signing key. `cache` contains
both inputs' sources as `nix copy` wrote them. `poisoned` contains the `file`
input's source, and a narinfo at the `tarball` input's source path with that
path's content address and the NAR of other contents.
*/
interface Fixture {
	readonly root: string;
	readonly origin: LoopbackServer;
	readonly flake: string;
	readonly cache: string;
	readonly poisoned: string;
	/**
	Each input's source path, as `nix flake archive` reports it.
	*/
	readonly archivePaths: Readonly<Record<'source' | 'name', string>>;
}

class FixtureCommandFailedError extends Error {
	constructor(
		public readonly command: string,
		public readonly stderr: string
	) {
		super(`preparing the flake input fixture failed: ${command}`);
		this.name = 'FixtureCommandFailedError';
	}
}

const archivedInputSchema = z.object({ path: z.string() });

const archiveSchema = z.object({
	inputs: z.object({ source: archivedInputSchema, name: archivedInputSchema })
});

const lockedInputSchema = z.object({
	locked: z.object({ narHash: z.string() })
});

const flakeLockSchema = z.object({
	nodes: z.object({ source: lockedInputSchema, name: lockedInputSchema })
});

const pathInfoEntrySchema = z.object({
	signatures: z.array(z.string()).optional()
});

const pathInfoSchema = z.record(z.string(), pathInfoEntrySchema);

async function run(
	oracle: Oracle,
	arguments_: readonly string[],
	environment: NodeJS.ProcessEnv
): Promise<string> {
	const result = await oracle.run(arguments_, { env: environment });

	if (result.status !== 0) {
		throw new FixtureCommandFailedError(arguments_.join(' '), result.stderr);
	}

	return result.stdout.trim();
}

async function writeTree(directory: string, greeting: string): Promise<string> {
	await mkdir(directory, { recursive: true });
	await writeFile(path.join(directory, 'greeting'), greeting);

	return directory;
}

function narInfoPath(cache: string, storePath: string): string {
	return path.join(cache, `${storePathHashOf(storePath) ?? ''}.narinfo`);
}

async function removeTree(root: string): Promise<void> {
	// Nix makes the directories of store paths read-only.
	await makeWritable(root);
	await rm(root, { force: true, recursive: true });
}

async function createFixture(oracle: Oracle): Promise<Fixture> {
	const root = await mkdtemp(
		path.join(temporaryRoot, 'cupboard-conformance-flake-input-')
	);
	let origin: LoopbackServer | undefined;

	try {
		const tarball = await writeTarball(root);
		origin = await loopbackServer((request, response) => {
			if (request.url === '/source.tar.gz') {
				response.writeHead(200, { 'content-type': 'application/gzip' });
				response.end(tarball);
				return;
			}

			if (request.url === '/name.txt') {
				response.writeHead(200, { 'content-type': 'text/plain' });
				response.end('world');
				return;
			}

			response.writeHead(404).end();
		});

		return await populateFixture(oracle, root, origin);
	} catch (error) {
		await origin?.close();
		await removeTree(root);
		throw error;
	}
}

async function writeTarball(root: string): Promise<Buffer> {
	await writeTree(path.join(root, 'source'), 'hello');
	await runCommand('tar', [
		'-czf',
		path.join(root, 'source.tar.gz'),
		'-C',
		root,
		'source'
	]);

	return readFile(path.join(root, 'source.tar.gz'));
}

async function populateFixture(
	oracle: Oracle,
	root: string,
	origin: LoopbackServer
): Promise<Fixture> {
	const flake = path.join(root, 'flake');
	await mkdir(flake);
	await writeFile(
		path.join(flake, 'flake.nix'),
		[
			'{',
			`  inputs.source = { url = "${origin.origin}/source.tar.gz"; flake = false; };`,
			`  inputs.name = { type = "file"; url = "${origin.origin}/name.txt"; flake = false; };`,
			'  outputs = { source, name, ... }: {',
			'    greeting = "${builtins.readFile "${source}/greeting"} ${builtins.readFile name}";',
			'  };',
			'}',
			''
		].join('\n')
	);

	const environment = await isolatedEnvironment(
		path.join(root, 'producer-home')
	);
	const store = `local?root=${path.join(root, 'producer')}`;
	await run(oracle, ['flake', 'lock', flake, '--store', store], environment);
	const archive = archiveSchema.parse(
		JSON.parse(
			await run(
				oracle,
				['flake', 'archive', '--json', '--dry-run', flake, '--store', store],
				environment
			)
		)
	);
	const sourcePath = archive.inputs.source.path;
	const namePath = archive.inputs.name.path;
	const cache = path.join(root, 'cache');
	await run(
		oracle,
		[
			'copy',
			'--store',
			store,
			'--to',
			`file://${cache}?compression=none`,
			sourcePath,
			namePath
		],
		environment
	);

	const otherPath = await run(
		oracle,
		[
			'store',
			'add',
			'--store',
			store,
			'--mode',
			'nar',
			'--name',
			'source',
			await writeTree(path.join(root, 'other'), 'poisoned')
		],
		environment
	);
	const poisoned = path.join(root, 'poisoned');
	await run(
		oracle,
		[
			'copy',
			'--store',
			store,
			'--to',
			`file://${poisoned}?compression=none`,
			otherPath,
			namePath
		],
		environment
	);
	await writePoisonedNarInfo(cache, poisoned, sourcePath, otherPath);

	return {
		root,
		origin,
		flake,
		cache,
		poisoned,
		archivePaths: { source: sourcePath, name: namePath }
	};
}

// Takes the narinfo of `otherPath` and moves it to `sourcePath`, with the
// content address of `sourcePath`. Nix accepts the narinfo without a
// signature, because its content address produces its store path, and the
// NAR then fails the content-address check.
async function writePoisonedNarInfo(
	cache: string,
	poisoned: string,
	sourcePath: string,
	otherPath: string
): Promise<void> {
	const source = await readFile(narInfoPath(cache, sourcePath), 'utf8');
	const sourceCa = source.split('\n').find((line) => line.startsWith('CA: '));
	const other = await readFile(narInfoPath(poisoned, otherPath), 'utf8');
	const lines = other
		.split('\n')
		.filter((line) => line !== '' && !line.startsWith('CA: '))
		.map((line) =>
			line.startsWith('StorePath: ') ? `StorePath: ${sourcePath}` : line
		);

	await writeFile(
		narInfoPath(poisoned, sourcePath),
		`${[...lines, sourceCa ?? ''].join('\n')}\n`
	);
	await rm(narInfoPath(poisoned, otherPath));
}

const prepared: { fixture?: Fixture } = {};

class FlakeInputFixtureNotPreparedError extends Error {
	constructor() {
		super('the flake input fixture was not prepared');
		this.name = 'FlakeInputFixtureNotPreparedError';
	}
}

function fixture(): Fixture {
	if (prepared.fixture === undefined) {
		throw new FlakeInputFixtureNotPreparedError();
	}

	return prepared.fixture;
}

describeConformance('substituting a locked flake input', (oracle) => {
	beforeAll(async () => {
		prepared.fixture = await createFixture(oracle);
	});

	afterAll(async () => {
		const current = prepared.fixture;
		prepared.fixture = undefined;

		if (current === undefined) {
			return;
		}

		await current.origin.close();
		await removeTree(current.root);
	});

	// Each case evaluates in a fresh store and home, as a fresh runner does, with
	// only the given substituters: a local binary cache without a signing key,
	// or none.
	async function evaluate(name: string, substituters: string) {
		const current = fixture();
		const environment = await isolatedEnvironment(
			path.join(current.root, `${name}-home`)
		);
		const store = `local?root=${path.join(current.root, name)}`;
		const earlierRequests = current.origin.requests.length;
		const result = await oracle.run(
			[
				'eval',
				'--raw',
				`${current.flake}#greeting`,
				'--store',
				store,
				'--option',
				'substituters',
				substituters,
				'--option',
				'trusted-public-keys',
				''
			],
			{ env: environment }
		);

		return {
			store,
			environment,
			outcome: {
				status: result.status,
				stdout: result.stdout,
				originRequests: current.origin.requests
					.slice(earlierRequests)
					.map((request) => `${request.method} ${request.url}`)
					.toSorted(byCodeUnit)
			}
		};
	}

	// The cache selection looks for each input's source at the path that
	// `lockedSourcePath` computes from the lock, and keeps only a path without
	// signatures. An evaluation that fetches the inputs from their origin must
	// leave them at that path, unsigned.
	it('leaves each source unsigned at the path that the lock gives', async () => {
		const current = fixture();
		const { store, environment, outcome } = await evaluate('fresh', '');
		const lockText = await readFile(
			path.join(current.flake, 'flake.lock'),
			'utf8'
		);
		const lock = flakeLockSchema.parse(JSON.parse(lockText));
		const lockedPaths = {
			source: lockedSourcePath(lock.nodes.source.locked, '/nix/store'),
			name: lockedSourcePath(lock.nodes.name.locked, '/nix/store')
		};
		const pathInfo = pathInfoSchema.parse(
			JSON.parse(
				await run(
					oracle,
					[
						'path-info',
						'--json',
						'--store',
						store,
						current.archivePaths.source,
						current.archivePaths.name
					],
					environment
				)
			)
		);
		const signatures = Object.fromEntries(
			Object.entries(pathInfo).map(([storePath, info]) => [
				storePath,
				info.signatures ?? []
			])
		);

		expect({ outcome, lockedPaths, signatures }).toStrictEqual({
			outcome: {
				status: 0,
				stdout: 'hello world',
				originRequests: ['GET /name.txt', 'GET /source.tar.gz']
			},
			lockedPaths: current.archivePaths,
			signatures: {
				[current.archivePaths.source]: [],
				[current.archivePaths.name]: []
			}
		});
	});

	it('takes the sources from the cache without asking their origin', async () => {
		const { outcome } = await evaluate('consumer', `file://${fixture().cache}`);

		expect(outcome).toStrictEqual({
			status: 0,
			stdout: 'hello world',
			originRequests: []
		});
	});

	it('fetches from the origin when the cached NAR fails its content address', async () => {
		const { outcome } = await evaluate(
			'poisoned-consumer',
			`file://${fixture().poisoned}`
		);

		expect(outcome).toStrictEqual({
			status: 0,
			stdout: 'hello world',
			originRequests: ['GET /source.tar.gz']
		});
	});
});
