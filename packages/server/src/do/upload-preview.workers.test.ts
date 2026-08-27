import {
	DEFAULT_CACHE,
	DEFAULT_CACHE_SELECTOR,
	selectorForCache,
	storedCacheSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type AuthorizationDetails,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import {
	acceptCapabilitiesHeader,
	type ParsedUploadPathMetadata,
	uploadCapabilitiesHeader,
	uploadCapabilitiesValue,
	uploadGraceFactsCapability,
	type UploadPreviewResponse,
	uploadPreviewResponseSchema
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	armBlobReaperTimer,
	authorisedFetch,
	blobStateArmTimes,
	currentServer,
	initialise,
	issueServerSignedToken,
	narBytes,
	negotiateUploads,
	pushPath,
	resetTestServer,
	syntheticNarHash,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation
} from '../test-support.ts';

import { ReconcileQueueService } from './reconcile-queue-service.ts';

const repeated = (character: string): string => character.repeat(32);
const dayGraceSeconds = 86_400;

async function fireReconcile(): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => instance.alarm());
}

function previewOnlyGrants(
	cacheSelector: string = DEFAULT_CACHE_SELECTOR
): AuthorizationDetails {
	return authorizationDetailsSchema.parse([
		{
			type: 'cupboard_cache',
			actions: ['upload:preview'],
			cache: cacheSelector
		}
	]);
}

function negotiateOnlyGrants(
	cacheSelector: string = DEFAULT_CACHE_SELECTOR
): AuthorizationDetails {
	return authorizationDetailsSchema.parse([
		{
			type: 'cupboard_cache',
			actions: ['upload:negotiate'],
			cache: cacheSelector
		}
	]);
}

async function previewUploads(
	token: string,
	paths: readonly ParsedUploadPathMetadata[],
	cache: string = DEFAULT_CACHE,
	shouldReportGrace = true
): Promise<{
	readonly status: number;
	readonly capabilities: string | undefined;
	readonly body: UploadPreviewResponse;
}> {
	const response = await authorisedFetch(
		`/cache/${selectorForCache(storedCacheSchema.parse(cache))}/uploads/preview`,
		token,
		{
			body: JSON.stringify({
				paths: paths.map((path) => uploadPathNegotiation(path))
			}),
			headers: {
				'content-type': 'application/json',
				...(shouldReportGrace && {
					[acceptCapabilitiesHeader]: uploadGraceFactsCapability
				})
			},
			method: 'POST'
		}
	);

	return {
		status: response.status,
		capabilities: response.headers.get(uploadCapabilitiesHeader) ?? undefined,
		body: uploadPreviewResponseSchema.parse(await response.json())
	};
}

async function addGracePolicy(
	token: string,
	cachePrefix: string,
	graceSeconds: number
): Promise<void> {
	const response = await authorisedFetch('/policies/grace', token, {
		body: JSON.stringify({ cachePrefix, graceSeconds }),
		headers: { 'content-type': 'application/json' },
		method: 'POST'
	});

	expect(response.status).toBe(StatusCodes.OK);
}

async function sideEffectSnapshot(cache: string): Promise<{
	readonly pendingUploadCount: number;
	readonly graceRows: readonly {
		readonly storePathHash: string;
		readonly retainUntil: string;
	}[];
	readonly graceManaged: boolean;
	readonly reconcileKeys: readonly string[];
}> {
	const storedCache = storedCacheSchema.parse(cache);

	return runInDurableObject(currentServer(), async (instance) => {
		const pendingUploadCount = instance.context.db
			.select({ id: schema.pendingUploads.id })
			.from(schema.pendingUploads)
			.all().length;
		const graceRows = instance.context.db
			.select({
				storePathHash: schema.retentionGrace.storePathHash,
				retainUntil: schema.retentionGrace.retainUntil
			})
			.from(schema.retentionGrace)
			.where(eq(schema.retentionGrace.cache, storedCache))
			.orderBy(schema.retentionGrace.storePathHash)
			.all();
		const isGraceManaged =
			instance.context.db
				.select({ graceManaged: schema.caches.graceManaged })
				.from(schema.caches)
				.where(eq(schema.caches.name, storedCache))
				.get()?.graceManaged ?? false;
		const reconciling = await new ReconcileQueueService(
			instance.context
		).claimChunk();
		const reconcileKeys = reconciling
			.keys()
			.toArray()
			.toSorted((left, right) => byCodeUnit(left, right));

		return {
			pendingUploadCount,
			graceRows,
			graceManaged: isGraceManaged,
			reconcileKeys
		};
	});
}

describe('upload preview', () => {
	beforeEach(resetTestServer);

	it.each([
		{ reportsGrace: false, capabilities: undefined },
		{ reportsGrace: true, capabilities: uploadCapabilitiesValue }
	])(
		'acknowledges grace facts only when requested ($reportsGrace)',
		async ({ reportsGrace: shouldReportGrace, capabilities }) => {
			const token = await initialise();
			const preview = await previewUploads(
				token,
				[],
				DEFAULT_CACHE,
				shouldReportGrace
			);

			expect(preview).toStrictEqual({
				status: StatusCodes.OK,
				capabilities,
				body: { uploads: [] }
			});
		}
	);

	it('preserves the legacy decision shape without the capability', async () => {
		const token = await initialise();
		await addGracePolicy(token, '', dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('0'),
			name: 'legacy-preview'
		});
		const preview = await previewUploads(token, [path], DEFAULT_CACHE, false);

		expect(preview.body.uploads).toStrictEqual([
			{
				action: 'upload',
				storePathHash: path.storePathHash,
				narHash: path.narHash
			}
		]);
	});

	it('leaves pending uploads, grace state, and the reconcile queue exactly as before', async () => {
		const token = await initialise();
		await addGracePolicy(token, '', dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'already-present'
		});

		await pushPath(token, path);
		// Drain the reconcile entry created by setup before taking either snapshot.
		// Otherwise the reconcile alarm could mutate the queue during preview.
		await negotiateUploads(token, [path]);
		await fireReconcile();

		const before = await sideEffectSnapshot(DEFAULT_CACHE);
		const preview = await previewUploads(token, [path]);
		const after = await sideEffectSnapshot(DEFAULT_CACHE);

		expect({
			status: preview.status,
			uploads: preview.body.uploads,
			after
		}).toStrictEqual({
			status: StatusCodes.OK,
			uploads: [
				{
					action: 'skip',
					storePathHash: path.storePathHash,
					narHash: path.narHash,
					grace: { retainUntil: before.graceRows[0]?.retainUntil }
				}
			],
			after: before
		});
	});

	it('preserves the reaper timer when preview reports reuse', async () => {
		const token = await initialise();
		const source = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('b'),
			name: 'source'
		});
		const reuse = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('c'),
			name: 'reuse',
			narHash: source.narHash
		});

		await pushPath(token, source);
		await armBlobReaperTimer(source.narHash);

		const before = await blobStateArmTimes();
		const preview = await previewUploads(token, [reuse]);
		const after = await blobStateArmTimes();

		expect({
			status: preview.status,
			action: preview.body.uploads[0]?.action,
			after
		}).toStrictEqual({
			status: StatusCodes.OK,
			action: 'commit',
			after: before
		});
	});

	it("matches negotiate's action for each path in the closure", async () => {
		const token = await initialise();
		const skipPath = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('d'),
			name: 'skip-me'
		});
		const reusePath = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('f'),
			name: 'reuse-me',
			narHash: skipPath.narHash
		});
		const freshPath = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('g'),
			name: 'fresh-me',
			narHash: syntheticNarHash(1)
		});

		await pushPath(token, skipPath);

		const closure = [skipPath, reusePath, freshPath];
		const preview = await previewUploads(token, closure);
		const negotiate = await negotiateUploads(token, closure);

		expect({
			previewActions: preview.body.uploads.map((decision) => decision.action),
			negotiateActions: negotiate.uploads.map((decision) => decision.action)
		}).toStrictEqual({
			previewActions: ['skip', 'commit', 'upload'],
			negotiateActions: ['skip', 'commit', 'upload']
		});
	});

	it('reports the stored deadline for a skip and the resolved grace for a commit or upload', async () => {
		const token = await initialise();
		await addGracePolicy(token, '', dayGraceSeconds);

		const skipPath = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('1'),
			name: 'skip-me'
		});
		const reusePath = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('3'),
			name: 'reuse-me',
			narHash: skipPath.narHash
		});
		const freshPath = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('4'),
			name: 'fresh-me',
			narHash: syntheticNarHash(2)
		});

		await pushPath(token, skipPath);
		// Negotiate the committed path again to store its skip deadline before
		// preview reads it.
		await negotiateUploads(token, [skipPath]);

		const stored = await sideEffectSnapshot(DEFAULT_CACHE);
		const preview = await previewUploads(token, [
			skipPath,
			reusePath,
			freshPath
		]);

		expect(
			preview.body.uploads.map((decision) => ({
				action: decision.action,
				grace: decision.grace
			}))
		).toStrictEqual([
			{
				action: 'skip',
				grace: { retainUntil: stored.graceRows[0]?.retainUntil }
			},
			{ action: 'commit', grace: { graceSeconds: dayGraceSeconds } },
			{ action: 'upload', grace: { graceSeconds: dayGraceSeconds } }
		]);
	});

	it('reports the resolved policy for a skip with no stored deadline', async () => {
		const token = await initialise();

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('6'),
			name: 'skip-ungranted'
		});

		// Publish before adding the policy so this row has no stored deadline.
		await pushPath(token, path);
		await addGracePolicy(token, '', dayGraceSeconds);

		const preview = await previewUploads(token, [path]);

		expect(preview.body.uploads).toStrictEqual([
			{
				action: 'skip',
				storePathHash: path.storePathHash,
				narHash: path.narHash,
				grace: { graceSeconds: dayGraceSeconds }
			}
		]);
	});

	it('reports zero grace when a zero-second policy matches', async () => {
		const token = await initialise();
		await addGracePolicy(token, '', 0);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('7'),
			name: 'zero-grace'
		});

		await pushPath(token, path);

		const preview = await previewUploads(token, [path]);

		expect(preview.body.uploads).toStrictEqual([
			{
				action: 'skip',
				storePathHash: path.storePathHash,
				narHash: path.narHash,
				grace: { graceSeconds: 0 }
			}
		]);
	});

	it('reports no grace fact when no policy matches', async () => {
		const token = await initialise();
		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('5'),
			name: 'unmanaged'
		});

		const preview = await previewUploads(token, [path]);

		expect(preview.body.uploads).toStrictEqual([
			{
				action: 'upload',
				storePathHash: path.storePathHash,
				narHash: path.narHash,
				grace: {}
			}
		]);
	});

	it('rejects a preview request that includes pushId', async () => {
		const token = await initialise();
		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('8'),
			name: 'no-push-id'
		});

		const response = await authorisedFetch(
			`/cache/${selectorForCache(DEFAULT_CACHE)}/uploads/preview`,
			token,
			{
				body: JSON.stringify({
					pushId: testPushId,
					paths: [uploadPathNegotiation(path)]
				}),
				headers: { 'content-type': 'application/json' },
				method: 'POST'
			}
		);

		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
	});

	it('rejects negotiate for a preview-only grant but allows preview', async () => {
		await initialise();
		const token = await issueServerSignedToken(previewOnlyGrants());
		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('6'),
			name: 'authz'
		});

		const negotiateResponse = await authorisedFetch(
			`/cache/${selectorForCache(DEFAULT_CACHE)}/uploads`,
			token,
			{
				body: JSON.stringify({
					pushId: testPushId,
					paths: [uploadPathNegotiation(path)]
				}),
				headers: { 'content-type': 'application/json' },
				method: 'POST'
			}
		);
		const preview = await previewUploads(token, [path]);

		expect({
			negotiateStatus: negotiateResponse.status,
			previewStatus: preview.status
		}).toStrictEqual({
			negotiateStatus: StatusCodes.FORBIDDEN,
			previewStatus: StatusCodes.OK
		});
	});

	it('lets a negotiate grant call preview', async () => {
		await initialise();
		const token = await issueServerSignedToken(negotiateOnlyGrants());
		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('7'),
			name: 'authz-negotiate'
		});

		const preview = await previewUploads(token, [path]);

		expect(preview.status).toBe(StatusCodes.OK);
	});
});
