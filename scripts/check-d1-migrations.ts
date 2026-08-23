import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CodedError, genericExitCode } from '@cupboard/shared/errors';

// Drizzle generates migrations by diffing the schema against the
// latest snapshot, so a snapshot that has drifted from the live schema makes the
// next `generate` re-emit an ALTER for a column that already exists. That ALTER
// is valid SQL on its own but fails when applied after the migration that first
// added the column, breaking the next deploy. Replaying the whole sequence here
// catches such a duplicate before it reaches D1.
class MigrationApplyError extends CodedError {
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

const migrationsDirectory = path.resolve(
	import.meta.dirname,
	'..',
	'packages/server/drizzle-d1'
);

function byCodeUnit(a: string, b: string): number {
	if (a < b) {
		return -1;
	}

	if (a > b) {
		return 1;
	}

	return 0;
}

function main(): void {
	const files = readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql'))
		.toSorted(byCodeUnit);

	const database = new DatabaseSync(':memory:');

	for (const file of files) {
		const statements = readFileSync(
			path.join(migrationsDirectory, file),
			'utf8'
		)
			.split('--> statement-breakpoint')
			.map((statement) => statement.trim())
			.filter((statement) => statement.length > 0);

		for (const statement of statements) {
			try {
				database.prepare(statement).run();
			} catch (error) {
				throw new MigrationApplyError(file, statement, error);
			}
		}
	}

	database.close();

	console.log(`Applied ${String(files.length)} D1 migrations cleanly.`);
}

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
