import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import {
	type SchemaTransition,
	schemaTransitions
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
		context = 'in journal order'
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
 * The deploy applies migrations in journal order and assigns each to a
 * transition, so the directory, the journal and the transitions must agree
 * on one sequence. A migration missing from any of the three, or listed in a
 * different order, is refused here rather than by the deploy.
 */
export class MigrationSequenceError extends CodedError {
	constructor(
		public readonly source: 'journal' | 'transitions',
		public readonly expected: readonly string[],
		public readonly found: readonly string[]
	) {
		const where =
			source === 'journal'
				? 'the journal'
				: 'the schema transitions in @cupboard/protocol/deployment';

		super(
			`The D1 migration files and ${where} disagree.\nFiles, in name order: ${expected.join(', ')}\n${source === 'journal' ? 'Journal' : 'Transitions'}: ${found.join(', ')}`
		);
		this.name = 'MigrationSequenceError';
	}
}

/**
 * A transition's contract runs after its expand, so its contract files must
 * sort after every expand file, or the deploy would apply them out of journal
 * order.
 */
export class ContractOrderError extends CodedError {
	constructor(
		public readonly transition: string,
		public readonly lastExpand: string,
		public readonly firstContract: string
	) {
		super(
			`Transition ${transition} lists contract ${firstContract} before its expand ${lastExpand}`
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
	The file names in the order `_journal.json` lists them.
	*/
	readonly journal: readonly string[];
	readonly sql: (file: string) => string;
}

export function byCodeUnit(a: string, b: string): number {
	if (a < b) {
		return -1;
	}

	if (a > b) {
		return 1;
	}

	return 0;
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

function replay(
	set: MigrationSet,
	files: readonly string[],
	context?: string
): void {
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
 * The order the deploy applies an independent transition's expand in on a
 * deployment that has every earlier transition pending: after the earlier
 * expands and before their contracts, then the rest as listed.
 */
export function independentReplayOrder(
	transitions: readonly SchemaTransition[],
	index: number
): string[] {
	const earlier = transitions.slice(0, index);
	const independent = transitions[index];
	const later = transitions.slice(index + 1);

	return [
		...earlier.flatMap((transition) => transition.expand),
		...(independent?.expand ?? []),
		...earlier.flatMap((transition) => transition.contract),
		...(independent?.contract ?? []),
		...later.flatMap((transition) => [
			...transition.expand,
			...transition.contract
		])
	];
}

export interface MigrationCheckResult {
	readonly applied: number;
	/**
	The independent transitions replayed ahead of the earlier contracts.
	*/
	readonly replayed: readonly string[];
}

/**
 * Fails unless the files, the journal and the transitions list the same
 * sequence, each contract sorts after its expand, every file applies in order
 * from an empty database, and each independent transition's expand applies
 * before the contracts it claims not to depend on.
 */
export function checkD1Migrations(
	set: MigrationSet,
	transitions: readonly SchemaTransition[] = schemaTransitions
): MigrationCheckResult {
	if (!isSameSequence(set.files, set.journal)) {
		throw new MigrationSequenceError('journal', set.files, set.journal);
	}

	// Checked before the sequence as a whole, so a contract listed ahead of its
	// expand is named as such rather than as a sequence mismatch.
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
		throw new MigrationSequenceError('transitions', set.files, classified);
	}

	replay(set, set.files);

	const replayed: string[] = [];

	for (const [index, transition] of transitions.entries()) {
		if (index === 0 || transition.independent !== true) {
			continue;
		}

		replay(
			set,
			independentReplayOrder(transitions, index),
			`with the ${transition.id} expand ahead of the earlier contracts`
		);
		replayed.push(transition.id);
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
		`Applied ${String(result.applied)} D1 migrations cleanly${result.replayed.length === 0 ? '' : `, and again with ${result.replayed.join(', ')} ahead of the earlier contracts`}.`
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
