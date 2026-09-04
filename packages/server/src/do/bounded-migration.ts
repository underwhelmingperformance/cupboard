import { sql } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

export interface LocalMigrationPage {
	readonly kind: 'page';
	readonly name: string;
	readonly source: string;
	readonly upperBound?: string;
	readonly writesPerSourceRow: number;
	readonly statements: (cursor: number, last: number) => readonly string[];
}

export interface LocalMigrationBatch {
	readonly kind: 'batch';
	readonly name: string;
	readonly statements: readonly string[];
}

export type LocalMigrationStage = LocalMigrationBatch | LocalMigrationPage;

export interface LocalMigrationRecipe {
	readonly tag: string;
	readonly rowsPerPage: number;
	readonly sourceRowsPerInvocation: number;
	readonly structuralOperationsPerInvocation: number;
	readonly stages: readonly LocalMigrationStage[];
}

export interface LocalMigrationPending {
	readonly kind: 'pending';
	readonly migration: string;
	readonly stage: string;
	readonly cursor: number;
	readonly sourceRows: number;
	readonly declaredSourceWrites: number;
}

export interface LocalMigrationComplete {
	readonly kind: 'complete';
}

export type LocalMigrationResult =
	LocalMigrationComplete | LocalMigrationPending;

export interface LocalMigrationBudget {
	sourceRowsRemaining: number;
	structuralOperationsRemaining: number;
}

export const localMigrationStructuralOperationLimit = 365;

export function localMigrationBudget(): LocalMigrationBudget {
	return {
		sourceRowsRemaining: 1000,
		structuralOperationsRemaining: localMigrationStructuralOperationLimit
	};
}

type MigrationDatabase<TSchema extends Record<string, unknown>> =
	DrizzleSqliteDODatabase<TSchema>;

const progressTable = '__bounded_migration_progress';

interface Progress {
	readonly cursor: number;
	readonly stage: number;
}

function ensureProgress<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>
): void {
	database.run(
		sql.raw(`CREATE TABLE IF NOT EXISTS ${progressTable} (
		migration TEXT PRIMARY KEY,
		stage INTEGER NOT NULL,
		cursor INTEGER NOT NULL,
		updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`)
	);
}

function readProgress<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>,
	tag: string
): Progress {
	const row = database.values(
		sql`SELECT stage, cursor FROM ${sql.identifier(progressTable)} WHERE migration = ${tag}`
	)[0];

	if (row === undefined) {
		return { stage: 0, cursor: 0 };
	}

	const progress = {
		stage: Number(row[0]),
		cursor: Number(row[1])
	};

	if (
		!Number.isSafeInteger(progress.stage) ||
		progress.stage < 0 ||
		!Number.isSafeInteger(progress.cursor) ||
		progress.cursor < 0
	) {
		throw new Error(`Invalid bounded migration progress for ${tag}`);
	}

	return progress;
}

function saveProgress<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>,
	tag: string,
	progress: Progress
): void {
	database.run(
		sql`INSERT INTO ${sql.identifier(progressTable)} (migration, stage, cursor, updated_at)
		VALUES (${tag}, ${progress.stage}, ${progress.cursor}, CURRENT_TIMESTAMP)
		ON CONFLICT (migration) DO UPDATE SET
			stage = excluded.stage,
			cursor = excluded.cursor,
			updated_at = excluded.updated_at`
	);
}

function pageEnd<TSchema extends Record<string, unknown>>(
	database: MigrationDatabase<TSchema>,
	stage: LocalMigrationPage,
	cursor: number,
	limit: number
): { readonly count: number; readonly last: number } {
	const row = database.values(
		sql.raw(`SELECT count(*), coalesce(max(rowid), ${String(cursor)}) FROM (
		SELECT rowid FROM \`${stage.source}\`
		WHERE rowid > ${String(cursor)}${stage.upperBound === undefined ? '' : ` AND rowid <= (${stage.upperBound})`}
		ORDER BY rowid LIMIT ${String(limit)}
	)`)
	)[0];

	return {
		count: Number(row?.[0] ?? 0),
		last: Number(row?.[1] ?? cursor)
	};
}

/**
Runs source pages within one row allowance and commits each cursor atomically.
*/
export function runBoundedLocalMigration<
	TSchema extends Record<string, unknown>
>(
	database: MigrationDatabase<TSchema>,
	recipe: LocalMigrationRecipe,
	budget: LocalMigrationBudget = localMigrationBudget()
): LocalMigrationResult {
	ensureProgress(database);
	let progress = readProgress(database, recipe.tag);
	let structuralOperations = 0;
	let sourceRows = 0;
	let declaredSourceWrites = 0;

	for (;;) {
		const stage = recipe.stages[progress.stage];

		if (stage === undefined) {
			return { kind: 'complete' };
		}

		if (stage.kind === 'batch') {
			const operationCount = stage.statements.length + 1;

			if (
				operationCount > recipe.structuralOperationsPerInvocation ||
				operationCount > localMigrationStructuralOperationLimit
			) {
				throw new Error(
					`Bounded migration ${recipe.tag} stage ${stage.name} has ${String(operationCount)} structural operations; its per-invocation limit is ${String(recipe.structuralOperationsPerInvocation)}`
				);
			}

			if (
				structuralOperations + operationCount >
					recipe.structuralOperationsPerInvocation ||
				operationCount > budget.structuralOperationsRemaining
			) {
				return {
					kind: 'pending',
					migration: recipe.tag,
					stage: stage.name,
					cursor: progress.cursor,
					sourceRows,
					declaredSourceWrites
				};
			}

			database.transaction((tx) => {
				for (const statement of stage.statements) {
					tx.run(sql.raw(statement));
				}

				saveProgress(tx, recipe.tag, {
					...progress,
					stage: progress.stage + 1,
					cursor: 0
				});
			});
			progress = { stage: progress.stage + 1, cursor: 0 };
			structuralOperations += operationCount;
			budget.structuralOperationsRemaining -= operationCount;
			continue;
		}

		if (
			structuralOperations + 2 > recipe.structuralOperationsPerInvocation ||
			budget.structuralOperationsRemaining < 2
		) {
			return {
				kind: 'pending',
				migration: recipe.tag,
				stage: stage.name,
				cursor: progress.cursor,
				sourceRows,
				declaredSourceWrites
			};
		}

		const remainingSourceRows = Math.min(
			recipe.sourceRowsPerInvocation - sourceRows,
			budget.sourceRowsRemaining
		);

		if (remainingSourceRows <= 0) {
			return {
				kind: 'pending',
				migration: recipe.tag,
				stage: stage.name,
				cursor: progress.cursor,
				sourceRows,
				declaredSourceWrites
			};
		}

		const pageLimit = Math.min(recipe.rowsPerPage, remainingSourceRows);

		let page: { readonly count: number; readonly last: number } | undefined;
		database.transaction((tx) => {
			page = pageEnd(tx, stage, progress.cursor, pageLimit);

			if (page.count === 0) {
				saveProgress(tx, recipe.tag, {
					...progress,
					stage: progress.stage + 1,
					cursor: 0
				});
				return;
			}

			for (const statement of stage.statements(progress.cursor, page.last)) {
				tx.run(sql.raw(statement));
			}

			const isExhausted = page.count < pageLimit;
			saveProgress(
				tx,
				recipe.tag,
				isExhausted
					? { stage: progress.stage + 1, cursor: 0 }
					: { ...progress, cursor: page.last }
			);
		});

		if (page === undefined) {
			throw new Error(`Bounded migration ${recipe.tag} produced no page`);
		}

		if (page.count === 0) {
			progress = { stage: progress.stage + 1, cursor: 0 };
			structuralOperations += 2;
			budget.structuralOperationsRemaining -= 2;
			continue;
		}

		sourceRows += page.count;
		declaredSourceWrites += page.count * stage.writesPerSourceRow;
		budget.sourceRowsRemaining -= page.count;

		if (page.count < pageLimit) {
			progress = { stage: progress.stage + 1, cursor: 0 };
			continue;
		}

		return {
			kind: 'pending',
			migration: recipe.tag,
			stage: stage.name,
			cursor: page.last,
			sourceRows,
			declaredSourceWrites
		};
	}
}

export function clearBoundedLocalMigration<
	TSchema extends Record<string, unknown>
>(database: MigrationDatabase<TSchema>): void {
	database.run(sql.raw(`DROP TABLE ${progressTable}`));
}
