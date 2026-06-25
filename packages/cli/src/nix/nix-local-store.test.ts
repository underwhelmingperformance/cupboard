import process from 'node:process';
import type { DatabaseSync } from 'node:sqlite';

import { NixSha256Hash } from '@cupboard/nix/hash';
import { describe, expect, it, vi } from 'vitest';

import {
	NixLocalStoreClient,
	type NixStoreDatabase,
	nixStoreDatabaseFromSqlite,
	type NixStoreRow
} from './nix-local-store.ts';
import {
	NixStorePathNotFoundError,
	type NixValidPathInfo
} from './nix-store.ts';

const pathA = '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-a';
const pathB = '/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-b';
const hashA = `sha256:${'aa'.repeat(32)}`;
const hashB = `sha256:${'bb'.repeat(32)}`;
const deriverA = '/nix/store/dddddddddddddddddddddddddddddddd-a.drv';
const sigsA = 'cache-1:sigaaa cache-2:sigbbb';
const caB = 'fixed:r:sha256:deadbeef';

const rowA: NixStoreRow = {
	id: 1,
	hash: hashA,
	narSize: 100,
	deriver: deriverA,
	sigs: sigsA,
	ca: undefined
};

const rowB: NixStoreRow = {
	id: 2,
	hash: hashB,
	narSize: 50,
	deriver: undefined,
	sigs: undefined,
	ca: caB
};

const referencesA: readonly string[] = [pathA, pathB];
const referencesB: readonly string[] = [pathB];

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
		close: vi.fn()
	};
}

const infoA: NixValidPathInfo = {
	storePath: pathA,
	narHash: NixSha256Hash.parsePrefixed(hashA),
	narSize: 100,
	references: referencesA,
	signatures: ['cache-1:sigaaa', 'cache-2:sigbbb'],
	deriver: deriverA
};

const infoB: NixValidPathInfo = {
	storePath: pathB,
	narHash: NixSha256Hash.parsePrefixed(hashB),
	narSize: 50,
	references: referencesB,
	signatures: [],
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
		await expect(client.queryPathInfo('/nix/store/missing')).rejects.toThrow(
			NixStorePathNotFoundError
		);
	});
});

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

	// Omit the NULL columns rather than binding them, so each row exercises a
	// different absent field.
	database
		.prepare(
			'insert into ValidPaths (id, path, hash, registrationTime, deriver, narSize, ultimate, sigs) values (?, ?, ?, ?, ?, ?, ?, ?)'
		)
		.run(1, pathA, hashA, 0, deriverA, 100, 1, sigsA);
	database
		.prepare(
			'insert into ValidPaths (id, path, hash, registrationTime, narSize, ultimate, ca) values (?, ?, ?, ?, ?, ?, ?)'
		)
		.run(2, pathB, hashB, 0, 50, 0, caB);

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
		} finally {
			database.close();
		}
	});
});
