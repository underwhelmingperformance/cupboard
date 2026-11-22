import { startCapture } from '@cupboard/logger/testing';
import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import { trustRuleIdSchema } from '@cupboard/protocol/oidc';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { oidcTrust } from '../db/schema.ts';
import {
	bootstrap,
	createTestAccessKey,
	currentOrigin,
	currentServer,
	resetTestServer
} from '../test-support.ts';

import { OidcTrustService } from './oidc-trust-service.ts';
import { TenantIdentityService } from './tenant-identity-service.ts';

const listGrants = authorizationDetailsSchema.parse([
	{ type: 'cupboard_domain', actions: ['access-key:list'] }
]);

// Rules for other identities. Each one is an enabled row that a verification
// reads when it loads the rules.
async function seedOtherRules(count: number): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		for (let index = 0; index < count; index += 1) {
			instance.context.db
				.insert(oidcTrust)
				.values({
					id: trustRuleIdSchema.parse(`other-${String(index)}`),
					issuer: 'https://idp.test',
					audience: 'cupboard-aud',
					claimsJson: JSON.stringify({ sub: `user-${String(index)}` }),
					permittedGrantsJson: JSON.stringify([{ type: 'cupboard_wildcard' }]),
					createdAt: isoTimestamp(new Date('2026-01-01T00:00:00.000Z'))
				})
				.run();
		}
	});
}

const requestCostSchema = z.object({ rowsRead: z.number() });

/**
The rows that three key-authenticated listings read, each from its own request
scope: the first after the seeded rules changed the revision, the second with
the rules that the first loaded, and the third after removing `rule`. The
listings run in one call to the tenant object, so workerd cannot evict the
object between them, and the second always finds the parsed rules in memory.
*/
async function listingCosts(
	secret: string,
	rule: string
): Promise<{ first?: number; second?: number; afterRuleWrite?: number }> {
	const url = new URL('/access-keys', currentOrigin());
	const headers = { authorization: `Bearer ${secret}` };
	const capture = startCapture();

	try {
		await runInDurableObject(currentServer(), async (instance) => {
			const list = async (): Promise<void> => {
				const response = await instance.fetch(new Request(url, { headers }));
				expect(response.status).toBe(StatusCodes.OK);
				await response.body?.cancel();
			};

			await list();
			await list();
			new OidcTrustService(
				instance.context,
				new TenantIdentityService(instance.context)
			).removeRule(trustRuleIdSchema.parse(rule));
			await list();
		});
	} finally {
		capture.stop();
	}

	const [first, second, afterRuleWrite] = capture.logs
		.filter((entry) => entry.message === 'request finished')
		.map((entry) => requestCostSchema.parse(entry.properties).rowsRead);

	return { first, second, afterRuleWrite };
}

describe('access-key verification cost', () => {
	beforeEach(resetTestServer);

	// The first request loads the enabled rules, and the tenant object keeps
	// them until a rule changes. A later request with the key reads the rule
	// revision and no rule rows, so its cost does not depend on the number of
	// rules in the tenant.
	it.each([
		{ otherRules: 1, cost: { first: 10, second: 4, afterRuleWrite: 9 } },
		{ otherRules: 21, cost: { first: 50, second: 4, afterRuleWrite: 49 } }
	])(
		'reads the trust rules once with $otherRules other rules, and again after a rule write',
		async ({ otherRules, cost }) => {
			await bootstrap();
			const key = await createTestAccessKey(currentServer(), listGrants);
			await seedOtherRules(otherRules);

			expect(await listingCosts(key.secret, 'other-0')).toStrictEqual(cost);
		}
	);
});
