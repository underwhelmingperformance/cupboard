import {
	type AccessKeyCreateResponse,
	accessKeyListResponseSchema
} from '@cupboard/protocol/access-keys';
import {
	type AuthorizationDetails,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import { oidcSubjectSchema, trustRuleIdSchema } from '@cupboard/protocol/oidc';
import { isoTimestamp, isoTimestampSchema } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { accessKeys, narInfos, oidcTrust } from '../db/schema.ts';
import {
	authorisedFetch,
	bootstrap,
	cacheWriteGrants,
	currentServer,
	narBytes,
	pushPath,
	resetTestServer,
	testPushId,
	testTokenIdentity,
	uploadMetadata,
	uploadPathNegotiation
} from '../test-support.ts';

import { type ServerContext } from './context.ts';

const rule = trustRuleIdSchema.parse('alice-rule');

// Installs a rule that allows the identity `alice` every grant, and creates a
// key with `grants` rooted in that identity and rule.
async function aliceKey(
	grants: AuthorizationDetails,
	expiresAt?: Date
): Promise<AccessKeyCreateResponse> {
	await bootstrap();

	return runInDurableObject(currentServer(), async (instance) => {
		instance.context.db
			.insert(oidcTrust)
			.values({
				id: rule,
				issuer: 'https://idp.test',
				audience: 'cupboard-aud',
				claimsJson: JSON.stringify({ sub: 'alice' }),
				permittedGrantsJson: JSON.stringify([{ type: 'cupboard_wildcard' }]),
				createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
			})
			.run();

		return instance.context.accessKeys.create(
			{
				subject: oidcSubjectSchema.parse('alice'),
				identity: testTokenIdentity('alice'),
				ruleId: rule
			},
			{
				grants,
				...(expiresAt !== undefined && {
					expiresAt: isoTimestamp(expiresAt)
				})
			}
		);
	});
}

const listGrants = authorizationDetailsSchema.parse([
	{ type: 'cupboard_domain', actions: ['access-key:list'] }
]);

function listKeys(secret: string): Promise<Response> {
	return authorisedFetch('/access-keys', secret);
}

function storedKeyCount(): Promise<number> {
	return runInDurableObject(
		currentServer(),
		(instance) => instance.context.db.select().from(accessKeys).all().length
	);
}

describe('access-key authentication in the tenant object', () => {
	beforeEach(resetTestServer);

	it('authenticates an admin request with a Bearer access key', async () => {
		const key = await aliceKey(listGrants);
		const response = await listKeys(key.secret);
		const { secret: _secret, ...summary } = key;

		expect({
			status: response.status,
			body: accessKeyListResponseSchema.parse(await response.json())
		}).toStrictEqual({
			status: StatusCodes.OK,
			body: { accessKeys: [summary], unreadableAccessKeys: [] }
		});
	});

	it.each([
		{
			name: 'a wrong secret for a stored key',
			secret: (key: AccessKeyCreateResponse) =>
				key.secret.replace(/[\da-f]{64}$/u, '0'.repeat(64))
		},
		{
			name: 'a malformed key',
			secret: () => 'cupboard_ak_not-a-key'
		}
	])('refuses $name', async ({ secret }) => {
		const key = await aliceKey(listGrants);
		const response = await listKeys(secret(key));

		expect({
			status: response.status,
			stored: await storedKeyCount()
		}).toStrictEqual({ status: StatusCodes.UNAUTHORIZED, stored: 1 });
	});

	it('refuses an expired key', async () => {
		const key = await aliceKey(listGrants, new Date(Date.now() + 60_000));
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.update(accessKeys)
				.set({ expiresAt: isoTimestamp(new Date(0)) })
				.where(eq(accessKeys.id, key.id))
				.run();
		});

		const response = await listKeys(key.secret);

		expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
	});

	it.each([
		{
			name: 'disabled',
			change: (context: ServerContext) => {
				context.db
					.update(oidcTrust)
					.set({ disabledAt: isoTimestamp(new Date()) })
					.where(eq(oidcTrust.id, rule))
					.run();
			}
		},
		{
			name: 'replaced by a rule for another identity',
			change: (context: ServerContext) => {
				context.db
					.update(oidcTrust)
					.set({ claimsJson: JSON.stringify({ sub: 'bob' }) })
					.where(eq(oidcTrust.id, rule))
					.run();
			}
		}
	])(
		'refuses a key whose trust rule is $name and keeps its record',
		async ({ change }) => {
			const key = await aliceKey(listGrants);
			const before = await listKeys(key.secret);
			await runInDurableObject(currentServer(), (instance) => {
				change(instance.context);
			});
			const after = await listKeys(key.secret);

			expect({
				before: before.status,
				after: after.status,
				stored: await storedKeyCount()
			}).toStrictEqual({
				before: StatusCodes.OK,
				after: StatusCodes.UNAUTHORIZED,
				stored: 1
			});
		}
	);

	it('refuses a key whose grants this release cannot read and keeps its record', async () => {
		const key = await aliceKey(listGrants);
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.update(accessKeys)
				.set({
					grantsJson: JSON.stringify([
						{ type: 'cupboard_domain', actions: ['access-key:future'] }
					])
				})
				.where(eq(accessKeys.id, key.id))
				.run();
		});
		const response = await listKeys(key.secret);

		expect({
			status: response.status,
			stored: await storedKeyCount()
		}).toStrictEqual({ status: StatusCodes.UNAUTHORIZED, stored: 1 });
	});

	it('publishes and commits over the WebSocket with a key that has write grants', async () => {
		const key = await aliceKey(cacheWriteGrants());
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(key.secret, metadata);

		const published = await runInDurableObject(currentServer(), (instance) =>
			instance.context.db
				.select({ storePathHash: narInfos.storePathHash })
				.from(narInfos)
				.all()
		);

		expect(published).toStrictEqual([
			{ storePathHash: metadata.storePathHash }
		]);
	});

	it('refuses a publication to a key with only read grants', async () => {
		const key = await aliceKey(
			authorizationDetailsSchema.parse([
				{
					type: 'cupboard_cache',
					cache: { kind: 'default' },
					actions: ['cache:content-read']
				}
			])
		);
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const response = await authorisedFetch('/uploads', key.secret, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				pushId: testPushId,
				paths: [uploadPathNegotiation(metadata)]
			})
		});

		expect(response.status).toBe(StatusCodes.FORBIDDEN);
	});
});
