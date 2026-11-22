import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import { oidcSubjectSchema, trustRuleIdSchema } from '@cupboard/protocol/oidc';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { refreshSessionIdSchema } from '@cupboard/protocol/sessions';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { refreshTokenFamilies } from '../db/schema.ts';
import {
	currentServer,
	latestMigrationIndex,
	migrateThrough,
	resetTestServer,
	testTokenIdentity
} from '../test-support.ts';

import { type AccessKeyCreator } from './access-key-store.ts';
import { type ServerContext } from './context.ts';
import { rowsReadBy } from './operation-cost.test-support.ts';

const grants = authorizationDetailsSchema.parse([
	{
		type: 'cupboard_cache',
		cache: { kind: 'named', name: 'builds' },
		actions: ['cache:content-read']
	}
]);
const aliceSession = refreshSessionIdSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
const otherSession = refreshSessionIdSchema.parse(
	'00000000-0000-4000-8000-000000000002'
);

function creator(
	subject: string,
	session?: typeof aliceSession
): AccessKeyCreator {
	return {
		subject: oidcSubjectSchema.parse(subject),
		identity: testTokenIdentity(subject),
		ruleId: trustRuleIdSchema.parse('acme-admin'),
		...(session !== undefined && { parent: { kind: 'session', id: session } })
	};
}

function insertSession(context: ServerContext, id: string): void {
	context.db
		.insert(refreshTokenFamilies)
		.values({
			id,
			activeMemberId: crypto.randomUUID(),
			generation: 0,
			createdAt: isoTimestamp(new Date('2026-01-01T00:00:00.000Z')),
			expiresAt: isoTimestamp(new Date('2099-01-01T00:00:00.000Z'))
		})
		.run();
}

// Creates two keys in the origin of `measured`, then `otherKeys` keys in two
// other origins: a subject without a session, and another session. Returns
// the rows that one more creation in the measured origin reads. An origin
// count can read the next index entry after its origin, so both measurements
// have keys in other origins.
function creationCost(
	measured: AccessKeyCreator,
	otherKeys: number
): Promise<number> {
	return runInDurableObject(currentServer(), async (instance, state) => {
		await migrateThrough(state, latestMigrationIndex);
		insertSession(instance.context, aliceSession);
		insertSession(instance.context, otherSession);
		const store = instance.context.accessKeys;

		for (let index = 0; index < 2; index += 1) {
			await store.create(measured, { grants });
		}

		for (let index = 0; index < otherKeys; index += 1) {
			await store.create(
				index % 2 === 0 ? creator('bob') : creator('carol', otherSession),
				{ grants }
			);
		}

		return rowsReadBy(() => store.create(measured, { grants }));
	});
}

describe('access-key creation cost', () => {
	beforeEach(resetTestServer);

	// A creation reads the tenant's key count, the parent and the keys of its
	// own origin. Keys in other origins add no rows.
	it.each([
		{
			name: 'a key without a session above it',
			measured: creator('alice'),
			cost: { fewKeys: 5, manyKeys: 5 }
		},
		{
			name: 'a key below a session',
			measured: creator('alice', aliceSession),
			cost: { fewKeys: 9, manyKeys: 9 }
		}
	])(
		'reads the same rows for $name whatever the size of the tenant',
		async ({ measured, cost }) => {
			const fewKeys = await creationCost(measured, 2);
			await resetTestServer();
			const manyKeys = await creationCost(measured, 200);

			expect({ fewKeys, manyKeys }).toStrictEqual(cost);
		}
	);
});
