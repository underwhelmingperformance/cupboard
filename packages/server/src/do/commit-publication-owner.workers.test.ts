import type { CacheName, StorePathHash } from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	bootstrap,
	commitUpload,
	commitUploadRejection,
	currentNarObjectKey,
	currentServer,
	defaultCache,
	expectSingleCommitDecision,
	expectSingleUploadDecision,
	namedCache,
	negotiateUploads,
	openCommitSession,
	pushPath,
	putNarBytes,
	putTestCache,
	resetTestServer,
	verifiablePath,
	verifyCurrentTenant
} from '../test-support.ts';

async function publicationOwners(
	storePathHash: StorePathHash,
	cacheName: CacheName
) {
	return drizzle(env.CUPBOARD_DB)
		.select({ uploadId: d1Schema.publication.uploadId })
		.from(d1Schema.publication)
		.where(
			and(
				eq(d1Schema.publication.tenant, fixtureTenant),
				eq(d1Schema.publication.cacheKind, 'named'),
				eq(d1Schema.publication.storePathHash, storePathHash),
				eq(d1Schema.publication.cacheName, cacheName)
			)
		)
		.all();
}

describe('commit publication ownership', () => {
	beforeEach(resetTestServer);

	it('reports a losing deferred upload as absent so its client renegotiates', async () => {
		const { token } = await bootstrap();
		const { metadata, nar } = await verifiablePath('competing-verdict', {});
		const first = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		const winner = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(first.r2Key, nar);
		await putNarBytes(winner.r2Key, nar);
		const firstSession = await openCommitSession(token);
		const winningSession = await openCommitSession(token);
		try {
			firstSession.send({ op: 'commit', uploadId: first.uploadId });
			const firstAck = await firstSession.nextFrame();
			await currentServer().claimVerificationBatch(1, Number.MAX_SAFE_INTEGER);
			winningSession.send({ op: 'commit', uploadId: winner.uploadId });
			const winnerAck = await winningSession.nextFrame();
			await verifyCurrentTenant();
			const winnerVerdict = await winningSession.nextFrame();
			await runInDurableObject(currentServer(), (instance) => {
				instance.context.db
					.update(schema.pendingUploads)
					.set({ claimedAt: sql`null`, claimOwner: sql`null` })
					.where(eq(schema.pendingUploads.id, first.uploadId))
					.run();
			});
			await verifyCurrentTenant();
			const firstVerdict = await firstSession.nextFrame();
			expect({
				firstAck,
				winnerAck,
				firstVerdict,
				winnerVerdict,
				retry: await negotiateUploads(token, [metadata])
			}).toStrictEqual({
				firstAck: {
					ev: 'deferred',
					uploadId: first.uploadId,
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				},
				winnerAck: {
					ev: 'deferred',
					uploadId: winner.uploadId,
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				},
				firstVerdict: {
					ev: 'verdict',
					uploadId: first.uploadId,
					status: 'absent'
				},
				winnerVerdict: {
					ev: 'verdict',
					uploadId: winner.uploadId,
					status: 'servable'
				},
				retry: {
					uploads: [
						{
							action: 'skip',
							storePathHash: metadata.storePathHash,
							narHash: metadata.narHash
						}
					]
				}
			});
		} finally {
			firstSession.socket.close();
			winningSession.socket.close();
		}
	});

	it('reports a losing reused-NAR upload as already present', async () => {
		const { token } = await bootstrap();
		const { metadata, nar } = await verifiablePath('competing-reuse', {});
		await pushPath(token, metadata, defaultCache(), nar);
		const cache = namedCache('reuse-target');
		await putTestCache(token, cache, 'public');
		const first = expectSingleCommitDecision(
			await negotiateUploads(token, [metadata], cache),
			metadata
		);
		const winner = expectSingleCommitDecision(
			await negotiateUploads(token, [metadata], cache),
			metadata
		);
		const canonicalKey = await currentNarObjectKey(metadata.narHash);
		const ready = Promise.withResolvers<undefined>();
		const head = env.BLOBS.head.bind(env.BLOBS);
		let probes = 0;
		const headSpy = vi
			.spyOn(env.BLOBS, 'head')
			.mockImplementation(async (key) => {
				if (key === canonicalKey && probes < 2) {
					probes += 1;
					if (probes === 2) {
						ready.resolve(undefined);
					}
					await ready.promise;
				}
				return head(key);
			});
		try {
			const results = await Promise.all([
				commitUpload(token, first.uploadId, cache),
				commitUpload(token, winner.uploadId, cache)
			]);
			expect(
				results.toSorted((left, right) =>
					left.status.localeCompare(right.status)
				)
			).toStrictEqual([
				{
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					status: 'already-present'
				},
				{
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					status: 'committed'
				}
			]);
		} finally {
			headSpy.mockRestore();
		}
	});

	it.each(['nar-transfer', 'reused-nar'] as const)(
		'preserves the %s commit owner when its charge response is lost',
		async (method) => {
			const { token: administrator } = await bootstrap();
			const cache = namedCache('charge-retry');
			await putTestCache(administrator, cache, 'public');
			const { metadata, nar } = await verifiablePath(
				'lost-charge-response',
				{}
			);
			if (method === 'reused-nar') {
				await pushPath(administrator, metadata, defaultCache(), nar);
			}
			const prepare = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
			const batch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			let isCharge = false;
			let didLoseResponse = false;
			const prepareSpy = vi
				.spyOn(env.CUPBOARD_DB, 'prepare')
				.mockImplementation((query) => {
					isCharge ||= query.startsWith('insert into "blob_ref_storage"');
					return prepare(query);
				});
			const batchSpy = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockImplementation(async (statements) => {
					const isLoseResponse = isCharge && !didLoseResponse;
					isCharge = false;
					const result = await batch(statements);
					if (isLoseResponse) {
						didLoseResponse = true;
						throw new Error('D1 charge response lost');
					}
					return result;
				});
			try {
				await pushPath(administrator, metadata, cache, nar);
			} finally {
				prepareSpy.mockRestore();
				batchSpy.mockRestore();
			}
			const ownerBeforeRetry = await publicationOwners(
				metadata.storePathHash,
				cache.name
			);
			const ownerUploadId = ownerBeforeRetry[0]?.uploadId;
			if (ownerUploadId === undefined || ownerUploadId === null) {
				throw new Error('expected a committed upload owner');
			}
			expect(ownerBeforeRetry).toStrictEqual([{ uploadId: ownerUploadId }]);
			await pushPath(administrator, metadata, cache, nar);
			expect({
				didLoseResponse,
				owners: await publicationOwners(metadata.storePathHash, cache.name),
				retry: await negotiateUploads(administrator, [metadata], cache)
			}).toStrictEqual({
				didLoseResponse: true,
				owners: ownerBeforeRetry,
				retry: {
					uploads: [
						{
							action: 'skip',
							storePathHash: metadata.storePathHash,
							narHash: metadata.narHash
						}
					]
				}
			});
		}
	);

	it.each(['nar-transfer', 'reused-nar'] as const)(
		'preserves the %s commit owner when another upload finishes interrupted publication',
		async (method) => {
			const { token: administrator } = await bootstrap();
			const cache = namedCache('interrupted');
			await putTestCache(administrator, cache, 'public');
			const { metadata, nar } = await verifiablePath(
				'interrupted-publication',
				{}
			);
			if (method === 'reused-nar') {
				await pushPath(administrator, metadata, defaultCache(), nar);
			}
			const choose =
				method === 'reused-nar'
					? expectSingleCommitDecision
					: expectSingleUploadDecision;
			const upload = choose(
				await negotiateUploads(administrator, [metadata], cache),
				metadata
			);
			const competing = choose(
				await negotiateUploads(administrator, [metadata], cache),
				metadata
			);
			if (upload.action === 'upload') {
				await putNarBytes(upload.r2Key, nar);
			}
			if (competing.action === 'upload') {
				await putNarBytes(competing.r2Key, nar);
			}
			const key = narInfoObjectKey(
				fixtureTenant,
				metadata.storePathHash,
				cache
			);
			const put = env.BLOBS.put.bind(env.BLOBS);
			let didInterrupt = false;
			const putSpy = vi
				.spyOn(env.BLOBS, 'put')
				.mockImplementation(async (...arguments_) => {
					const result = await put(...arguments_);
					if (arguments_[0] === key) {
						didInterrupt = true;
						throw new Error(
							'Publication interrupted before local finalisation'
						);
					}
					return result;
				});
			try {
				if (method === 'reused-nar') {
					await commitUploadRejection(administrator, upload.uploadId, cache, {
						wait: false
					});
				} else {
					await commitUpload(administrator, upload.uploadId, cache, {
						wait: false
					});
					await verifyCurrentTenant();
				}
			} finally {
				putSpy.mockRestore();
			}
			const competingResult = await commitUpload(
				administrator,
				competing.uploadId,
				cache
			);
			expect({
				didInterrupt,
				competingResult,
				owners: await publicationOwners(metadata.storePathHash, cache.name)
			}).toStrictEqual({
				didInterrupt: true,
				competingResult: {
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					status: 'already-present'
				},
				owners: [{ uploadId: upload.uploadId }]
			});
		}
	);
});
