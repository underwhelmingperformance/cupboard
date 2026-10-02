import { transitionIds } from '@cupboard/protocol/deployment';
import { z } from 'zod';

export interface LocalDevelopmentDatabase {
	query(sql: string): Promise<readonly unknown[]>;
	execute(sql: string): Promise<void>;
}

export class LocalDevelopmentBootstrapRefusedError extends Error {
	constructor() {
		super(
			'Local setup cannot complete deployment transitions for existing application data or an unfinished deployment. Preserve the local Wrangler state directory and use a fresh directory for local development.'
		);
		this.name = 'LocalDevelopmentBootstrapRefusedError';
	}
}

const tableRows = z.array(z.object({ name: z.string() }));
const transitionRows = z.array(z.object({ id: z.string(), state: z.string() }));
const phaseRows = z.array(z.object({ id: z.string(), phase: z.string() }));
const knownTransitions = new Set<string>(transitionIds);

function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

async function checkLocalState(
	database: LocalDevelopmentDatabase
): Promise<void> {
	const tables = tableRows.parse(
		await database.query("SELECT name FROM sqlite_master WHERE type = 'table'")
	);
	const tableNames = new Set(tables.map(({ name }) => name));
	const transitions = tableNames.has('deployment_transition')
		? transitionRows.parse(
				await database.query('SELECT id, state FROM deployment_transition')
			)
		: [];
	if (
		transitions.some(
			({ id, state }) => !knownTransitions.has(id) || state !== 'complete'
		)
	) {
		throw new LocalDevelopmentBootstrapRefusedError();
	}
	if (tableNames.has('deployment_phase')) {
		const phases = phaseRows.parse(
			await database.query('SELECT id, phase FROM deployment_phase')
		);
		if (
			phases.some(
				({ id, phase }) => !knownTransitions.has(id) || phase !== 'contracted'
			)
		) {
			throw new LocalDevelopmentBootstrapRefusedError();
		}
	}
	if (transitionIds.every((id) => transitions.some((row) => row.id === id))) {
		return;
	}
	const persistedTables = tables.filter(
		({ name }) =>
			!name.startsWith('sqlite_') &&
			!name.startsWith('_cf_') &&
			!['d1_migrations', 'deployment_transition', 'deployment_phase'].includes(
				name
			)
	);
	if (persistedTables.length === 0) {
		return;
	}
	const populated = await database.query(
		'SELECT 1 AS populated WHERE ' +
			persistedTables
				.map(
					({ name }) =>
						`EXISTS (SELECT 1 FROM "${name.replaceAll('"', '""')}" LIMIT 1)`
				)
				.join(' OR ')
	);
	if (populated.length > 0) {
		throw new LocalDevelopmentBootstrapRefusedError();
	}
}

export async function bootstrapLocalDevelopment(
	database: LocalDevelopmentDatabase,
	applyMigrations: () => Promise<void>
): Promise<void> {
	await checkLocalState(database);
	await applyMigrations();
	await checkLocalState(database);
	const now = sqlString(new Date().toISOString());
	await database.execute(
		transitionIds
			.map(
				(id) =>
					`INSERT INTO deployment_transition (id, state, updated_at, contracted_at) VALUES (${sqlString(id)}, 'complete', ${now}, ${now}) ON CONFLICT(id) DO NOTHING;`
			)
			.join('\n')
	);
}
