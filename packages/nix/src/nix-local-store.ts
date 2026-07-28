import path from 'node:path';
import process from 'node:process';
import type { DatabaseSync } from 'node:sqlite';

import { NixSha256Hash } from '@cupboard/nix-store/hash';

import {
	type NixStoreClient,
	NixStoreDatabaseError,
	NixStorePathNotFoundError,
	type NixValidPathInfo,
	resolveClosureBy,
	UnsupportedNixStoreOperationError
} from './nix-store.ts';

/**
 * A read view of the local Nix store's SQLite database, narrowed to path
 * metadata and derivation output queries. Injected so the client is tested
 * without a real database.
 */
export interface NixStoreDatabase {
	pathRow(storePath: string): NixStoreRow | undefined;
	references(id: number): readonly string[];
	derivationOutputs(drvPaths: readonly string[]): readonly string[];
	close(): void;
}

export interface NixStoreRow {
	readonly id: number;
	/** The NAR hash as stored: `sha256:` followed by a base16 digest. */
	readonly hash: string;
	readonly narSize: number;
	readonly deriver: string | undefined;
	readonly ultimate: boolean;
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
			return await use(database);
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

	queryPathsInfo(
		storePaths: readonly string[]
	): Promise<readonly NixValidPathInfo[]> {
		return this.withDatabase((database) =>
			storePaths.map((storePath) => requirePathInfo(database, storePath))
		);
	}

	queryValidPathsInfo(
		storePaths: readonly string[]
	): Promise<readonly NixValidPathInfo[]> {
		return this.withDatabase((database) =>
			storePaths.flatMap((storePath) => {
				const row = database.pathRow(storePath);

				return row === undefined
					? []
					: [pathInfoFromRow(database, storePath, row)];
			})
		);
	}

	queryValidPaths(storePaths: readonly string[]): Promise<readonly string[]> {
		return this.withDatabase((database) => {
			const seen = new Set<string>();

			return storePaths.filter((storePath) => {
				if (seen.has(storePath)) {
					return false;
				}

				seen.add(storePath);

				return database.pathRow(storePath) !== undefined;
			});
		});
	}

	querySubstitutablePaths(
		_storePaths: readonly string[]
	): Promise<readonly string[]> {
		return Promise.reject(
			new UnsupportedNixStoreOperationError('substitutable-path queries')
		);
	}

	queryDerivationOutputPaths(
		drvPaths: readonly string[]
	): Promise<readonly string[]> {
		return this.withDatabase((database) =>
			database.derivationOutputs([...new Set(drvPaths)])
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

	return pathInfoFromRow(database, storePath, row);
}

function pathInfoFromRow(
	database: NixStoreDatabase,
	storePath: string,
	row: NixStoreRow
): NixValidPathInfo {
	const deriver = present(row.deriver);
	const ca = present(row.ca);

	return {
		storePath,
		narHash: NixSha256Hash.parsePrefixed(row.hash),
		narSize: row.narSize,
		references: database.references(row.id),
		signatures: splitSignatures(row.sigs),
		ultimate: row.ultimate,
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
const derivationOutputBatchSize = 500;

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

/** Adapt an open `node:sqlite` database to the queries the local store needs. */
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
				ultimate: optionalInteger(row.ultimate) === 1,
				sigs: optionalText(row.sigs),
				ca: optionalText(row.ca)
			};
		},
		references: (id) =>
			referencesStatement.all(id).map((row) => text(row.path, 'path')),
		derivationOutputs(drvPaths) {
			const outputs = new Set<string>();

			for (
				let offset = 0;
				offset < drvPaths.length;
				offset += derivationOutputBatchSize
			) {
				const batch = drvPaths.slice(
					offset,
					offset + derivationOutputBatchSize
				);
				const placeholders = batch.map(() => '?').join(', ');
				const statement = database.prepare(
					`select DerivationOutputs.path
					 from DerivationOutputs
					 join ValidPaths on DerivationOutputs.drv = ValidPaths.id
					 where ValidPaths.path in (${placeholders})
					 order by DerivationOutputs.path`
				);
				const rows = statement.all(...batch);

				for (const row of rows) {
					outputs.add(text(row.path, 'path'));
				}
			}

			return [...outputs].toSorted((left, right) => left.localeCompare(right));
		},
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
