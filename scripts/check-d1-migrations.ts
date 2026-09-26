import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { byCodeUnit } from '@cupboard/nix-store/store-path';
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
		cause: unknown
	) {
		const detail = cause instanceof Error ? cause.message : String(cause);

		super(`D1 migration ${file} failed to apply:\n${statement}\n${detail}`, {
			cause
		});
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

function isSameSequence(
	left: readonly string[],
	right: readonly string[]
): boolean {
	return (
		left.length === right.length &&
		left.every((name, index) => name === right[index])
	);
}

export interface MigrationCheckResult {
	readonly applied: number;
}

/**
 * Fails unless the journal lists the files in name order and every file
 * applies in that order from an empty database.
 */
export function checkD1Migrations(set: MigrationSet): MigrationCheckResult {
	if (!isSameSequence(set.files, set.journal)) {
		throw new MigrationJournalOrderError(set.files, set.journal);
	}

	const database = new DatabaseSync(':memory:');

	try {
		for (const file of set.files) {
			for (const statement of statementsOf(set, file)) {
				try {
					database.prepare(statement).run();
				} catch (error) {
					throw new MigrationApplyError(file, statement, error);
				}
			}
		}
	} finally {
		database.close();
	}

	return { applied: set.files.length };
}

function main(): void {
	const directory = path.resolve(
		import.meta.dirname,
		'..',
		'packages/server/drizzle-d1'
	);
	const result = checkD1Migrations(readMigrationSet(directory));

	console.log(`Applied ${String(result.applied)} D1 migrations cleanly.`);
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
