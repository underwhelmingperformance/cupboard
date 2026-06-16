import type {
	RetentionPolicyAddBody,
	RetentionPolicySummary,
	RootSetResponse
} from '@cupboard/protocol/retention';
import {
	retentionPolicyListResponseSchema,
	retentionPolicyRemoveResponseSchema,
	retentionPolicySummarySchema,
	rootSetResponseSchema
} from '@cupboard/protocol/retention';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	authorisedFetch,
	cacheWriteGrants,
	initialise,
	issueServerSignedToken,
	narBytes,
	pushPath,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

const storePathHash = '0'.repeat(32);
const storePath = `/nix/store/${storePathHash}-app`;

async function addPolicy(
	token: string,
	body: RetentionPolicyAddBody
): Promise<{ readonly status: number; readonly body: RetentionPolicySummary }> {
	const response = await authorisedFetch('/policies', token, {
		body: JSON.stringify(body),
		headers: { 'content-type': 'application/json' },
		method: 'POST'
	});

	return {
		status: response.status,
		body: retentionPolicySummarySchema.parse(await response.json())
	};
}

async function setRoot(
	token: string,
	name: string
): Promise<{ readonly status: number; readonly body: RootSetResponse }> {
	const response = await authorisedFetch(
		`/cache/_default/roots/${encodeURIComponent(name)}`,
		token,
		{
			body: JSON.stringify({ targets: [storePath] }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		}
	);

	return {
		status: response.status,
		body: rootSetResponseSchema.parse(await response.json())
	};
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
		const list = retentionPolicyListResponseSchema.parse(
			await listResponse.json()
		);
		const removeResponse = await authorisedFetch(
			`/policies/${added.body.id}`,
			token,
			{
				method: 'DELETE'
			}
		);
		const removed = retentionPolicyRemoveResponseSchema.parse(
			await removeResponse.json()
		);
		const afterResponse = await authorisedFetch('/policies', token);
		const after = retentionPolicyListResponseSchema.parse(
			await afterResponse.json()
		);

		expect({
			addStatus: added.status,
			added: {
				scope: added.body.scope,
				pattern: added.body.pattern,
				ttlSeconds: added.body.ttlSeconds
			},
			listStatus: listResponse.status,
			listPatterns: list.policies.map((policy) => policy.pattern),
			removeStatus: removeResponse.status,
			removed,
			afterStatus: afterResponse.status,
			afterPatterns: after.policies.map((policy) => policy.pattern)
		}).toStrictEqual({
			addStatus: StatusCodes.OK,
			added: { scope: 'root-name-prefix', pattern: 'pr-', ttlSeconds: 604_800 },
			listStatus: StatusCodes.OK,
			listPatterns: ['pr-'],
			removeStatus: StatusCodes.OK,
			removed: { id: added.body.id, removed: true },
			afterStatus: StatusCodes.OK,
			afterPatterns: []
		});
	});

	it('applies the matching policy to a root with no explicit TTL', async () => {
		const token = await initialise();
		// Activation gates on servability, so the root target must be committed first.
		await pushPath(
			token,
			uploadMetadata({
				fileSize: narBytes.byteLength,
				storePathHash,
				name: 'app'
			})
		);
		const policy = await addPolicy(token, {
			scope: 'root-name-prefix',
			pattern: 'pr-',
			ttlSeconds: 604_800
		});

		const matched = await setRoot(token, 'pr-9');
		const unmatched = await setRoot(token, 'github:owner/repo/main');

		expect({
			policyStatus: policy.status,
			matchedStatus: matched.status,
			matchedExpires: matched.body.expiresAt !== undefined,
			unmatchedStatus: unmatched.status,
			unmatchedExpires: unmatched.body.expiresAt !== undefined
		}).toStrictEqual({
			policyStatus: StatusCodes.OK,
			matchedStatus: StatusCodes.OK,
			matchedExpires: true,
			unmatchedStatus: StatusCodes.OK,
			unmatchedExpires: false
		});
	});

	it('requires admin scope', async () => {
		await initialise();
		const writeToken = await issueServerSignedToken(cacheWriteGrants());

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
