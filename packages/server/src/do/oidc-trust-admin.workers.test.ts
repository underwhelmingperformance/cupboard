import type {
	OidcTrustAddBody,
	OidcTrustListResponse,
	OidcTrustRemoveResponse,
	OidcTrustSummary
} from '@cupboard/protocol/oidc';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

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

async function adminToken(): Promise<string> {
	await initialise();

	return issueServerSignedToken('admin');
}

function listRules(token: string): Promise<Response> {
	return authorisedFetch('/oidc-trust', token);
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
		const summary = await added.json<OidcTrustSummary>();
		const { id, ...fields } = summary;
		const list = await listRules(token);

		expect(typeof id).toBe('string');
		expect({ status: added.status, fields }).toStrictEqual({
			status: StatusCodes.OK,
			fields: {
				issuer: addBody.issuer,
				audience: addBody.audience,
				scope: 'write',
				claims: addBody.claims,
				allowedRoots: addBody.allowedRoots,
				disabled: false
			}
		});
		expect(await list.json<OidcTrustListResponse>()).toStrictEqual({
			rules: [ownerSummary, summary]
		});
	});

	it('soft-disables a rule and reports it disabled in the listing', async () => {
		const token = await adminToken();
		const added = await addRule(token, addBody);
		const { id } = await added.json<OidcTrustSummary>();

		const removed = await authorisedFetch(`/oidc-trust/${id}`, token, {
			method: 'DELETE'
		});
		const repeat = await authorisedFetch(`/oidc-trust/${id}`, token, {
			method: 'DELETE'
		});
		const list = await listRules(token);

		expect({
			removed: await removed.json<OidcTrustRemoveResponse>(),
			repeat: await repeat.json<OidcTrustRemoveResponse>()
		}).toStrictEqual({
			removed: { id, removed: true },
			repeat: { id, removed: false }
		});
		expect(await list.json<OidcTrustListResponse>()).toStrictEqual({
			rules: [
				ownerSummary,
				{
					id,
					issuer: addBody.issuer,
					audience: addBody.audience,
					scope: 'write',
					claims: addBody.claims,
					allowedRoots: addBody.allowedRoots,
					disabled: true
				}
			]
		});
	});

	it('reports an unknown rule as not removed', async () => {
		const token = await adminToken();

		const response = await authorisedFetch('/oidc-trust/missing', token, {
			method: 'DELETE'
		});

		expect(await response.json<OidcTrustRemoveResponse>()).toStrictEqual({
			id: 'missing',
			removed: false
		});
	});

	it('refuses to remove the owner rule', async () => {
		const token = await adminToken();

		const response = await authorisedFetch('/oidc-trust/owner', token, {
			method: 'DELETE'
		});
		const body = await response.json<{
			code: string;
			status: number;
			message: string;
		}>();

		expect({
			status: response.status,
			code: body.code,
			message: body.message
		}).toStrictEqual({
			status: StatusCodes.CONFLICT,
			code: 'CONFLICT',
			message: 'Cannot change the owner rule; update deploy config instead'
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
