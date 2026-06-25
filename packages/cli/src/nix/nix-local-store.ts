import path from 'node:path';
import process from 'node:process';
import type { DatabaseSync } from 'node:sqlite';

import { NixSha256Hash } from '@cupboard/nix/hash';

import {
	type NixStoreClient,
	NixStoreDatabaseError,
	NixStorePathNotFoundError,
	type NixValidPathInfo,
	resolveClosureBy
} from './nix-store.ts';

/**
 * A read view of the local Nix store's SQLite database, narrowed to the two
 * queries closure resolution needs. Injected so the client is tested without a
 * real database.
 */
export interface NixStoreDatabase {
	pathRow(storePath: string): NixStoreRow | undefined;
	references(id: number): readonly string[];
	close(): void;
}

export interface NixStoreRow {
	readonly id: number;
	/** The NAR hash as stored: `sha256:` followed by a base16 digest. */
	readonly hash: string;
	readonly narSize: number;
	readonly deriver: string | undefined;
	readonly sigs: string | undefined;
	readonly ca: string | undefined;
}

/**
 * Reads path information straight from the local store database, the way Nix's
 * `LocalStore` does, so closures resolve on a daemonless store with no running
 * `nix-daemon` to talk to.
 */
export class NixLocalStoreClient implements NixStoreClient {
	constructor(private readonly open: () => NixStoreDatabase) {}

	private async withDatabase<T>(
		use: (database: NixStoreDatabase) => T
	): Promise<Awaited<T>> {
		const database = this.open();

		try {
			return await Promise.resolve(use(database));
		} finally {
			database.close();
		}
	}

	resolveClosure(
		storePaths: readonly string[]
	): Promise<readonly NixValidPathInfo[]> {
		return this.withDatabase((database) =>
			resolveClosureBy(storePaths, (storePath) =>
				Promise.resolve(requirePathInfo(database, storePath))
			)
		);
	}

	queryPathInfo(storePath: string): Promise<NixValidPathInfo> {
		return this.withDatabase((database) =>
			requirePathInfo(database, storePath)
		);
	}
}

function requirePathInfo(
	database: NixStoreDatabase,
	storePath: string
): NixValidPathInfo {
	const row = database.pathRow(storePath);

	if (row === undefined) {
		throw new NixStorePathNotFoundError(storePath);
	}

	const deriver = present(row.deriver);
	const ca = present(row.ca);

	return {
		storePath,
		narHash: NixSha256Hash.parsePrefixed(row.hash),
		narSize: row.narSize,
		references: database.references(row.id),
		signatures: splitSignatures(row.sigs),
		...(deriver !== undefined && { deriver }),
		...(ca !== undefined && { ca })
	};
}

function splitSignatures(sigs: string | undefined): readonly string[] {
	if (sigs === undefined) {
		return [];
	}

	return sigs.split(/\s+/u).filter(Boolean);
}

function present(value: string | undefined): string | undefined {
	return value === undefined || value === '' ? undefined : value;
}

const queryPathInfoSql =
	'select id, hash, registrationTime, deriver, narSize, ultimate, sigs, ca from ValidPaths where path = ?';
const queryReferencesSql =
	'select path from Refs join ValidPaths on reference = id where referrer = ?';

/**
 * Open the local store database read-only. The shipped binary embeds a Node
 * runtime with `node:sqlite`, loaded here so the daemon path never pulls it in
 * nor pays its experimental-feature warning.
 */
export function openLocalStoreDatabase(
	stateDirectory: string
): NixStoreDatabase {
	const sqlite = process.getBuiltinModule('node:sqlite');
	const databasePath = path.join(stateDirectory, 'db', 'db.sqlite');

	return nixStoreDatabaseFromSqlite(
		new sqlite.DatabaseSync(databasePath, { readOnly: true })
	);
}

/** Adapt an open `node:sqlite` database to the two queries the local store needs. */
export function nixStoreDatabaseFromSqlite(
	database: DatabaseSync
): NixStoreDatabase {
	const pathStatement = database.prepare(queryPathInfoSql);
	const referencesStatement = database.prepare(queryReferencesSql);

	return {
		pathRow(storePath) {
			const row = pathStatement.get(storePath);

			if (row === undefined) {
				return;
			}

			return {
				id: integer(row.id),
				hash: text(row.hash, 'hash'),
				narSize: optionalInteger(row.narSize) ?? 0,
				deriver: optionalText(row.deriver),
				sigs: optionalText(row.sigs),
				ca: optionalText(row.ca)
			};
		},
		references: (id) =>
			referencesStatement.all(id).map((row) => text(row.path, 'path')),
		close() {
			database.close();
		}
	};
}

function integer(value: unknown): number {
	const parsed = optionalInteger(value);

	if (parsed === undefined) {
		throw new NixStoreDatabaseError(
			`expected an integer column, got ${typeof value}`
		);
	}

	return parsed;
}

function optionalInteger(value: unknown): number | undefined {
	if (typeof value === 'number') {
		return value;
	}

	if (typeof value === 'bigint') {
		return Number(value);
	}

	return undefined;
}

function text(value: unknown, column: string): string {
	if (typeof value === 'string') {
		return value;
	}

	throw new NixStoreDatabaseError(
		`expected a text value in column '${column}', got ${typeof value}`
	);
}

function optionalText(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}
