import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	deferredTransition,
	isCompleteOnExpand,
	type SchemaTransition,
	schemaTransitions,
	type TransitionState
} from '@cupboard/protocol/deployment';
import { CodedError, genericExitCode } from '@cupboard/shared/errors';
import { z } from 'zod';

// Drizzle generates migrations by diffing the schema against the latest
// snapshot, so a snapshot that has drifted from the live schema makes the next
// `generate` re-emit an ALTER for a column that already exists. That ALTER is
// valid SQL on its own but fails when applied after the migration that first
// added the column, breaking the next deploy. Replaying the whole sequence here
// catches such a duplicate before it reaches D1.
export class MigrationApplyError extends CodedError {
	constructor(
		public readonly file: string,
		public readonly statement: string,
		cause: unknown,
		public readonly context = 'in name order'
	) {
		const detail = cause instanceof Error ? cause.message : String(cause);

		super(
			`D1 migration ${file} failed to apply ${context}:\n${statement}\n${detail}`,
			{ cause }
		);
		this.name = 'MigrationApplyError';
	}
}

/**
 * The deploy applies the migration files in name order. drizzle-kit records
 * its own order in the journal and uses that order when it generates the next
 * migration, so a journal in another order describes a different history from
 * the one that the deploy applies. This check fails when the two orders
 * differ, before a deploy runs.
 */
export class MigrationJournalOrderError extends CodedError {
	constructor(
		public readonly files: readonly string[],
		public readonly journal: readonly string[]
	) {
		super(
			`The D1 migration files and the journal disagree.\nFiles, in name order: ${files.join(', ')}\nJournal: ${journal.join(', ')}`
		);
		this.name = 'MigrationJournalOrderError';
	}
}

/**
 * The deploy assigns the migration files to the schema transitions in name
 * order, so the transitions must list the files in that order. The deploy
 * refuses an artifact whose files do not match; this check fails before a
 * deploy runs.
 */
export class TransitionSequenceError extends CodedError {
	constructor(
		public readonly files: readonly string[],
		public readonly transitions: readonly string[]
	) {
		super(
			`The D1 migration files and the schema transitions in @cupboard/protocol/deployment disagree.\nFiles, in name order: ${files.join(', ')}\nTransitions: ${transitions.join(', ')}`
		);
		this.name = 'TransitionSequenceError';
	}
}

/**
 * A transition's contract migrations run after its expand migrations, so its
 * contract files must sort after every expand file. Otherwise the deploy would
 * apply them out of name order.
 */
export class ContractOrderError extends CodedError {
	constructor(
		public readonly transition: string,
		public readonly lastExpand: string,
		public readonly firstContract: string
	) {
		super(
			`Transition ${transition}: contract ${firstContract} sorts before expand ${lastExpand}`
		);
		this.name = 'ContractOrderError';
	}
}

const journalEntrySchema = z.object({
	idx: z.number().int(),
	tag: z.string()
});
const journalSchema = z.object({ entries: z.array(journalEntrySchema) });

/**
The migration files, the journal's order of them, and their contents.
*/
export interface MigrationSet {
	/**
	The `.sql` file names, in name order.
	*/
	readonly files: readonly string[];
	/**
	The file names in `_journal.json` order.
	*/
	readonly journal: readonly string[];
	readonly sql: (file: string) => string;
}

export function readMigrationSet(directory: string): MigrationSet {
	const files = readdirSync(directory)
		.filter((file) => file.endsWith('.sql'))
		.toSorted(byCodeUnit);
	const journalPath = path.join(directory, 'meta/_journal.json');
	const journalText = readFileSync(journalPath, 'utf8');
	const journal = journalSchema.parse(JSON.parse(journalText));

	return {
		files,
		journal: journal.entries
			.toSorted((left, right) => left.idx - right.idx)
			.map((entry) => `${entry.tag}.sql`),
		sql: (file) => readFileSync(path.join(directory, file), 'utf8')
	};
}

function statementsOf(set: MigrationSet, file: string): string[] {
	return set
		.sql(file)
		.split('--> statement-breakpoint')
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

/**
 * Replaying the migrations in a deploy order succeeded but produced a different
 * schema from name order. When an independent transition's expand
 * migration runs before an earlier contract migration, it can succeed and
 * still produce a different schema, for example by creating a table or index
 * with `IF NOT EXISTS` or by adding a column.
 */
export class MigrationSchemaMismatchError extends CodedError {
	constructor(
		public readonly context: string,
		public readonly missing: readonly string[],
		public readonly unexpected: readonly string[]
	) {
		super(
			`Applying the D1 migrations ${context} produces a different schema from applying them in name order.\nOnly in name order: ${missing.join('; ') || '(none)'}\nOnly ${context}: ${unexpected.join('; ') || '(none)'}`
		);
		this.name = 'MigrationSchemaMismatchError';
	}
}

const schemaObjectSchema = z.strictObject({
	type: z.string(),
	name: z.string(),
	sql: z.string().nullable()
});
const columnSchema = z.looseObject({
	cid: z.number(),
	name: z.string(),
	type: z.string(),
	notnull: z.number(),
	dflt_value: z.unknown(),
	pk: z.number(),
	hidden: z.number()
});
const foreignKeySchema = z.looseObject({
	id: z.number(),
	seq: z.number(),
	table: z.string(),
	from: z.string(),
	to: z.string().nullable(),
	on_update: z.string(),
	on_delete: z.string(),
	match: z.string()
});
const indexSchema = z.looseObject({
	name: z.string(),
	unique: z.number(),
	origin: z.string(),
	partial: z.number()
});
const indexColumnSchema = z.looseObject({
	seqno: z.number(),
	cid: z.number(),
	name: z.string().nullable(),
	desc: z.number(),
	coll: z.string().nullable(),
	key: z.number()
});

// The lines for one table: its columns, including generated and hidden ones,
// its foreign keys, and each index with its columns, sort orders and
// collations. SQLite reports the rest of the schema, such as CHECK
// constraints, partial-index conditions and trigger bodies, only as the SQL
// text in `sqlite_master`.
function tableSchemaOf(database: DatabaseSync, table: string): string[] {
	const rows = (sql: string, argument: string): unknown =>
		database.prepare(sql).all(argument);
	const columns = z
		.array(columnSchema)
		.parse(rows('SELECT * FROM pragma_table_xinfo(?) ORDER BY cid', table));
	const foreignKeys = z
		.array(foreignKeySchema)
		.parse(
			rows('SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq', table)
		);
	const indexes = z
		.array(indexSchema)
		.parse(rows('SELECT * FROM pragma_index_list(?) ORDER BY name', table));

	return [
		...columns.map(
			(column) =>
				`column ${table}.${column.name} ${String(column.cid)} ${column.type} notnull=${String(column.notnull)} pk=${String(column.pk)} hidden=${String(column.hidden)} default=${JSON.stringify(column.dflt_value)}`
		),
		...foreignKeys.map(
			(key) =>
				`foreign key ${table} ${String(key.id)}.${String(key.seq)}: ${key.from} references ${key.table}(${key.to ?? ''}) on update ${key.on_update} on delete ${key.on_delete} match ${key.match}`
		),
		...indexes.flatMap((index) => [
			`index ${table}.${index.name} unique=${String(index.unique)} origin=${index.origin} partial=${String(index.partial)}`,
			...z
				.array(indexColumnSchema)
				.parse(
					rows('SELECT * FROM pragma_index_xinfo(?) ORDER BY seqno', index.name)
				)
				.map(
					(column) =>
						`index column ${index.name} ${String(column.seqno)}: ${column.name ?? '(expression)'} cid=${String(column.cid)} desc=${String(column.desc)} collation=${column.coll ?? ''} key=${String(column.key)}`
				)
		])
	];
}

// One line per schema object and per table detail, so two schemas can be
// compared line by line and a difference reported by line.
function schemaOf(database: DatabaseSync): string[] {
	const objects = z
		.array(schemaObjectSchema)
		.parse(
			database
				.prepare(
					"SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
				)
				.all()
		);

	return objects.flatMap((object) => {
		const line = `${object.type} ${object.name}: ${object.sql ?? ''}`;

		if (object.type !== 'table') {
			return [line];
		}

		return [line, ...tableSchemaOf(database, object.name)];
	});
}

function replay(
	set: MigrationSet,
	files: readonly string[],
	context?: string
): string[] {
	const database = new DatabaseSync(':memory:');

	try {
		for (const file of files) {
			for (const statement of statementsOf(set, file)) {
				try {
					database.prepare(statement).run();
				} catch (error) {
					throw new MigrationApplyError(file, statement, error, context);
				}
			}
		}

		return schemaOf(database);
	} finally {
		database.close();
	}
}

function isSameSequence(
	left: readonly string[],
	right: readonly string[]
): boolean {
	return (
		left.length === right.length &&
		left.every((name, index) => name === right[index])
	);
}

/**
The migration files in the order that one deploy run applies them.
*/
export interface DeployOrder {
	readonly files: readonly string[];
	/**
	 * The independent transitions that the run expands before the contract of
	 * an earlier transition.
	 */
	readonly ahead: readonly string[];
}

/**
 * The order in which one deploy run applies the migrations to a deployment
 * whose first N transitions are complete, where N is `completeCount`, and
 * whose later transitions are pending. The files of the complete transitions
 * come first, in name order. Undefined when the deploy would stop with an
 * error because `deferredTransition` finds a transition that could expand
 * only after the upload.
 *
 * Otherwise the run expands every pending transition before the upload, in
 * list order, and applies the contract migrations after it, as the deploy's
 * transition walk does.
 *
 * These are not the only histories that a deployment can have. An
 * independent transition with contract migrations can expand ahead of an
 * earlier transition's contract migrations and still be expanded when a later
 * release adds another transition. The replay does not cover the order in
 * which the deploy then applies the files.
 */
export function deployOrder(
	transitions: readonly SchemaTransition<string>[],
	completeCount: number
): DeployOrder | undefined {
	const recorded = new Map<string, TransitionState>();
	const files: string[] = [];
	const ahead: string[] = [];

	for (const transition of transitions.slice(0, completeCount)) {
		files.push(...transition.expand, ...transition.contract);
		recorded.set(transition.id, 'complete');
	}

	if (deferredTransition(transitions, recorded) !== undefined) {
		return undefined;
	}

	for (const [index, transition] of transitions.entries()) {
		if (recorded.has(transition.id)) {
			continue;
		}

		const isAhead = transitions
			.slice(0, index)
			.some((earlier) => recorded.get(earlier.id) !== 'complete');

		files.push(...transition.expand);
		recorded.set(
			transition.id,
			isCompleteOnExpand(transition) ? 'complete' : 'expanded'
		);

		if (isAhead) {
			ahead.push(transition.id);
		}
	}

	for (const transition of transitions) {
		const state = recorded.get(transition.id);

		if (state === 'complete') {
			continue;
		}

		files.push(...transition.contract);
		recorded.set(transition.id, 'complete');
	}

	return { files, ahead };
}

export interface MigrationCheckResult {
	readonly applied: number;
	/**
	 * The independent transitions that a deploy expands ahead of an earlier
	 * contract.
	 */
	readonly replayed: readonly string[];
}

/**
 * Fails unless the files, the journal and the transitions list the same
 * sequence, each transition's contract migrations sort after its expand
 * migrations, and every file applies in order from an empty database.
 *
 * It then replays each order from {@link deployOrder} that differs from name
 * order: for each N from none to all but the last, the order for a deployment
 * whose first N transitions are complete and whose later ones are pending.
 * The check fails if an independent transition's expand migrations do not
 * apply before the earlier contract migrations, or if the order produces a
 * different schema from name order.
 */
export function checkD1Migrations(
	set: MigrationSet,
	transitions: readonly SchemaTransition<string>[] = schemaTransitions
): MigrationCheckResult {
	if (!isSameSequence(set.files, set.journal)) {
		throw new MigrationJournalOrderError(set.files, set.journal);
	}

	// Checked before the sequence as a whole, so a contract listed ahead of its
	// expand is reported as a `ContractOrderError`, not as a sequence mismatch.
	for (const transition of transitions) {
		const lastExpand = transition.expand.at(-1);
		const [firstContract] = transition.contract;

		if (
			lastExpand !== undefined &&
			firstContract !== undefined &&
			byCodeUnit(lastExpand, firstContract) >= 0
		) {
			throw new ContractOrderError(transition.id, lastExpand, firstContract);
		}
	}

	const classified = transitions.flatMap((transition) => [
		...transition.expand,
		...transition.contract
	]);

	if (!isSameSequence(set.files, classified)) {
		throw new TransitionSequenceError(set.files, classified);
	}

	const nameOrderSchema = replay(set, set.files);
	const replayed: string[] = [];

	for (const completeCount of transitions.keys()) {
		const order = deployOrder(transitions, completeCount);

		if (order === undefined || isSameSequence(order.files, set.files)) {
			continue;
		}

		const context = `with ${order.ahead.join(', ')} expanded ahead of the earlier contract migrations`;
		const orderSchema = replay(set, order.files, context);
		const missing = nameOrderSchema.filter(
			(line) => !orderSchema.includes(line)
		);
		const unexpected = orderSchema.filter(
			(line) => !nameOrderSchema.includes(line)
		);

		if (missing.length > 0 || unexpected.length > 0) {
			throw new MigrationSchemaMismatchError(context, missing, unexpected);
		}

		replayed.push(...order.ahead.filter((id) => !replayed.includes(id)));
	}

	return { applied: set.files.length, replayed };
}

function main(): void {
	const directory = path.resolve(
		import.meta.dirname,
		'..',
		'packages/server/drizzle-d1'
	);
	const result = checkD1Migrations(readMigrationSet(directory));

	console.log(
		`Applied ${String(result.applied)} D1 migrations cleanly${result.replayed.length === 0 ? '' : `, and replayed them with ${result.replayed.join(', ')} expanded before the earlier contract migrations`}.`
	);
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		main();
	} catch (error: unknown) {
		if (error instanceof CodedError) {
			console.error(error.message);
			process.exitCode = error.exitCode;
		} else {
			console.error(error);
			process.exitCode = genericExitCode;
		}
	}
}
