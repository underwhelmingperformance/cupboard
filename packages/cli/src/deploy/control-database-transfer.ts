import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import { CliError } from '../errors.ts';

import {
	type D1BoundStatement,
	type D1QueryApi,
	sqlString
} from './d1-query.ts';
import type { DatabaseId } from './identifiers.ts';

const controlTables = [
	'control_auth_key',
	'control_trust',
	'control_refresh_session_family',
	'control_refresh_session_member',
	'control_consumed_subject_nonce',
	'global_admin',
	'tenant_maintenance_failure'
] as const;
const pageSize = 20;
const markerId = "'current'";
const markerSchema = z.tuple([z.string(), z.enum(['copying', 'ready'])]);
const columnSchema = z.tuple([
	z.string().regex(/^[a-z_]+$/),
	z.string(),
	z.number().int().nonnegative()
]);
const rowSchema = z.array(z.union([z.string(), z.number(), z.null()]));

type ControlTable = (typeof controlTables)[number];

interface TransferOptions {
	readonly api: D1QueryApi;
	readonly source: DatabaseId;
	readonly target: DatabaseId;
	readonly validateKeys: () => Promise<void>;
	readonly now: Date;
}

export class ControlDatabaseTransferError extends CliError {
	constructor(detail: string) {
		super(
			`Control database transfer failed: ${detail}. Correct the problem and resume this deployment. A frozen legacy database must remain frozen.`
		);
		this.name = 'ControlDatabaseTransferError';
	}
}

class ControlTableCopy {
	static async read(
		api: D1QueryApi,
		source: DatabaseId,
		target: DatabaseId,
		table: ControlTable
	): Promise<ControlTableCopy> {
		const query = `SELECT json_array(name, upper(type), pk) FROM pragma_table_info(${sqlString(table)}) ORDER BY name;`;
		const sourceColumns = await api.queryRows(source, query);
		const targetColumns = await api.queryRows(target, query);

		if (
			sourceColumns.length === 0 ||
			!isDeepStrictEqual(sourceColumns, targetColumns)
		) {
			throw new ControlDatabaseTransferError(
				`schema of ${table} does not match`
			);
		}

		const metadata = sourceColumns.map((row) =>
			columnSchema.parse(JSON.parse(row))
		);
		const keys = metadata
			.filter((column) => column[2] > 0)
			.toSorted((left, right) => left[2] - right[2])
			.map((column) => column[0]);
		if (keys.length === 0) {
			throw new ControlDatabaseTransferError(
				`table ${table} has no primary key`
			);
		}
		return new ControlTableCopy(
			table,
			metadata.map((column) => column[0]),
			keys
		);
	}

	private constructor(
		readonly table: ControlTable,
		private readonly columns: readonly string[],
		private readonly keys: readonly string[]
	) {}

	private readPage(
		api: D1QueryApi,
		database: DatabaseId,
		after: string | undefined
	): Promise<readonly string[]> {
		const columns = this.columns.join(', ');
		const order = this.keys.join(', ');
		const values =
			after === undefined ? undefined : rowSchema.parse(JSON.parse(after));
		const cursor =
			values === undefined
				? undefined
				: this.keys.map((key) =>
						z.string().parse(values[this.columns.indexOf(key)])
					);
		const where =
			cursor === undefined
				? ''
				: ` WHERE (${order}) > (${cursor.map((value) => sqlString(value)).join(', ')})`;
		return api.queryRows(
			database,
			`SELECT json_array(${columns}) AS row FROM ${this.table}${where} ORDER BY ${order} LIMIT ${String(pageSize)};`
		);
	}

	private insert(row: string, source: DatabaseId): D1BoundStatement {
		const values = rowSchema.parse(JSON.parse(row));
		if (values.length !== this.columns.length) {
			throw new ControlDatabaseTransferError(
				`row of ${this.table} does not match its schema`
			);
		}

		return {
			sql: `INSERT INTO ${this.table} (${this.columns.join(', ')}) SELECT ${values.map(() => '?').join(', ')} WHERE EXISTS (SELECT 1 FROM control_database_ready WHERE id = ${markerId} AND source_database_id = ? AND state = 'copying') ON CONFLICT DO NOTHING;`,
			params: [...values, source]
		};
	}
	async copy(options: TransferOptions): Promise<void> {
		for (let after: string | undefined; ;) {
			if (await isReady(options)) {
				return;
			}
			const rows = await this.readPage(options.api, options.source, after);
			if (rows.length === 0) {
				return;
			}
			await options.api.queryBatch(
				options.target,
				rows.map((row) => this.insert(row, options.source))
			);
			after = rows.at(-1);
		}
	}

	async verify(options: TransferOptions): Promise<void> {
		for (let after: string | undefined; ;) {
			if (await isReady(options)) {
				return;
			}
			const rows = await this.readPage(options.api, options.source, after);
			const copied = await this.readPage(options.api, options.target, after);
			if (!isDeepStrictEqual(rows, copied)) {
				if (await isReady(options)) {
					return;
				}
				throw new ControlDatabaseTransferError(
					`contents of ${this.table} do not match`
				);
			}
			if (rows.length < pageSize) {
				return;
			}
			after = rows.at(-1);
		}
	}
}

async function isReady(options: TransferOptions): Promise<boolean> {
	const rows = await options.api.queryRows(
		options.target,
		`SELECT json_array(source_database_id, state) FROM control_database_ready WHERE id = ${markerId};`
	);
	if (rows.length !== 1) {
		throw new ControlDatabaseTransferError(
			'target readiness record is missing or duplicated'
		);
	}
	const [row] = rows;
	const [source, state] = markerSchema.parse(JSON.parse(row ?? 'null'));
	if (source !== options.source) {
		throw new ControlDatabaseTransferError(
			'target was initialised from another database'
		);
	}
	return state === 'ready';
}

async function freezeSource(options: TransferOptions): Promise<void> {
	const { api, source, target, now } = options;
	await api.queryBatch(source, [
		`INSERT INTO control_database_split (id, target_database_id, frozen_at) VALUES (${markerId}, ${sqlString(target)}, ${sqlString(now.toISOString())}) ON CONFLICT DO NOTHING;`
	]);
	const targets = await api.queryRows(
		source,
		`SELECT target_database_id FROM control_database_split WHERE id = ${markerId};`
	);
	if (!isDeepStrictEqual(targets, [target])) {
		throw new ControlDatabaseTransferError(
			'source is frozen for another target database'
		);
	}
}

/**
 * Copies frozen control authority in bounded pages. The caller records the
 * irreversible transition and checks both deployed Worker versions first.
 */
export async function transferControlDatabase(
	options: TransferOptions
): Promise<void> {
	const { api, source, target } = options;
	if (source === target) {
		throw new ControlDatabaseTransferError(
			'source and target must be separate databases'
		);
	}

	await api.queryBatch(target, [
		`INSERT INTO control_database_ready (id, source_database_id, state) VALUES (${markerId}, ${sqlString(source)}, 'copying') ON CONFLICT DO NOTHING;`
	]);
	if (await didFinishReady(options)) {
		return;
	}

	await freezeSource(options);

	try {
		for (const table of controlTables) {
			if (await didFinishReady(options)) {
				return;
			}
			const copy = await ControlTableCopy.read(api, source, target, table);
			await copy.copy(options);
		}
		for (const table of controlTables) {
			if (await didFinishReady(options)) {
				return;
			}
			const copy = await ControlTableCopy.read(api, source, target, table);
			await copy.verify(options);
		}
	} catch (error) {
		if (await didFinishReady(options)) {
			return;
		}
		throw error;
	}
	if (await didFinishReady(options)) {
		return;
	}

	await options.validateKeys();
	await api.queryBatch(target, [
		`UPDATE control_database_ready SET state = 'ready' WHERE id = ${markerId} AND source_database_id = ${sqlString(source)} AND state = 'copying';`
	]);
	if (!(await isReady(options))) {
		throw new ControlDatabaseTransferError('target did not become ready');
	}
	await recordCopied(options);
}

async function didFinishReady(options: TransferOptions): Promise<boolean> {
	if (!(await isReady(options))) {
		return false;
	}
	await recordCopied(options);
	return true;
}

async function recordCopied(options: TransferOptions): Promise<void> {
	const targets = await options.api.queryRows(
		options.source,
		`SELECT target_database_id FROM control_database_split WHERE id = ${markerId};`
	);
	if (!isDeepStrictEqual(targets, [options.target])) {
		throw new ControlDatabaseTransferError(
			'ready target does not match the frozen source'
		);
	}
	await options.api.queryBatch(options.source, [
		`UPDATE control_database_split SET copied_at = COALESCE(copied_at, ${sqlString(options.now.toISOString())}) WHERE id = ${markerId} AND target_database_id = ${sqlString(options.target)};`
	]);
}
