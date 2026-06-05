import type {
	RetentionPolicyAddBody,
	RetentionPolicyListResponse,
	RetentionPolicyRemoveResponse,
	RetentionPolicySummary,
	RootSetResponse
} from '@cupboard/protocol/retention';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	authorisedFetch,
	initialise,
	mintServerSignedToken,
	resetTestServer
} from './test-support.ts';

const storePath = `/nix/store/${'0'.repeat(32)}-app`;

async function addPolicy(
	token: string,
	body: RetentionPolicyAddBody
): Promise<RetentionPolicySummary> {
	const response = await authorisedFetch('/policies', token, {
		body: JSON.stringify(body),
		headers: { 'content-type': 'application/json' },
		method: 'POST'
	});

	expect(response.status).toBe(StatusCodes.OK);

	return response.json<RetentionPolicySummary>();
}

async function setRoot(token: string, name: string): Promise<RootSetResponse> {
	const response = await authorisedFetch(
		`/roots/${encodeURIComponent(name)}`,
		token,
		{
			body: JSON.stringify({ targets: [storePath] }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		}
	);

	expect(response.status).toBe(StatusCodes.OK);

	return response.json<RootSetResponse>();
}

describe('retention policies', () => {
	beforeEach(resetTestServer);

	it('adds, lists and removes a policy', async () => {
		const token = await initialise();
		const added = await addPolicy(token, {
			scope: 'root-name-prefix',
			pattern: 'pr-',
			ttlSeconds: 604_800
		});

		const listResponse = await authorisedFetch('/policies', token);
		const list = await listResponse.json<RetentionPolicyListResponse>();
		const removeResponse = await authorisedFetch(
			`/policies/${added.id}`,
			token,
			{
				method: 'DELETE'
			}
		);
		const removed = await removeResponse.json<RetentionPolicyRemoveResponse>();
		const afterResponse = await authorisedFetch('/policies', token);
		const after = await afterResponse.json<RetentionPolicyListResponse>();

		expect({
			added: {
				scope: added.scope,
				pattern: added.pattern,
				ttlSeconds: added.ttlSeconds
			},
			listPatterns: list.policies.map((policy) => policy.pattern),
			removed,
			afterPatterns: after.policies.map((policy) => policy.pattern)
		}).toStrictEqual({
			added: { scope: 'root-name-prefix', pattern: 'pr-', ttlSeconds: 604_800 },
			listPatterns: ['pr-'],
			removed: { id: added.id, removed: true },
			afterPatterns: []
		});
	});

	it('applies the matching policy to a root with no explicit TTL', async () => {
		const token = await initialise();
		await addPolicy(token, {
			scope: 'root-name-prefix',
			pattern: 'pr-',
			ttlSeconds: 604_800
		});

		const matched = await setRoot(token, 'pr-9');
		const unmatched = await setRoot(token, 'github:owner/repo/main');

		expect({
			matchedExpires: matched.expiresAt !== undefined,
			unmatchedExpires: unmatched.expiresAt !== undefined
		}).toStrictEqual({ matchedExpires: true, unmatchedExpires: false });
	});

	it('requires admin scope', async () => {
		await initialise();
		const writeToken = await mintServerSignedToken('write');

		const list = await authorisedFetch('/policies', writeToken);
		const add = await authorisedFetch('/policies', writeToken, {
			body: JSON.stringify({
				scope: 'cache',
				pattern: 'builds',
				ttlSeconds: 604_800
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		});

		expect({ list: list.status, add: add.status }).toStrictEqual({
			list: StatusCodes.FORBIDDEN,
			add: StatusCodes.FORBIDDEN
		});
	});
});
