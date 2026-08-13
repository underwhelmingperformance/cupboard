import process from 'node:process';
import type { DatabaseSync } from 'node:sqlite';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storeDirectorySchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { describe, expect, it, vi } from 'vitest';

import {
	NixLocalStoreClient,
	type NixStoreDatabase,
	nixStoreDatabaseFromSqlite,
	type NixStoreRow
} from './nix-local-store.ts';
import {
	InvalidNixStorePathError,
	NixStorePathNotFoundError,
	type NixValidPathInfo,
	UnsupportedNixStoreOperationError
} from './nix-store.ts';
import { openSubstituters, SubstituterClient } from './substituter.ts';

const pathA = storePathSchema.parse(
	'/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-a'
);
const pathB = storePathSchema.parse(
	'/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-b'
);
const missingPath = storePathSchema.parse(
	'/nix/store/cccccccccccccccccccccccccccccccc-missing'
);
const hashA = `sha256:${'aa'.repeat(32)}`;
const hashB = `sha256:${'bb'.repeat(32)}`;
const deriverA = storePathSchema.parse(
	'/nix/store/dddddddddddddddddddddddddddddddd-a.drv'
);
const missingDrvPath = storePathSchema.parse(
	'/nix/store/ffffffffffffffffffffffffffffffff-missing.drv'
);
const sigsA = 'cache-1:sigaaa cache-2:sigbbb';
const caB = 'fixed:r:sha256:deadbeef';

const rowA: NixStoreRow = {
	id: 1,
	hash: hashA,
	narSize: 100,
	deriver: deriverA,
	ultimate: true,
	sigs: sigsA,
	ca: undefined
};

const rowB: NixStoreRow = {
	id: 2,
	hash: hashB,
	narSize: 50,
	deriver: undefined,
	ultimate: false,
	sigs: undefined,
	ca: caB
};

const referencesA = [pathA, pathB];
const referencesB = [pathB];

const referencesById: ReadonlyMap<number, readonly string[]> = new Map([
	[1, referencesA],
	[2, referencesB]
]);

const rowsByPath: Readonly<Record<string, NixStoreRow>> = {
	[pathA]: rowA,
	[pathB]: rowB
};

function fakeDatabase(): NixStoreDatabase {
	return {
		pathRow: (storePath) => rowsByPath[storePath],
		references: (id) => referencesById.get(id) ?? [],
		validPaths: (storePaths) =>
			storePaths.filter((storePath) => rowsByPath[storePath] !== undefined),
		derivationOutputs: (drvPaths) =>
			drvPaths.includes(deriverA) ? [pathA] : [],
		close: vi.fn()
	};
}

const infoA: NixValidPathInfo = {
	storePath: pathA,
	narHash: NixSha256Hash.parsePrefixed(hashA),
	narSize: 100,
	references: referencesA,
	signatures: ['cache-1:sigaaa', 'cache-2:sigbbb'],
	ultimate: true,
	deriver: deriverA
};

const infoB: NixValidPathInfo = {
	storePath: pathB,
	narHash: NixSha256Hash.parsePrefixed(hashB),
	narSize: 50,
	references: referencesB,
	signatures: [],
	ultimate: false,
	ca: caB
};

describe('NixLocalStoreClient', () => {
	const client = new NixLocalStoreClient(fakeDatabase);

	it('resolves a closure, following and de-duplicating references', async () => {
		await expect(client.resolveClosure([pathA])).resolves.toStrictEqual([
			infoA,
			infoB
		]);
	});

	it('queries a single path', async () => {
		await expect(client.queryPathInfo(pathB)).resolves.toStrictEqual(infoB);
	});

	it('throws for a path that is not in the store', async () => {
		await expect(client.queryPathInfo(missingPath)).rejects.toThrow(
			NixStorePathNotFoundError
		);
	});

	it('queries registered paths without loading their metadata', async () => {
		await expect(
			client.queryValidPaths([missingPath, pathB, pathB, pathA])
		).resolves.toStrictEqual([pathA, pathB]);
	});

	it('queries several paths through one database view', async () => {
		await expect(client.queryPathsInfo([pathB, pathA])).resolves.toStrictEqual([
			infoB,
			infoA
		]);
	});

	it('rejects a batch containing an unregistered path', async () => {
		await expect(client.queryPathsInfo([pathA, missingPath])).rejects.toThrow(
			NixStorePathNotFoundError
		);
	});

	it('filters unregistered paths from a valid-path-info batch', async () => {
		await expect(
			client.queryValidPathsInfo([missingPath, pathB])
		).resolves.toStrictEqual([infoB]);
	});

	it('queries registered outputs by their deriver', async () => {
		await expect(
			client.queryDerivationOutputPaths([missingDrvPath, deriverA, deriverA])
		).resolves.toStrictEqual([pathA]);
	});

	it('cannot stream a NAR without a daemon', () => {
		expect(() => client.narFromPath(pathA)).toThrow(
			UnsupportedNixStoreOperationError
		);
	});

	it.each([
		{
			name: 'substituters, with none configured',
			operation: 'substitutable-path queries',
			query: () => client.querySubstitutablePaths([pathA])
		},
		{
			name: 'a realisation partition, with no substituters configured',
			operation: 'missing-path queries',
			query: () => client.queryMissing([pathA])
		},
		{
			name: 'a build request',
			operation: 'build requests',
			query: () => client.buildPathsWithResults([pathA])
		}
	])('cannot answer for $name here', async ({ operation, query }) => {
		let outcome:
			{ value: unknown } | { error: { name: string; operation: string } };
		try {
			const value = await query();
			outcome = { value };
		} catch (error_: unknown) {
			expect(error_).toBeInstanceOf(UnsupportedNixStoreOperationError);

			if (!(error_ instanceof UnsupportedNixStoreOperationError)) {
				throw error_;
			}

			outcome = {
				error: { name: error_.name, operation: error_.operation }
			};
		}

		expect(outcome).toStrictEqual({
			error: {
				name: 'UnsupportedNixStoreOperationError',
				operation
			}
		});
	});

	// The store database holds the references, so a row that does not name a
	// store path is refused at the read rather than carried into the closure.
	it('refuses a reference that does not name a store path', async () => {
		const brokenReferences = new NixLocalStoreClient(() => ({
			pathRow: (storePath) => rowsByPath[storePath],
			references: () => ['/nix/store/notes.txt'],
			validPaths: () => [],
			derivationOutputs: () => [],
			close: vi.fn()
		}));

		await expect(brokenReferences.queryPathInfo(pathA)).rejects.toThrow(
			InvalidNixStorePathError
		);
	});

	// A store the system diverted elsewhere reads the same way the default one
	// does: the store directory is discovered, never assumed to be `/nix/store`.
	it('reads a path and its references from a diverted store directory', async () => {
		const divertedPath = storePathSchema.parse(
			'/home/u/.local/share/nix/root/store/dddddddddddddddddddddddddddddddd-a'
		);
		const diverted = new NixLocalStoreClient(() => ({
			pathRow: (storePath) => (storePath === divertedPath ? rowA : undefined),
			references: () => [divertedPath],
			validPaths: () => [],
			derivationOutputs: () => [],
			close: vi.fn()
		}));

		await expect(
			diverted.resolveClosure([divertedPath])
		).resolves.toStrictEqual([
			{ ...infoA, storePath: divertedPath, references: [divertedPath] }
		]);
	});

	// A derivation is one regular file in the store, so the local store reads
	// it where it sits.
	it('reads a derivation from the file the store directory holds', async () => {
		const aterm = 'Derive([],[],[],"aarch64-linux","builder",[],[])';
		const read = vi.fn(() => Promise.resolve(aterm));
		const client = new NixLocalStoreClient(() => emptyDatabase(), {
			storeDirectory: storeDirectorySchema.parse('/nix/store'),
			readStoreFile: read
		});

		const contents = await client.readDerivation(deriverA);

		expect({ contents, calls: read.mock.calls }).toStrictEqual({
			contents: aterm,
			calls: [[deriverA]]
		});
	});

	it('refuses a derivation the store directory does not hold', async () => {
		const client = new NixLocalStoreClient(() => emptyDatabase(), {
			storeDirectory: storeDirectorySchema.parse('/nix/store'),
			readStoreFile: () => Promise.reject(new Error('ENOENT'))
		});

		await expect(client.readDerivation(missingDrvPath)).rejects.toThrow(
			NixStorePathNotFoundError
		);
	});
});

// Configured substituters are what the availability questions are asked of,
// so a store given them answers all three the way a daemon-backed one does.
describe('NixLocalStoreClient with substituters', () => {
	const cacheInfo = 'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n';
	const narInfo = [
		`StorePath: ${pathB}`,
		'URL: nar/bbbb.nar.xz',
		'Compression: xz',
		`FileHash: sha256:${'11'.repeat(32)}`,
		'FileSize: 400',
		`NarHash: ${hashB}`,
		'NarSize: 50',
		'References: '
	].join('\n');

	const served = servedBy(cacheInfo, narInfo);

	function clientOver(): NixLocalStoreClient {
		const substituters = new SubstituterClient(
			() => openSubstituters(['https://cache.example'], { fetch: served }),
			{
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				substitute: true,
				fallback: false,
				fetch: served
			}
		);

		return new NixLocalStoreClient(() => emptyDatabase(), { substituters });
	}

	it('reports which paths the substituters offer', async () => {
		await expect(
			clientOver().querySubstitutablePaths([pathA, pathB])
		).resolves.toStrictEqual([pathB]);
	});

	it('reports what the substituters offer for a path', async () => {
		await expect(
			clientOver().querySubstitutablePathInfos([pathB])
		).resolves.toStrictEqual([
			{
				storePath: pathB,
				references: [],
				downloadSize: 400,
				narSize: 50
			}
		]);
	});

	it('partitions a realisation over what the substituters hold', async () => {
		await expect(clientOver().queryMissing([pathB])).resolves.toStrictEqual({
			willBuild: [],
			willSubstitute: [pathB],
			unknown: [],
			downloadSize: 400,
			narSize: 50
		});
	});
});

/** A cache serving the given `nix-cache-info` and one narinfo. */
function servedBy(cacheInfo: string, narInfo: string): typeof fetch {
	return (input) => {
		const url = new URL(input instanceof Request ? input.url : String(input));

		if (url.pathname === '/nix-cache-info') {
			return Promise.resolve(new Response(cacheInfo));
		}

		return Promise.resolve(
			url.pathname === `/${'b'.repeat(32)}.narinfo`
				? new Response(narInfo)
				: new Response('', { status: 404 })
		);
	};
}

function emptyDatabase(): NixStoreDatabase {
	return {
		pathRow: () => rowsByPath.none,
		references: () => [],
		validPaths: () => [],
		derivationOutputs: () => [],
		close: vi.fn()
	};
}

function seededDatabase(): DatabaseSync {
	const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
	const database = new DatabaseSync(':memory:');

	database
		.prepare(
			`create table ValidPaths (
				id integer primary key, path text unique not null, hash text not null,
				registrationTime integer not null, deriver text, narSize integer,
				ultimate integer, sigs text, ca text
			)`
		)
		.run();
	database
		.prepare(
			'create table Refs (referrer integer not null, reference integer not null)'
		)
		.run();
	database
		.prepare(
			`create table DerivationOutputs (
				drv integer not null, id text not null, path text not null,
				primary key (drv, id)
			)`
		)
		.run();

	// Each row leaves a different column NULL by omitting it, so the adapter is
	// exercised on an absent deriver, ultimate, sigs and ca.
	database
		.prepare(
			'insert into ValidPaths (id, path, hash, registrationTime, deriver, narSize, ultimate, sigs) values (?, ?, ?, ?, ?, ?, ?, ?)'
		)
		.run(1, pathA, hashA, 0, deriverA, 100, 1, sigsA);
	database
		.prepare(
			'insert into ValidPaths (id, path, hash, registrationTime, narSize, ca) values (?, ?, ?, ?, ?, ?)'
		)
		.run(2, pathB, hashB, 0, 50, caB);
	database
		.prepare(
			'insert into ValidPaths (id, path, hash, registrationTime) values (?, ?, ?, ?)'
		)
		.run(3, deriverA, hashA, 0);
	database
		.prepare('insert into DerivationOutputs (drv, id, path) values (?, ?, ?)')
		.run(3, 'out', pathA);

	const insertReference = database.prepare(
		'insert into Refs (referrer, reference) values (?, ?)'
	);
	insertReference.run(1, 1);
	insertReference.run(1, 2);
	insertReference.run(2, 2);

	return database;
}

describe('nixStoreDatabaseFromSqlite', () => {
	it('reads rows and references from a real in-memory store database', () => {
		const database = nixStoreDatabaseFromSqlite(seededDatabase());

		try {
			expect(database.pathRow(pathA)).toStrictEqual(rowA);
			expect(database.pathRow(pathB)).toStrictEqual(rowB);
			expect(database.pathRow('/nix/store/missing')).toBeUndefined();
			expect(database.references(1)).toStrictEqual([pathA, pathB]);
			expect(database.validPaths([missingPath, pathB, pathA])).toStrictEqual([
				pathA,
				pathB
			]);
			expect(database.validPaths([])).toStrictEqual([]);
			expect(
				database.derivationOutputs([missingDrvPath, deriverA, deriverA])
			).toStrictEqual([pathA]);
			expect(database.derivationOutputs([missingDrvPath])).toStrictEqual([]);
		} finally {
			database.close();
		}
	});
});
