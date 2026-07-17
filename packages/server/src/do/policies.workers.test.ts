import { WIRE_DEFAULT_CACHE } from '@cupboard/nix-store/scalars';
import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import type {
	GracePolicyListResponse,
	GracePolicyRemoveResponse,
	GracePolicySummary,
	RetentionPolicyAddBody,
	RetentionPolicySummary,
	RootSetResponse
} from '@cupboard/protocol/retention';
import {
	graceCoverageResponseSchema,
	gracePolicyListResponseSchema,
	gracePolicyRemoveResponseSchema,
	gracePolicySummarySchema,
	retentionPolicyListResponseSchema,
	retentionPolicyRemoveResponseSchema,
	retentionPolicySummarySchema,
	rootSetResponseSchema
} from '@cupboard/protocol/retention';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

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

const orpcErrorBodySchema = z.strictObject({
	defined: z.boolean(),
	code: z.string(),
	status: z.number(),
	message: z.string(),
	data: z.unknown().optional()
});

function orpcErrorBodyShape(body: unknown): {
	readonly defined: boolean;
	readonly code: string;
	readonly status: number;
} {
	const parsed = orpcErrorBodySchema.parse(body);

	return { defined: parsed.defined, code: parsed.code, status: parsed.status };
}

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

function addGracePolicyRaw(token: string, body: unknown): Promise<Response> {
	return authorisedFetch('/policies/grace', token, {
		body: JSON.stringify(body),
		headers: { 'content-type': 'application/json' },
		method: 'POST'
	});
}

async function addGracePolicy(
	token: string,
	body: { readonly cachePrefix: string; readonly graceSeconds: number }
): Promise<{ readonly status: number; readonly body: GracePolicySummary }> {
	const response = await addGracePolicyRaw(token, body);

	return {
		status: response.status,
		body: gracePolicySummarySchema.parse(await response.json())
	};
}

async function listGracePolicies(token: string): Promise<{
	readonly status: number;
	readonly body: GracePolicyListResponse;
}> {
	const response = await authorisedFetch('/policies/grace', token);

	return {
		status: response.status,
		body: gracePolicyListResponseSchema.parse(await response.json())
	};
}

async function removeGracePolicy(
	token: string,
	id: string
): Promise<{
	readonly status: number;
	readonly body: GracePolicyRemoveResponse;
}> {
	const response = await authorisedFetch(
		`/policies/grace/${encodeURIComponent(id)}`,
		token,
		{ method: 'DELETE' }
	);

	return {
		status: response.status,
		body: gracePolicyRemoveResponseSchema.parse(await response.json())
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
		const removalResponse = await authorisedFetch(
			`/policies/${added.body.id}`,
			token,
			{
				method: 'DELETE'
			}
		);
		const removed = retentionPolicyRemoveResponseSchema.parse(
			await removalResponse.json()
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
			removeStatus: removalResponse.status,
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

describe('retention grace policies', () => {
	beforeEach(resetTestServer);

	it('adds, lists and removes a grace policy', async () => {
		const token = await initialise();
		const added = await addGracePolicy(token, {
			cachePrefix: 'pr-',
			graceSeconds: 86_400
		});

		const listResponse = await listGracePolicies(token);
		const removed = await removeGracePolicy(token, added.body.id);
		const afterResponse = await listGracePolicies(token);

		expect({
			addStatus: added.status,
			added: {
				cachePrefix: added.body.cachePrefix,
				graceSeconds: added.body.graceSeconds
			},
			listStatus: listResponse.status,
			listPrefixes: listResponse.body.policies.map(
				(policy) => policy.cachePrefix
			),
			removeStatus: removed.status,
			removed: removed.body,
			afterStatus: afterResponse.status,
			afterPrefixes: afterResponse.body.policies.map(
				(policy) => policy.cachePrefix
			)
		}).toStrictEqual({
			addStatus: StatusCodes.OK,
			added: { cachePrefix: 'pr-', graceSeconds: 86_400 },
			listStatus: StatusCodes.OK,
			listPrefixes: ['pr-'],
			removeStatus: StatusCodes.OK,
			removed: { id: added.body.id, removed: true },
			afterStatus: StatusCodes.OK,
			afterPrefixes: []
		});
	});

	it('accepts the empty (tenant-wide default) prefix', async () => {
		const token = await initialise();

		const added = await addGracePolicy(token, {
			cachePrefix: '',
			graceSeconds: 86_400
		});

		expect({
			status: added.status,
			cachePrefix: added.body.cachePrefix,
			graceSeconds: added.body.graceSeconds
		}).toStrictEqual({
			status: StatusCodes.OK,
			cachePrefix: '',
			graceSeconds: 86_400
		});
	});

	it('accepts a zero grace', async () => {
		const token = await initialise();

		const added = await addGracePolicy(token, {
			cachePrefix: 'pr-',
			graceSeconds: 0
		});

		expect({
			status: added.status,
			graceSeconds: added.body.graceSeconds
		}).toStrictEqual({ status: StatusCodes.OK, graceSeconds: 0 });
	});

	it('upserts on a duplicate prefix, keeping its id and replacing its grace', async () => {
		const token = await initialise();

		const first = await addGracePolicy(token, {
			cachePrefix: 'pr-',
			graceSeconds: 86_400
		});
		const second = await addGracePolicy(token, {
			cachePrefix: 'pr-',
			graceSeconds: 3600
		});
		const listed = await listGracePolicies(token);

		expect({
			firstStatus: first.status,
			secondStatus: second.status,
			sameId: second.body.id === first.body.id,
			secondGraceSeconds: second.body.graceSeconds,
			listedPolicies: listed.body.policies.map((policy) => ({
				id: policy.id,
				cachePrefix: policy.cachePrefix,
				graceSeconds: policy.graceSeconds
			}))
		}).toStrictEqual({
			firstStatus: StatusCodes.OK,
			secondStatus: StatusCodes.OK,
			sameId: true,
			secondGraceSeconds: 3600,
			listedPolicies: [
				{ id: first.body.id, cachePrefix: 'pr-', graceSeconds: 3600 }
			]
		});
	});

	it.each([
		{
			name: 'a negative grace',
			body: { cachePrefix: 'pr-', graceSeconds: -1 }
		},
		{
			name: 'a grace beyond the root TTL bound',
			body: { cachePrefix: 'pr-', graceSeconds: 315_360_001 }
		}
	])('rejects $name', async ({ body }) => {
		const token = await initialise();

		const response = await addGracePolicyRaw(token, body);
		const errorBody = orpcErrorBodyShape(await response.json());

		expect({ status: response.status, errorBody }).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			errorBody: {
				defined: false,
				code: 'BAD_REQUEST',
				status: StatusCodes.BAD_REQUEST
			}
		});
	});

	it('requires admin scope', async () => {
		await initialise();
		const writeToken = await issueServerSignedToken(cacheWriteGrants());

		const list = await authorisedFetch('/policies/grace', writeToken);
		const add = await addGracePolicyRaw(writeToken, {
			cachePrefix: 'pr-',
			graceSeconds: 86_400
		});

		expect({ list: list.status, add: add.status }).toStrictEqual({
			list: StatusCodes.FORBIDDEN,
			add: StatusCodes.FORBIDDEN
		});
	});
});

async function graceCoverage(
	token: string,
	cacheSelector: string
): Promise<{ readonly status: number; readonly body: unknown }> {
	const response = await authorisedFetch(
		`/cache/${encodeURIComponent(cacheSelector)}/grace-coverage`,
		token
	);

	return { status: response.status, body: await response.json() };
}

describe('grace coverage', () => {
	beforeEach(resetTestServer);

	it('resolves the longest matching prefix per cache and answers misses as uncovered', async () => {
		const token = await initialise();
		await addGracePolicy(token, { cachePrefix: '', graceSeconds: 86_400 });
		await addGracePolicy(token, { cachePrefix: 'pr-', graceSeconds: 3600 });

		const pullRequestCache = await graceCoverage(token, 'pr-7');
		const defaultCache = await graceCoverage(token, WIRE_DEFAULT_CACHE);

		expect({ pullRequestCache, defaultCache }).toStrictEqual({
			pullRequestCache: {
				status: StatusCodes.OK,
				body: graceCoverageResponseSchema.parse({
					covered: true,
					graceSeconds: 3600
				})
			},
			defaultCache: {
				status: StatusCodes.OK,
				body: graceCoverageResponseSchema.parse({
					covered: true,
					graceSeconds: 86_400
				})
			}
		});
	});

	it('answers uncovered when no policy matches', async () => {
		const token = await initialise();

		const coverage = await graceCoverage(token, WIRE_DEFAULT_CACHE);

		expect(coverage).toStrictEqual({
			status: StatusCodes.OK,
			body: graceCoverageResponseSchema.parse({ covered: false })
		});
	});

	it('is readable with a confirm-scoped token, without the policy-admin scope', async () => {
		const adminToken = await initialise();
		await addGracePolicy(adminToken, { cachePrefix: '', graceSeconds: 86_400 });
		const confirmToken = await issueServerSignedToken(
			authorizationDetailsSchema.parse([
				{
					type: 'cupboard_cache',
					actions: ['upload:confirm'],
					cache: WIRE_DEFAULT_CACHE
				}
			])
		);
		const commitOnlyToken = await issueServerSignedToken(cacheWriteGrants());

		const coverage = await graceCoverage(confirmToken, WIRE_DEFAULT_CACHE);
		const commitOnly = await graceCoverage(commitOnlyToken, WIRE_DEFAULT_CACHE);
		const refusedList = await authorisedFetch('/policies/grace', confirmToken);

		// The token that can confirm a publication can read coverage. A presented
		// commit grant does not imply runtime confirm authority, so it cannot,
		// and the policy-admin listing stays refused to both.
		expect({
			coverageStatus: coverage.status,
			coverageBody: coverage.body,
			commitOnlyStatus: commitOnly.status,
			refusedListStatus: refusedList.status
		}).toStrictEqual({
			coverageStatus: StatusCodes.OK,
			coverageBody: graceCoverageResponseSchema.parse({
				covered: true,
				graceSeconds: 86_400
			}),
			commitOnlyStatus: StatusCodes.FORBIDDEN,
			refusedListStatus: StatusCodes.FORBIDDEN
		});
	});
});
