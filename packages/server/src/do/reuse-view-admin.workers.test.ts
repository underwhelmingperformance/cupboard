import type {
	ReuseViewListResponse,
	ReuseViewRemoveResponse,
	ReuseViewSetBodyInput,
	ReuseViewSummary
} from '@cupboard/protocol/reuse-views';
import {
	reuseViewListResponseSchema,
	reuseViewMaxSelectors,
	reuseViewRemoveResponseSchema,
	reuseViewSummarySchema
} from '@cupboard/protocol/reuse-views';
import { runInDurableObject } from 'cloudflare:test';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as schema from '../db/schema.ts';
import {
	authorisedFetch,
	cacheWriteGrants,
	currentServer,
	initialise,
	issueServerSignedToken,
	narBytes,
	pushPath,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

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

function setViewRaw(
	token: string,
	name: string,
	body: unknown
): Promise<Response> {
	return authorisedFetch(`/reuse-views/${encodeURIComponent(name)}`, token, {
		body: JSON.stringify(body),
		headers: { 'content-type': 'application/json' },
		method: 'PUT'
	});
}

async function setView(
	token: string,
	name: string,
	body: ReuseViewSetBodyInput
): Promise<{ readonly status: number; readonly body: ReuseViewSummary }> {
	const response = await setViewRaw(token, name, body);

	return {
		status: response.status,
		body: reuseViewSummarySchema.parse(await response.json())
	};
}

async function listViews(
	token: string
): Promise<{ readonly status: number; readonly body: ReuseViewListResponse }> {
	const response = await authorisedFetch('/reuse-views', token);

	return {
		status: response.status,
		body: reuseViewListResponseSchema.parse(await response.json())
	};
}

async function removeView(
	token: string,
	name: string
): Promise<{
	readonly status: number;
	readonly body: ReuseViewRemoveResponse;
}> {
	const response = await authorisedFetch(
		`/reuse-views/${encodeURIComponent(name)}`,
		token,
		{ method: 'DELETE' }
	);

	return {
		status: response.status,
		body: reuseViewRemoveResponseSchema.parse(await response.json())
	};
}

// A view mutation is tenant configuration only: it must never touch narinfo
// or retention state.
async function derivedStateSnapshot(): Promise<{
	readonly narInfoCount: number;
	readonly retentionRootCount: number;
	readonly retentionGraceCount: number;
}> {
	return runInDurableObject(currentServer(), (instance) => ({
		narInfoCount: instance.context.db.select().from(schema.narInfos).all()
			.length,
		retentionRootCount: instance.context.db
			.select()
			.from(schema.retentionRoots)
			.all().length,
		retentionGraceCount: instance.context.db
			.select()
			.from(schema.retentionGrace)
			.all().length
	}));
}

describe('reuse views', () => {
	beforeEach(resetTestServer);

	it('sets, lists and removes a view, defaulting its priority', async () => {
		const token = await initialise();
		const before = await derivedStateSnapshot();

		const added = await setView(token, 'reuse', {
			access: 'public',
			selectors: [{ kind: 'named', name: 'pr-1' }]
		});
		const listed = await listViews(token);
		const removed = await removeView(token, 'reuse');
		const after = await listViews(token);
		const afterState = await derivedStateSnapshot();

		expect({
			addStatus: added.status,
			added: added.body,
			listStatus: listed.status,
			listed: listed.body,
			removeStatus: removed.status,
			removed: removed.body,
			afterStatus: after.status,
			afterViews: after.body,
			derivedState: { before, after: afterState }
		}).toStrictEqual({
			addStatus: StatusCodes.OK,
			added: {
				name: 'reuse',
				access: 'public',
				revision: 1,
				priority: 50,
				selectors: [{ kind: 'named', name: 'pr-1' }],
				createdAt: added.body.createdAt,
				updatedAt: added.body.createdAt
			},
			listStatus: StatusCodes.OK,
			listed: { views: [added.body] },
			removeStatus: StatusCodes.OK,
			removed: { name: 'reuse', removed: true },
			afterStatus: StatusCodes.OK,
			afterViews: { views: [] },
			derivedState: { before, after: before }
		});
	});

	it('accepts an explicit priority', async () => {
		const token = await initialise();

		const added = await setView(token, 'reuse', {
			access: 'public',
			selectors: [{ kind: 'all' }],
			priority: 10
		});

		expect({
			status: added.status,
			priority: added.body.priority
		}).toStrictEqual({ status: StatusCodes.OK, priority: 10 });
	});

	it('accepts an all selector', async () => {
		const token = await initialise();

		const added = await setView(token, 'reuse', {
			access: 'public',
			selectors: [{ kind: 'all' }]
		});

		expect({
			status: added.status,
			selectors: added.body.selectors
		}).toStrictEqual({
			status: StatusCodes.OK,
			selectors: [{ kind: 'all' }]
		});
	});

	it('replaces the selector set wholesale on update, preserving createdAt', async () => {
		const token = await initialise();

		const first = await setView(token, 'reuse', {
			access: 'public',
			selectors: [
				{ kind: 'named', name: 'pr-1' },
				{ kind: 'prefix', prefix: 'pr-' }
			],
			priority: 10
		});
		const second = await setView(token, 'reuse', {
			access: 'public',
			selectors: [{ kind: 'named', name: 'pr-2' }],
			priority: 20
		});
		const listed = await listViews(token);

		expect({
			firstStatus: first.status,
			secondStatus: second.status,
			second: second.body,
			sameCreatedAt: second.body.createdAt === first.body.createdAt,
			revisionIncreased: second.body.revision > first.body.revision,
			listed: listed.body
		}).toStrictEqual({
			firstStatus: StatusCodes.OK,
			secondStatus: StatusCodes.OK,
			second: {
				name: 'reuse',
				access: 'public',
				revision: 2,
				priority: 20,
				selectors: [{ kind: 'named', name: 'pr-2' }],
				createdAt: first.body.createdAt,
				updatedAt: second.body.updatedAt
			},
			sameCreatedAt: true,
			revisionIncreased: true,
			listed: { views: [second.body] }
		});
	});

	// A content-free re-apply must not bump the revision: every bump forces
	// concurrent lookups through their revalidate-and-retry path, and routine
	// CI convergence re-applies the same definition constantly.
	it('keeps the revision and updatedAt across an identical re-apply', async () => {
		const token = await initialise();
		const definition = {
			access: 'public' as const,
			selectors: [
				{ kind: 'named', name: 'pr-1' },
				{ kind: 'prefix', prefix: 'pr-' }
			] as const,
			priority: 10
		};

		const first = await setView(token, 'reuse', {
			access: definition.access,
			selectors: [...definition.selectors],
			priority: definition.priority
		});
		const reapplied = await setView(token, 'reuse', {
			access: definition.access,
			selectors: definition.selectors.toReversed(),
			priority: definition.priority
		});

		expect({
			reapplied: reapplied.body,
			sameRevision: reapplied.body.revision === first.body.revision,
			sameUpdatedAt: reapplied.body.updatedAt === first.body.updatedAt
		}).toStrictEqual({
			reapplied: first.body,
			sameRevision: true,
			sameUpdatedAt: true
		});
	});

	it('never repeats a revision across delete-then-recreate under the same name (ABA)', async () => {
		const token = await initialise();

		const created = await setView(token, 'reuse', {
			access: 'public',
			selectors: [{ kind: 'named', name: 'pr-1' }]
		});
		const updated = await setView(token, 'reuse', {
			access: 'public',
			selectors: [{ kind: 'named', name: 'pr-2' }]
		});
		await removeView(token, 'reuse');
		const recreated = await setView(token, 'reuse', {
			access: 'public',
			selectors: [{ kind: 'named', name: 'pr-3' }]
		});

		expect({
			revisions: [created.body.revision, updated.body.revision],
			recreatedRevision: recreated.body.revision,
			recreatedIsHighest:
				recreated.body.revision > created.body.revision &&
				recreated.body.revision > updated.body.revision
		}).toStrictEqual({
			revisions: [1, 2],
			recreatedRevision: 3,
			recreatedIsHighest: true
		});
	});

	it.each([
		{
			name: 'no selectors',
			body: { access: 'public', selectors: [] }
		},
		{
			name: 'a selector count over the cap',
			body: {
				access: 'public',
				selectors: Array.from(
					{ length: reuseViewMaxSelectors + 1 },
					(_, index) => ({ kind: 'prefix', prefix: `p${String(index)}` })
				)
			}
		},
		{
			name: 'a pattern over the length bound',
			body: {
				access: 'public',
				selectors: [{ kind: 'prefix', prefix: 'a'.repeat(64) }]
			}
		},
		{
			name: 'an exact selector with an invalid cache name',
			body: {
				access: 'public',
				selectors: [{ kind: 'named', name: 'PR-1' }]
			}
		}
	])('rejects $name', async ({ body }) => {
		const token = await initialise();

		const response = await setViewRaw(token, 'reuse', body);
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

	it('leaves narinfo and retention state untouched by set/update/remove', async () => {
		const token = await initialise();
		const storePathHash = '0'.repeat(32);

		await pushPath(
			token,
			uploadMetadata({
				fileSize: narBytes.byteLength,
				storePathHash,
				name: 'app'
			})
		);

		const before = await derivedStateSnapshot();

		await setView(token, 'reuse', {
			access: 'public',
			selectors: [{ kind: 'named', name: 'pr-1' }]
		});
		await setView(token, 'reuse', {
			access: 'public',
			selectors: [{ kind: 'prefix', prefix: 'pr-' }]
		});
		await removeView(token, 'reuse');

		const after = await derivedStateSnapshot();

		expect(after).toStrictEqual(before);
	});

	it('requires tenant-domain scope, not a cache-scoped write grant', async () => {
		await initialise();
		const writeToken = await issueServerSignedToken(cacheWriteGrants());

		const list = await authorisedFetch('/reuse-views', writeToken);
		const set = await setViewRaw(writeToken, 'reuse', {
			access: 'public',
			selectors: [{ kind: 'named', name: 'pr-1' }]
		});
		const remove = await authorisedFetch('/reuse-views/reuse', writeToken, {
			method: 'DELETE'
		});

		expect({
			list: list.status,
			set: set.status,
			remove: remove.status
		}).toStrictEqual({
			list: StatusCodes.FORBIDDEN,
			set: StatusCodes.FORBIDDEN,
			remove: StatusCodes.FORBIDDEN
		});
	});
});
