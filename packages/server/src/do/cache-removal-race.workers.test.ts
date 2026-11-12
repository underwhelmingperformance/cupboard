import { rootLogger } from '@cupboard/logger';
import { type StorePathHash } from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
	deliverAlarms,
	ignoreAlarmDeliveries
} from '../alarm-fence.test-support.ts';
import { type ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { CacheNotFoundError } from '../errors.ts';
import { narInfoObjectKey, requestOriginSchema } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	adminGrants,
	authorisedFetch,
	blobReferenceRows,
	currentServer,
	expectSingleUploadDecision,
	initialise,
	namedCache,
	negotiateUploads,
	pushPath,
	putNarBytes,
	putTestCache,
	resetTestServer,
	tenantUsageRow,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

import { AttestationCasService } from './attestation-cas-service.ts';
import { AttestationsService } from './attestations-service.ts';
import { CacheRegistrationService } from './cache-registration-service.ts';
import { drainTeardown } from './cache-teardown.test-support.ts';
import { CommitPipelineService } from './commit-pipeline-service.ts';
import { type ServerContext } from './context.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { RetentionService } from './retention-service.ts';
import { ReuseAuthority } from './reuse-authority.ts';
import { SigningKeysService } from './signing-keys-service.ts';
import { UploadStateService } from './upload-state-service.ts';

const builds = namedCache('builds');
const origin = requestOriginSchema.parse('https://cache.example');

function pipelineFor(context: ServerContext): CommitPipelineService {
	const narInfoObjects = new NarInfoObjectsService(context);
	const attestations = new AttestationsService(
		context,
		new CacheRegistrationService(context),
		new AttestationCasService(context),
		narInfoObjects
	);

	return new CommitPipelineService(
		context,
		new SigningKeysService(context, narInfoObjects),
		new UploadStateService(context),
		narInfoObjects,
		new RetentionService(context),
		attestations
	);
}

function narInfoRows(context: ServerContext, storePathHash: StorePathHash) {
	return context.db
		.select({
			cacheId: schema.narInfos.cacheId,
			generation: schema.narInfos.generation
		})
		.from(schema.narInfos)
		.where(eq(schema.narInfos.storePathHash, storePathHash))
		.all();
}

async function isNarInfoObjectPresent(
	storePathHash: StorePathHash,
	cache: ResolvedCache
): Promise<boolean> {
	const object = await env.BLOBS.head(
		narInfoObjectKey(
			fixtureTenant,
			storePathHash,
			cache.scope,
			cache.generation
		)
	);

	return object !== null;
}

function liveBuilds(): Promise<ResolvedCache> {
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.cacheRepository.require(builds)
	);
}

// A removal marks the cache removed and leaves its rows until the teardown
// drain deletes them. A cache registered again under the name, and commits
// into either cache, must not see or change the other cache's rows.
describe('cache removal races', () => {
	beforeEach(async () => {
		await resetTestServer();
		const id = currentServer().id;
		ignoreAlarmDeliveries(id);
		onTestFinished(() => {
			deliverAlarms(id);
		});
	});

	it('keeps a path recommitted into a recreated cache while the removed one drains', async () => {
		const token = await initialise();
		const path = uploadMetadata({ fileSize: 1, storePathHash: 'a'.repeat(32) });
		await putTestCache(token, builds);
		const removed = await liveBuilds();
		await pushPath(token, path, builds);

		const removal = await authorisedFetch('/caches/builds?force=true', token, {
			method: 'DELETE'
		});
		await putTestCache(token, builds);
		const recreated = await liveBuilds();
		await pushPath(token, path, builds);
		await drainTeardown(removed.id);

		const usage = await tenantUsageRow();
		const edges = await blobReferenceRows();

		expect({
			removal: removal.status,
			rows: await runInDurableObject(currentServer(), (instance) =>
				narInfoRows(instance.context, path.storePathHash)
			),
			edges: edges.map((edge) => ({
				cache: edge.cache,
				generation: edge.generation,
				cacheGeneration: edge.cacheGeneration
			})),
			objects: {
				removed: await isNarInfoObjectPresent(path.storePathHash, removed),
				recreated: await isNarInfoObjectPresent(path.storePathHash, recreated)
			},
			narinfos: usage?.narinfos
		}).toStrictEqual({
			removal: StatusCodes.OK,
			rows: [{ cacheId: recreated.id, generation: 1 }],
			edges: [
				{
					cache: builds,
					generation: 1,
					cacheGeneration: recreated.generation
				}
			],
			objects: { removed: false, recreated: true },
			narinfos: 1
		});
	});

	it('refuses a commit that resolved the cache before the removal', async () => {
		const token = await initialise();
		await putTestCache(token, builds);
		const nar = await verifiableNar('removal-race');
		const path = uploadMetadata({
			storePathHash: 'b'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const decision = expectSingleUploadDecision(
			await negotiateUploads(token, [path], builds),
			path
		);
		await putNarBytes(decision.r2Key, nar);

		const observed = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const pipeline = pipelineFor(instance.context);
				const cache = instance.context.cacheRepository.require(builds);
				const probe = pipeline.probeMaterialisation.bind(pipeline);
				// The removal runs while the commit waits for its probe, after the
				// commit has read the upload and its cache.
				vi.spyOn(pipeline, 'probeMaterialisation').mockImplementationOnce(
					async (...parameters) => {
						await instance.runCacheTeardown(builds, origin);

						return probe(...parameters);
					}
				);
				const authority = new ReuseAuthority({
					destination: cache.scope,
					grants: adminGrants(),
					views: []
				});
				let isRefusedAsNotFound = false;

				try {
					await pipeline.commit(
						rootLogger(),
						cache,
						decision.uploadId,
						authority
					);
				} catch (error) {
					isRefusedAsNotFound = error instanceof CacheNotFoundError;
				}

				return {
					isRefusedAsNotFound,
					rows: narInfoRows(instance.context, path.storePathHash),
					uploads: instance.context.db
						.select({ id: schema.pendingUploads.id })
						.from(schema.pendingUploads)
						.all()
				};
			}
		);

		expect(observed).toStrictEqual({
			isRefusedAsNotFound: true,
			rows: [],
			uploads: []
		});
	});
});
