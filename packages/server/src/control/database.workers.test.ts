import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { testControlDatabase } from '../control-database.test-support.ts';
import {
	ControlDatabaseMigrationPendingError,
	InvalidAccessTokenError
} from '../errors.ts';
import {
	currentOrigin,
	issueControlAdminToken,
	testControlEnv
} from '../test-support.ts';

import { controlAuthenticate } from './control-plane.ts';
import {
	controlDatabase,
	requestControlEnv,
	writableControlDatabase
} from './database.ts';

function controlEnv(): Env {
	return Object.assign({}, env, testControlEnv);
}

async function ready(): Promise<void> {
	await testControlDatabase()
		.prepare(
			"INSERT INTO control_database_ready (id, source_database_id, state) VALUES ('current', 'shared', 'ready')"
		)
		.run();
}

describe('control database selection', () => {
	it('uses the legacy database until the target is ready', async () => {
		const selected = await controlDatabase(controlEnv());
		await ready();
		const target = await controlDatabase(controlEnv());

		expect({ legacy: selected.$client, ready: target.$client }).toStrictEqual({
			legacy: env.CUPBOARD_DB,
			ready: testControlDatabase()
		});
	});

	it('pins the selected database throughout a request', async () => {
		const requestEnv = requestControlEnv(controlEnv());
		const before = await controlDatabase(requestEnv);
		await env.CUPBOARD_DB.prepare(
			"INSERT INTO control_database_split (id, target_database_id, frozen_at) VALUES ('current', 'control', '2026-01-01T00:00:00.000Z')"
		).run();
		await ready();
		const after = await controlDatabase(requestEnv);

		expect({ before: before.$client, after: after.$client }).toStrictEqual({
			before: env.CUPBOARD_DB,
			after: env.CUPBOARD_DB
		});
		await expect(writableControlDatabase(requestEnv)).rejects.toThrow(
			ControlDatabaseMigrationPendingError
		);
	});

	it('stops accepting a key present only in the legacy database after cutover', async () => {
		const token = await issueControlAdminToken();
		await ready();
		const request = new Request(`${currentOrigin()}/control/keys`, {
			headers: { authorization: `Bearer ${token}` }
		});

		await expect(controlAuthenticate(request, controlEnv())).rejects.toThrow(
			InvalidAccessTokenError
		);
	});

	it('refuses legacy mutations while preserving cutover authentication reads', async () => {
		await env.CUPBOARD_DB.prepare(
			"INSERT INTO control_database_split (id, target_database_id, frozen_at) VALUES ('current', 'control', '2026-01-01T00:00:00.000Z')"
		).run();

		const selected = await controlDatabase(controlEnv());
		expect(selected.$client).toBe(env.CUPBOARD_DB);
		await expect(writableControlDatabase(controlEnv())).rejects.toThrow(
			ControlDatabaseMigrationPendingError
		);
		await ready();
		const target = await writableControlDatabase(controlEnv());
		expect(target.$client).toBe(testControlDatabase());
	});

	it('does not fall back to legacy when target readiness cannot be read', async () => {
		const source = controlEnv();
		const failing = new Proxy(source.CONTROL_DB, {
			get(target, property) {
				if (property === 'withSession') {
					return () => {
						throw new Error('target unavailable');
					};
				}

				const value: unknown = Reflect.get(target, property, target);
				return value;
			}
		});

		await expect(
			controlDatabase({ ...source, CONTROL_DB: failing })
		).rejects.toThrow('target unavailable');
	});
});
