import type {
	OidcTrustAddBody,
	OidcTrustSummary
} from '@cupboard/protocol/oidc';
import {
	oidcTrustListResponseSchema,
	oidcTrustRemoveResponseSchema,
	oidcTrustSummarySchema
} from '@cupboard/protocol/oidc';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	authorisedFetch,
	initialise,
	issueServerSignedToken,
	resetTestServer
} from '../test-support.ts';

const ownerSummary: OidcTrustSummary = {
	id: 'owner',
	issuer: 'https://accounts.google.com',
	audience: 'client-id.apps.googleusercontent.com',
	scope: 'admin',
	claims: { sub: 'owner-subject' },
	allowedRoots: [],
	disabled: false
};

const addBody: OidcTrustAddBody = {
	issuer: 'https://token.actions.githubusercontent.com',
	audience: 'https://cache.example.workers.dev',
	claims: { repository_owner_id: '5678' },
	allowedRoots: ['github:owner/']
};

const orpcErrorBodySchema = z.strictObject({
	code: z.string(),
	defined: z.boolean(),
	message: z.string(),
	status: z.number()
});

async function adminToken(): Promise<string> {
	await initialise();

	return issueServerSignedToken('admin');
}

function listRules(token: string): Promise<Response> {
	return authorisedFetch('/oidc-trust', token);
}

function rulesById(
	response: unknown
): Record<string, z.infer<typeof oidcTrustSummarySchema>> {
	const { rules } = oidcTrustListResponseSchema.parse(response);

	return Object.fromEntries(rules.map((rule) => [rule.id, rule]));
}

function addRule(token: string, body: OidcTrustAddBody): Promise<Response> {
	return authorisedFetch('/oidc-trust', token, {
		body: JSON.stringify(body),
		headers: { 'content-type': 'application/json' },
		method: 'POST'
	});
}

describe('oidc-trust admin API', () => {
	beforeEach(resetTestServer);

	it('adds a write rule and lists it alongside the seeded owner rule', async () => {
		const token = await adminToken();

		const added = await addRule(token, addBody);
		const summary = oidcTrustSummarySchema.parse(await added.json());
		const list = await listRules(token);
		const id = z.uuid().parse(summary.id);

		expect({
			status: added.status,
			summary,
			rules: rulesById(await list.json())
		}).toStrictEqual({
			status: StatusCodes.OK,
			summary: {
				id,
				issuer: addBody.issuer,
				audience: addBody.audience,
				scope: 'write',
				claims: addBody.claims,
				allowedRoots: addBody.allowedRoots,
				disabled: false
			},
			rules: {
				owner: ownerSummary,
				[id]: {
					id,
					issuer: addBody.issuer,
					audience: addBody.audience,
					scope: 'write',
					claims: addBody.claims,
					allowedRoots: addBody.allowedRoots,
					disabled: false
				}
			}
		});
	});

	it('soft-disables a rule and reports it disabled in the listing', async () => {
		const token = await adminToken();
		const added = await addRule(token, addBody);
		const { id } = oidcTrustSummarySchema.parse(await added.json());

		const removed = await authorisedFetch(`/oidc-trust/${id}`, token, {
			method: 'DELETE'
		});
		const repeat = await authorisedFetch(`/oidc-trust/${id}`, token, {
			method: 'DELETE'
		});
		const list = await listRules(token);

		expect({
			removed: oidcTrustRemoveResponseSchema.parse(await removed.json()),
			repeat: oidcTrustRemoveResponseSchema.parse(await repeat.json())
		}).toStrictEqual({
			removed: { id, removed: true },
			repeat: { id, removed: false }
		});
		expect(rulesById(await list.json())).toStrictEqual({
			owner: ownerSummary,
			[id]: {
				id,
				issuer: addBody.issuer,
				audience: addBody.audience,
				scope: 'write',
				claims: addBody.claims,
				allowedRoots: addBody.allowedRoots,
				disabled: true
			}
		});
	});

	it('reports an unknown rule as not removed', async () => {
		const token = await adminToken();

		const response = await authorisedFetch('/oidc-trust/missing', token, {
			method: 'DELETE'
		});

		expect(
			oidcTrustRemoveResponseSchema.parse(await response.json())
		).toStrictEqual({
			id: 'missing',
			removed: false
		});
	});

	it('refuses to remove the owner rule', async () => {
		const token = await adminToken();

		const response = await authorisedFetch('/oidc-trust/owner', token, {
			method: 'DELETE'
		});
		const body = orpcErrorBodySchema.parse(await response.json());

		expect({
			status: response.status,
			defined: body.defined,
			code: body.code
		}).toStrictEqual({
			status: StatusCodes.CONFLICT,
			defined: false,
			code: 'CONFLICT'
		});
	});

	it('refuses a write token', async () => {
		await initialise();
		const token = await issueServerSignedToken('write');

		const response = await listRules(token);

		expect(response.status).toBe(StatusCodes.FORBIDDEN);
	});

	it.each([
		{
			name: 'a rule with no claims to bind it',
			body: { ...addBody, claims: {} }
		},
		{
			name: 'a rule whose issuer is not https',
			body: { ...addBody, issuer: 'http://token.actions.githubusercontent.com' }
		}
	])('refuses $name', async ({ body }) => {
		const token = await adminToken();

		const response = await addRule(token, body);

		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
	});
});
