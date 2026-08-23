import {
	issuedAccessTokenType,
	oidcIssuerSchema,
	oidcSubjectSchema,
	refreshTokenGrantType,
	tokenExchangeGrantType
} from '@cupboard/protocol/oidc';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { asc } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { sha256Hex } from '../crypto/crypto.ts';
import * as schema from '../db/schema.ts';
import { ownerRuleId } from '../do/context.ts';
import { decodeInboundClaims } from '../oidc/oidc.ts';
import {
	adminGrants,
	currentOrigin,
	handlerFetch,
	issueTokenForTenant,
	provisionNamedTenant,
	resetTestServer,
	suspendTenant,
	testServerFor
} from '../test-support.ts';

import { fixtureTenant } from './tenant-routing.test-support.ts';

const stringArraySchema = z.array(z.string());
const tokenClaimsSchema = z.object({
	iss: z.string().optional(),
	aud: z.union([z.string(), stringArraySchema]).optional()
});

function decodeClaims(token: string): z.infer<typeof tokenClaimsSchema> {
	return tokenClaimsSchema.parse(decodeInboundClaims(token));
}

function bearer(token: string): RequestInit {
	return { headers: { authorization: `Bearer ${token}` } };
}

function writeRequest(): RequestInit {
	return {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{}'
	};
}

function tokenRequest(fields: Readonly<Record<string, string>>): RequestInit {
	return {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(fields).toString()
	};
}

interface RefreshFixture {
	readonly token: string;
	readonly family: typeof schema.refreshTokenFamilies.$inferSelect;
	readonly member: typeof schema.refreshTokenMembers.$inferSelect;
}

async function seedRefreshFamily(): Promise<RefreshFixture> {
	const familyId = 'suspended-family';
	const memberId = 'suspended-member';
	const secret = 'suspended-refresh-secret';
	const createdAt = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
	const expiresAt = isoTimestampSchema.parse('2099-01-01T00:00:00.000Z');
	const family = {
		id: familyId,
		activeMemberId: memberId,
		generation: 0,
		ruleId: ownerRuleId,
		subject: oidcSubjectSchema.parse('route-test'),
		grantsJson: JSON.stringify([{ type: 'cupboard_wildcard' }]),
		createdAt,
		expiresAt
	} as const satisfies typeof schema.refreshTokenFamilies.$inferInsert;
	const member = {
		id: memberId,
		familyId,
		generation: 0,
		secretHash: await sha256Hex(secret),
		createdAt
	} as const satisfies typeof schema.refreshTokenMembers.$inferInsert;

	await runInDurableObject(testServerFor(fixtureTenant), (instance) => {
		instance.context.db.transaction((transaction) => {
			transaction.insert(schema.refreshTokenFamilies).values(family).run();
			transaction.insert(schema.refreshTokenMembers).values(member).run();
		});
	});

	return {
		token: `${memberId}.${secret}`,
		family: { ...family },
		member: { ...member }
	};
}

async function refreshRows(): Promise<{
	readonly families: (typeof schema.refreshTokenFamilies.$inferSelect)[];
	readonly members: (typeof schema.refreshTokenMembers.$inferSelect)[];
}> {
	return runInDurableObject(testServerFor(fixtureTenant), (instance) => ({
		families: instance.context.db
			.select()
			.from(schema.refreshTokenFamilies)
			.orderBy(asc(schema.refreshTokenFamilies.id))
			.all(),
		members: instance.context.db
			.select()
			.from(schema.refreshTokenMembers)
			.orderBy(asc(schema.refreshTokenMembers.id))
			.all()
	}));
}

const authorizationServerMetadataSchema = z.strictObject({
	issuer: z.string(),
	token_endpoint: z.string(),
	jwks_uri: z.string(),
	response_types_supported: z.array(z.string()),
	grant_types_supported: z.array(z.string()),
	authorization_details_types_supported: z.array(z.string()),
	token_endpoint_auth_methods_supported: z.array(z.string())
});

describe('tenant routing', () => {
	beforeEach(resetTestServer);

	it('advertises the tenant path-based issuer in its AS metadata', async () => {
		await provisionNamedTenant('acme');

		const response = await handlerFetch(
			'/t/acme/.well-known/oauth-authorization-server'
		);
		const base = `${currentOrigin()}/t/acme`;

		expect({
			status: response.status,
			body: authorizationServerMetadataSchema.parse(await response.json())
		}).toStrictEqual({
			status: StatusCodes.OK,
			body: {
				issuer: base,
				token_endpoint: `${base}/token`,
				jwks_uri: `${base}/.well-known/jwks.json`,
				response_types_supported: [],
				grant_types_supported: [tokenExchangeGrantType, refreshTokenGrantType],
				authorization_details_types_supported: [
					'cupboard_cache',
					'cupboard_domain',
					'cupboard_wildcard'
				],
				token_endpoint_auth_methods_supported: ['none']
			}
		});
	});

	it('advertises the canonical tenant identity through an alias origin', async () => {
		const issuer = await provisionNamedTenant('acme');
		const response = await handlerFetch(
			'https://preview.example.test/t/acme/.well-known/oauth-authorization-server'
		);
		const body = authorizationServerMetadataSchema.parse(await response.json());

		expect({ status: response.status, body }).toStrictEqual({
			status: StatusCodes.OK,
			body: {
				issuer,
				token_endpoint: `${issuer}/token`,
				jwks_uri: `${issuer}/.well-known/jwks.json`,
				response_types_supported: [],
				grant_types_supported: [tokenExchangeGrantType, refreshTokenGrantType],
				authorization_details_types_supported: [
					'cupboard_cache',
					'cupboard_domain',
					'cupboard_wildcard'
				],
				token_endpoint_auth_methods_supported: ['none']
			}
		});
	});

	it('serves tenant metadata at the RFC 8414 path-derived URL', async () => {
		await provisionNamedTenant('acme');

		const response = await handlerFetch(
			'/.well-known/oauth-authorization-server/t/acme'
		);

		expect({
			status: response.status,
			issuer: authorizationServerMetadataSchema.parse(await response.json())
				.issuer
		}).toStrictEqual({
			status: StatusCodes.OK,
			issuer: `${currentOrigin()}/t/acme`
		});
	});

	it('issues under its own issuer, and that token verifies at that tenant only', async () => {
		const acmeIssuer = await provisionNamedTenant('acme');
		await provisionNamedTenant('beta');
		const token = await issueTokenForTenant(
			testServerFor('acme'),
			acmeIssuer,
			adminGrants()
		);
		const claims = decodeClaims(token);

		const atAcme = await handlerFetch('/t/acme/keys/auth', bearer(token));
		const atBeta = await handlerFetch('/t/beta/keys/auth', bearer(token));

		expect({
			iss: claims.iss,
			aud: claims.aud,
			atAcme: atAcme.status,
			atBeta: atBeta.status
		}).toStrictEqual({
			iss: `${currentOrigin()}/t/acme`,
			aud: `${currentOrigin()}/t/acme`,
			atAcme: StatusCodes.OK,
			atBeta: StatusCodes.UNAUTHORIZED
		});
	});

	it('returns 500 for an admitted tenant whose Durable Object is unconfigured', async () => {
		await provisionNamedTenant('gamma', { configure: false });

		const jwks = await handlerFetch('/t/gamma/.well-known/jwks.json');
		const asMetadata = await handlerFetch(
			'/t/gamma/.well-known/oauth-authorization-server'
		);

		// Both the key set and the AS metadata route to the Durable Object, so an
		// unconfigured tenant advertises no identity.
		expect({ jwks: jwks.status, asMetadata: asMetadata.status }).toStrictEqual({
			jwks: StatusCodes.INTERNAL_SERVER_ERROR,
			asMetadata: StatusCodes.INTERNAL_SERVER_ERROR
		});
	});

	it('stops reads as soon as the authoritative tenant row is suspended', async () => {
		const active = await handlerFetch(
			`/t/${fixtureTenant}/.well-known/jwks.json`
		);

		await suspendTenant(fixtureTenant);

		const suspended = await handlerFetch(
			`/t/${fixtureTenant}/.well-known/jwks.json`
		);

		expect({
			active: active.status,
			suspended: suspended.status
		}).toStrictEqual({
			active: StatusCodes.OK,
			suspended: StatusCodes.NOT_FOUND
		});
	});

	it('rejects an unprovisioned slug without instantiating a Durable Object', async () => {
		const response = await handlerFetch('/t/ghost/.well-known/jwks.json');

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
	});

	it('dispatches a named tenant write to its Durable Object to authorise', async () => {
		await provisionNamedTenant('acme');

		const response = await handlerFetch(
			'/t/acme/cache/_default/uploads',
			writeRequest()
		);

		expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
	});

	it('stops writes to a suspended fixture tenant on the authoritative D1 status', async () => {
		await suspendTenant(fixtureTenant);

		const response = await handlerFetch(
			`/t/${fixtureTenant}/cache/_default/uploads`,
			writeRequest()
		);

		expect(response.status).toBe(StatusCodes.FORBIDDEN);
	});

	it('refuses token exchange and refresh for a suspended tenant without rotating the family', async () => {
		const issuer = oidcIssuerSchema.parse(
			`${currentOrigin()}/t/${fixtureTenant}`
		);
		const accessToken = await issueTokenForTenant(
			testServerFor(fixtureTenant),
			issuer,
			adminGrants()
		);
		const refresh = await seedRefreshFamily();

		await suspendTenant(fixtureTenant);

		const exchanged = await handlerFetch(
			`/t/${fixtureTenant}/token`,
			tokenRequest({
				grant_type: tokenExchangeGrantType,
				subject_token: accessToken,
				subject_token_type: issuedAccessTokenType
			})
		);
		const rotated = await handlerFetch(
			`/t/${fixtureTenant}/token`,
			tokenRequest({
				grant_type: refreshTokenGrantType,
				refresh_token: refresh.token
			})
		);

		expect({
			exchangeStatus: exchanged.status,
			refreshStatus: rotated.status,
			rows: await refreshRows()
		}).toStrictEqual({
			exchangeStatus: StatusCodes.FORBIDDEN,
			refreshStatus: StatusCodes.FORBIDDEN,
			rows: { families: [refresh.family], members: [refresh.member] }
		});
	});
});
