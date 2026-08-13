import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
	storeDirectorySchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Nix } from '../../packages/nix/src/nix.ts';
import { defaultNixConfigEnvironment } from '../../packages/nix/src/store-config.ts';
import { makeWritable, temporaryRoot } from '../support/filesystem.ts';
import { runCommand } from '../support/process.ts';
import { FakeSubstituter, servedNarSize } from '../support/substituter.ts';

/**
 * A store of this test's own: its own store directory, its own database, and
 * no daemon socket anywhere near it. This is what a tarball install of Nix
 * gives you, and what every GitHub-hosted runner using
 * `nix-quick-install-action` gets.
 */
interface DaemonlessStore {
	readonly root: string;
	readonly storeDirectory: string;
	readonly stateDirectory: string;
	readonly substituter: FakeSubstituter;
	/** A path the store really holds, registered in its database. */
	readonly heldPath: StorePathString;
	/** A path only the substituter holds. */
	readonly offeredPath: StorePathString;
	/** A derivation the store holds, which this store has never built. */
	readonly derivationPath: StorePathString;
	/** The output that derivation names, served only by the substituter. */
	readonly offeredOutput: StorePathString;
}

const fixture: { root?: string; store?: DaemonlessStore } = {};

function store(): DaemonlessStore {
	const prepared = fixture.store;

	if (prepared === undefined) {
		throw new Error('The daemonless store was not prepared');
	}

	return prepared;
}

beforeAll(async () => {
	const root = await mkdtemp(path.join(temporaryRoot, 'cupboard-daemonless-'));
	fixture.root = root;

	const storeDirectory = path.join(root, 'store');
	const stateDirectory = path.join(root, 'state');
	const substituter = await FakeSubstituter.start(
		storeDirectorySchema.parse(storeDirectory)
	);
	const run = (
		command: string,
		arguments_: readonly string[]
	): ReturnType<typeof runCommand> =>
		runCommand(
			command,
			[
				'--store',
				`local?store=${storeDirectory}&state=${stateDirectory}`,
				...arguments_
			],
			{ env: { HOME: root, PATH: process.env.PATH ?? '' } }
		);

	const heldSource = path.join(root, 'held.txt');
	await writeFile(heldSource, 'held by this store\n');
	const { stdout: held } = await run('nix-store', ['--add', heldSource]);

	// A derivation with no inputs, so instantiating it needs nothing this
	// store does not already hold. It is never built here: its output is what
	// the substituter offers.
	const { stdout: derivation } = await run('nix-instantiate', [
		'--expr',
		`derivation { name = "offered"; system = "${nixSystem()}"; ` +
			'builder = "/bin/sh"; args = ["-c" "true"]; }'
	]);
	const { stdout: output } = await run('nix-store', [
		'--query',
		'--outputs',
		derivation.trim()
	]);
	const offeredOutput = storePathSchema.parse(output.trim());
	substituter.servePath(offeredOutput);

	fixture.store = {
		root,
		storeDirectory,
		stateDirectory,
		substituter,
		heldPath: storePathSchema.parse(held.trim()),
		offeredPath: substituter.serve('cupboard-daemonless-offered'),
		derivationPath: storePathSchema.parse(derivation.trim()),
		offeredOutput
	};
}, 60_000);

afterAll(async () => {
	try {
		await fixture.store?.substituter.stop();
	} finally {
		const root = fixture.root;

		if (root !== undefined) {
			await makeWritable(root);
			await rm(root, { force: true, recursive: true });
		}
	}
});

// This store's configuration is the environment above and nothing else, so
// whatever the machine running the test has in its own files stays out.
function noConfigFile(): string | undefined {
	return;
}

// The system this machine builds for, discovered the way Nix discovers it.
function nixSystem(): string {
	const system = defaultNixConfigEnvironment.currentSystem();

	if (system === undefined) {
		throw new Error('Nix names no system for this machine');
	}

	return system;
}

/**
 * Opens the store the way a cohort job does, over an environment naming this
 * test's store and substituter. No daemon socket exists for it, which is the
 * condition under test.
 */
function openStore(overrides: Readonly<Record<string, string>> = {}): Nix {
	const prepared = store();

	return Nix.openForAvailability(
		{
			env: {
				NIX_STORE_DIR: prepared.storeDirectory,
				NIX_STATE_DIR: prepared.stateDirectory,
				NIX_CONFIG: `substituters = ${prepared.substituter.url}`
			},
			readFile: noConfigFile,
			homeDirectory: noConfigFile,
			currentSystem: () => nixSystem(),
			// This store's configuration is the environment above; what the
			// machine running the test offers a build has no bearing on it.
			probes: {
				canReadWrite: () => false,
				fileExists: () => false,
				hasHardwareVirtualisation: () => false,
				isWsl1: () => false,
				microarchitectureLevels: () => []
			},
			canWriteStateDirectory: () => true,
			socketExists: () => false,
			directoryExists: () => true,
			isSuperuser: () => false,
			createDirectory: () => true,
			realpath: (value) => value
		},
		{ overrides }
	);
}

describe('planning against a store with no daemon', () => {
	it('reads the store this process can reach itself', () => {
		expect(openStore().storeKind).toBe('local-filesystem');
	});

	it('reports which paths the store holds, from its own database', async () => {
		await expect(
			openStore().queryValidPaths([store().heldPath, store().offeredPath])
		).resolves.toStrictEqual([store().heldPath]);
	});

	// The substituter is a real HTTP cache advertising a real `nix-cache-info`,
	// and nothing on this machine holds the path it offers, so an answer about
	// it can only have come from asking that cache.
	it('reports which paths the substituter offers, by asking it', async () => {
		const prepared = store();
		const found = await openStore().querySubstitutablePaths([
			prepared.heldPath,
			prepared.offeredPath
		]);

		expect({
			found,
			asked: prepared.substituter.narInfoRequests.length > 0
		}).toStrictEqual({ found: [prepared.offeredPath], asked: true });
	});

	it('partitions a path the substituter offers as one to fetch', async () => {
		const missing = await openStore().queryMissing([store().offeredPath]);

		expect({
			willBuild: missing.willBuild,
			willSubstitute: missing.willSubstitute,
			unknown: missing.unknown
		}).toStrictEqual({
			willBuild: [],
			willSubstitute: [store().offeredPath],
			unknown: []
		});
	});

	it('needs nothing for a path the store already holds', async () => {
		await expect(
			openStore().queryMissing([store().heldPath])
		).resolves.toStrictEqual({
			willBuild: [],
			willSubstitute: [],
			unknown: [],
			downloadSize: 0,
			narSize: 0
		});
	});

	// Reading the derivation is what tells the walk which paths a target
	// produces. It is one regular file in the store directory, and that is
	// where this store reads it.
	it('reads a derivation from the store and fetches the output it names', async () => {
		const missing = await openStore().queryMissing([
			`${store().derivationPath}^out`
		]);

		expect({
			willBuild: missing.willBuild,
			willSubstitute: missing.willSubstitute,
			unknown: missing.unknown
		}).toStrictEqual({
			willBuild: [],
			willSubstitute: [store().offeredOutput],
			unknown: []
		});
	});

	// With nothing offering the output, the derivation is what produces it, so
	// the plan says it must run.
	it('builds a derivation whose output nothing offers', async () => {
		const prepared = store();
		prepared.substituter.withdraw(prepared.offeredOutput);

		try {
			const missing = await openStore().queryMissing([
				`${store().derivationPath}^out`
			]);

			expect({
				willBuild: missing.willBuild,
				willSubstitute: missing.willSubstitute,
				unknown: missing.unknown
			}).toStrictEqual({
				willBuild: [prepared.derivationPath],
				willSubstitute: [],
				unknown: []
			});
		} finally {
			prepared.substituter.servePath(prepared.offeredOutput);
		}
	});

	// A daemon reads an override through the configuration layer, which accepts
	// three spellings for each of a setting's two values. An override reaching
	// a store this process drives is read the same way, so `no` turns
	// substitution off and no substituter is asked anything.
	it.each([
		{ name: 'no', value: 'no' },
		{ name: '0', value: '0' },
		{ name: 'false', value: 'false' }
	])(
		'asks no substituter when a substitute override reads $name',
		async ({ value }) => {
			const prepared = store();
			prepared.substituter.forgetRequests();

			const found = await openStore({
				substitute: value
			}).querySubstitutablePaths([prepared.offeredPath]);

			expect({
				found,
				asked: prepared.substituter.narInfoRequests
			}).toStrictEqual({ found: [], asked: [] });
		}
	);

	// Leaving a target upstream says a consumer can fetch what this store has.
	// The substituter serves a path of that name under bytes of its own, so
	// the walk that decides it compares the two hashes and refuses.
	it('refuses a closure a substituter offers under different bytes', async () => {
		const prepared = store();
		const offered = prepared.substituter.servePath(prepared.heldPath);
		const info = await openStore().queryPathInfo(prepared.heldPath);

		try {
			await expect(
				openStore().resolveSubstitutableClosure(prepared.heldPath)
			).resolves.toStrictEqual({
				kind: 'divergent',
				storePath: prepared.heldPath,
				held: info.narHash.toString(),
				offered: offered.toString()
			});
		} finally {
			prepared.substituter.withdraw(prepared.heldPath);
		}
	});

	// The same path offered under the hash this store recorded for it is one a
	// consumer really can fetch, so the walk confirms it.
	it('proves a closure a substituter offers under the bytes this store holds', async () => {
		const prepared = store();
		const info = await openStore().queryPathInfo(prepared.heldPath);
		prepared.substituter.servePath(prepared.heldPath, info.narHash);

		try {
			await expect(
				openStore().resolveSubstitutableClosure(prepared.heldPath)
			).resolves.toStrictEqual({
				kind: 'served',
				pathCount: 1,
				downloadSize: servedNarSize,
				narSize: servedNarSize
			});
		} finally {
			prepared.substituter.withdraw(prepared.heldPath);
		}
	});

	it('reports a path nobody holds as unknown', async () => {
		const absent = storePathSchema.parse(
			`${store().storeDirectory}/${'a'.repeat(32)}-absent`
		);

		const missing = await openStore().queryMissing([absent]);

		expect({
			willSubstitute: missing.willSubstitute,
			unknown: missing.unknown
		}).toStrictEqual({ willSubstitute: [], unknown: [absent] });
	});
});
