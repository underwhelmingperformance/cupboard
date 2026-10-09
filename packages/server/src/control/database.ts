import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import { ControlDatabaseMigrationPendingError } from '../errors.ts';

type Database = DrizzleD1Database<typeof d1Schema> & { $client: D1Database };

const readyRowSchema = z.object({ state: z.enum(['copying', 'ready']) });

class ControlDatabaseSelection {
	readonly database: Database;

	constructor(
		private readonly env: Env,
		private readonly isLegacy: boolean
	) {
		this.database = drizzleD1(isLegacy ? env.CUPBOARD_DB : env.CONTROL_DB, {
			schema: d1Schema
		});
	}

	async assertWritable(): Promise<void> {
		if (!this.isLegacy) {
			return;
		}

		const frozen = await this.env.CUPBOARD_DB.withSession('first-primary')
			.prepare("SELECT id FROM control_database_split WHERE id = 'current'")
			.first();

		if (frozen !== null) {
			throw new ControlDatabaseMigrationPendingError();
		}
	}
}

const requestSelections = new WeakMap<
	Env,
	Promise<ControlDatabaseSelection> | undefined
>();

/**
Keeps every control operation in a request on the same database.
*/
export function requestControlEnv(env: Env): Env {
	const requestEnv = new Proxy(env, {});
	requestSelections.set(requestEnv, undefined);

	return requestEnv;
}

async function selectDatabase(env: Env): Promise<ControlDatabaseSelection> {
	const row = await env.CONTROL_DB.withSession('first-primary')
		.prepare("SELECT state FROM control_database_ready WHERE id = 'current'")
		.first();
	const isReady = row !== null && readyRowSchema.parse(row).state === 'ready';

	return new ControlDatabaseSelection(env, !isReady);
}

function selection(env: Env): Promise<ControlDatabaseSelection> {
	const previous = requestSelections.get(env);

	if (previous !== undefined) {
		return previous;
	}

	const selected = selectDatabase(env);

	if (requestSelections.has(env)) {
		requestSelections.set(env, selected);
	}

	return selected;
}

/**
Returns the authoritative control tables, including during a frozen copy.
*/
export async function controlDatabase(env: Env): Promise<Database> {
	const selected = await selection(env);
	return selected.database;
}

/**
Refuses mutations and token issuance while the legacy copy is frozen.
*/
export async function writableControlDatabase(env: Env): Promise<Database> {
	const selected = await selection(env);
	await selected.assertWritable();

	return selected.database;
}
