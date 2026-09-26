import { rootLogger } from '@cupboard/logger';
import {
	type CacheAccessMode,
	type CacheScope,
	narInfoGenerationSchema,
	predicateTypeSchema,
	type Sha256HexDigest,
	sha256HexDigestSchema
} from '@cupboard/nix-store/scalars';
import {
	attestationAttachResponseSchema,
	type AttestationDecision,
	attestationDecisionSchema,
	attestationListSchema,
	attestationNegotiateMaxBundles,
	attestationNegotiateResponseSchema,
	attestationUploadDecisionSchema
} from '@cupboard/protocol/attestations';
import { buildOriginPredicateType } from '@cupboard/protocol/build-origin';
import {
	subrequestSafetyReserve,
	workersInvocationAllowances
} from '@cupboard/protocol/platform';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	uploadDecisionSchema,
	uploadIdSchema,
	uploadNegotiateResponseSchema
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, desc, eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { sha256HexBytes } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { AttestationPathNotFoundError } from '../errors.ts';
import {
	attestationListObjectKey,
	attestationStagingObjectKey,
	casObjectKey,
	type R2ObjectKey
} from '../http/http.ts';
import { runReaperDemote } from '../routing/scheduled.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	attestationReferenceRows,
	authorisedWorkerFetch,
	cacheScopedPath,
	cacheWriteGrants,
	casObjectRows,
	clearBlobStorage,
	commitSessionFromResponse,
	commitUploadViaWorker,
	currentCasObjectKey,
	currentNarObjectKey,
	fixtureWorkerServer,
	handlerFetch,
	hexBytes,
	initialiseViaWorker,
	issueTokenForTenant,
	namedCache,
	narDigestHex,
	pendingAttestationRows,
	provisionFixtureTenant,
	provisionNamedTenant,
	putNarBytes,
	putWorkerTestCache,
	readFetch,
	resetTestServer,
	resolvedCache,
	sigstoreBundleBytes,
	tenantCasBlobRows,
	tenantUsageRow,
	testPushId,
	testPushIdFor,
	testServerFor,
	uploadMetadata,
	uploadPathNegotiation,
	verifiableNar
} from '../test-support.ts';

import { type MaintenanceProgress } from './alarm.ts';
import { AttestationCasService } from './attestation-cas-service.ts';
import {
	AttestationsService,
	inheritanceListSubrequests,
	inheritanceLookupSubrequests,
	inheritanceSourceKey,
	maxInheritanceAttempts
} from './attestations-service.ts';
import { chunk, maxBoundParameters } from './bulk.ts';
import { CacheRegistrationService } from './cache-registration-service.ts';
import { type ServerContext } from './context.ts';
import { DeletionQueueService } from './deletion-queue-service.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { CupboardServer, maintenancePassCursorKey } from './server.ts';
import {
	subrequestsAvailable,
	subrequestSliceReserve,
	withSubrequestSlice
} from './subrequest-slice.ts';

const predicateType = 'https://slsa.dev/provenance/v1';
const defaultCacheScope: CacheScope = { kind: 'default' };

// Orders by UTF-16 code unit, matching the default `<`/`>` comparison.
function compareById(left: { id: string }, right: { id: string }): number {
	if (left.id < right.id) {
		return -1;
	}

	if (left.id > right.id) {
		return 1;
	}

	return 0;
}
const orpcErrorBodySchema = z.strictObject({
	defined: z.boolean(),
	code: z.string(),
	status: z.number(),
	message: z.string(),
	data: z.unknown().optional()
});
const storePathHashCursor = { next: 0 };

function orpcErrorBodyShape(body: unknown): {
	readonly defined: boolean;
	readonly code: string;
	readonly status: number;
	readonly data: unknown;
} {
	const parsed = orpcErrorBodySchema.parse(body);

	return {
		defined: parsed.defined,
		code: parsed.code,
		status: parsed.status,
		data: parsed.data
	};
}

describe('attestation attach and reads', () => {
	beforeEach(async () => {
		vi.useRealTimers();
		await resetTestServer();
		await clearBlobStorage();
		// The scheduler delivers the alarm that a commit arms. Stop that alarm
		// from draining the inheritance queue, so that each test drains it with
		// `drainInheritance`.
		vi.spyOn(
			AttestationsService.prototype,
			'nextInheritanceAt'
		).mockReturnValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('marks an absent attestation list as uncacheable', async () => {
		await initialiseViaWorker();
		const storePathHash = uniqueStorePathHash();

		const response = await readFetch(`/attestations/${storePathHash}`);

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control')
		}).toStrictEqual({
			status: StatusCodes.NOT_FOUND,
			cacheControl: 'no-store'
		});
	});

	it('attaches a DSSE bundle and serves descriptors from the filed edge', async () => {
		const { token, metadata, bundle, digest } = await committedPathBundle();

		const attached = await attachBundle(token, metadata.storePathHash, bundle);
		const list = await readFetch(`/attestations/${metadata.storePathHash}`);
		const bundleRead = await readFetch(`/attestation-bundles/${digest}`);
		const bundleBytes = new Uint8Array(await bundleRead.arrayBuffer());

		expect({
			attached,
			listStatus: list.status,
			listControl: list.headers.get('cache-control'),
			listBody: attestationListSchema.parse(await list.json()),
			bundleStatus: bundleRead.status,
			bundleControl: bundleRead.headers.get('cache-control'),
			bundleBytes: [...bundleBytes]
		}).toStrictEqual({
			attached: {
				storePathHash: metadata.storePathHash,
				digest,
				predicateType,
				status: 'attached'
			},
			listStatus: StatusCodes.OK,
			listControl: 'no-store',
			listBody: {
				attestations: [{ digest, predicateType, size: bundle.byteLength }]
			},
			bundleStatus: StatusCodes.OK,
			bundleControl: 'no-store',
			bundleBytes: [...bundle]
		});
	});

	it('prefetches attestations for every path when one path has more than the per-path limit', async () => {
		const first = await committedPathBundle();
		const secondHash = uniqueStorePathHash();
		const second = uploadMetadata({
			storePathHash: secondHash,
			narHash: first.nar.narHash,
			narSize: first.nar.narSize,
			fileHash: first.nar.fileHash,
			fileSize: first.nar.narBytes.byteLength
		});
		await pushPathThroughTenant(fixtureTenant, first.token, second, first.nar);
		const destination = namedCache('prefetch-destination');
		await putWorkerTestCache(first.token, destination);
		const digests = Array.from({ length: 131 }, (_, index) =>
			sha256HexDigestSchema.parse((index + 1).toString(16).padStart(64, '0'))
		);
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const lastDigest = digests.at(-1);

		if (lastDigest === undefined) {
			throw new Error('the test needs a last digest');
		}

		for (const page of chunk(digests, 25)) {
			await database.insert(d1Schema.casObject).values(
				page.map((digest) => ({
					digest,
					size: 1,
					storedAt: isoTimestamp(new Date())
				}))
			);
		}

		const firstPathDigests = digests.slice(0, 130);
		for (const page of chunk(firstPathDigests, 10)) {
			await database.insert(d1Schema.attestationReference).values(
				page.map((digest) => ({
					tenant: fixtureTenant,
					cacheKind: 'default' as const,
					storePathHash: first.metadata.storePathHash,
					generation: narInfoGenerationSchema.parse(0),
					predicateType: predicateTypeSchema.parse(predicateType),
					digest
				}))
			);
		}

		await database.insert(d1Schema.attestationReference).values({
			tenant: fixtureTenant,
			cacheKind: 'default',
			storePathHash: second.storePathHash,
			generation: narInfoGenerationSchema.parse(0),
			predicateType: predicateTypeSchema.parse(predicateType),
			digest: lastDigest
		});

		const prefetched = await runInDurableObject(
			fixtureWorkerServer(),
			(instance) => {
				const service = new AttestationsService(
					instance.context,
					new CacheRegistrationService(instance.context),
					new AttestationCasService(instance.context),
					new NarInfoObjectsService(instance.context)
				);

				return service.prefetchInheritanceSources(
					resolvedCache(instance.context, destination),
					[first.metadata, second]
				);
			}
		);

		expect({
			first: prefetched.sources.get(
				inheritanceSourceKey(first.metadata.storePathHash, first.nar.narHash)
			)?.length,
			second: prefetched.sources
				.get(inheritanceSourceKey(second.storePathHash, first.nar.narHash))
				?.map((row) => row.digest)
		}).toStrictEqual({ first: 65, second: [lastDigest] });
	});

	it('skips R2 checks for bundles that the destination already references', async () => {
		const destination = namedCache('already-inherited');
		const token = await initialiseViaWorker();
		await putWorkerTestCache(token, destination);
		const nar = await verifiableNar('already-inherited');
		const metadata = uploadMetadata({
			storePathHash: uniqueStorePathHash(),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await pushPathThroughTenant(fixtureTenant, token, metadata, nar);
		await attachBundle(
			token,
			metadata.storePathHash,
			sigstoreBundleBytes(narDigestHex(nar.narHash))
		);
		await pushPathThroughTenant(
			fixtureTenant,
			token,
			metadata,
			nar,
			destination
		);
		await drainInheritance();
		const heads = vi.spyOn(env.BLOBS, 'head');

		try {
			const result = await runInDurableObject(
				fixtureWorkerServer(),
				async (instance) => {
					const service = attestationsFor(instance.context);
					const cache = resolvedCache(instance.context, destination);
					const prefetch = await service.prefetchInheritanceSources(cache, [
						metadata
					]);

					return service.inheritFromTenant(rootLogger(), {
						cache,
						storePathHash: metadata.storePathHash,
						generation: narInfoGenerationSchema.parse(0),
						narHash: metadata.narHash,
						prefetch
					});
				}
			);

			expect({ result, heads: heads.mock.calls.length }).toStrictEqual({
				result: 'complete',
				heads: 0
			});
		} finally {
			heads.mockRestore();
		}
	});

	it('inherits the source cache bundle after the commit when another cache reuses the path', async () => {
		const destination = namedCache('reused');
		const token = await initialiseViaWorker();
		await putWorkerTestCache(token, destination);
		const nar = await verifiableNar('attestation-reused-path');
		const metadata = uploadMetadata({
			storePathHash: uniqueStorePathHash(),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await pushPathThroughTenant(fixtureTenant, token, metadata, nar);
		const bundle = sigstoreBundleBytes(narDigestHex(nar.narHash));
		const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));
		await attachBundle(token, metadata.storePathHash, bundle);
		await pushPathThroughTenant(
			fixtureTenant,
			token,
			metadata,
			nar,
			destination
		);
		const listBeforeDrain = await readFetch(
			`/cache/reused/attestations/${metadata.storePathHash}`
		);

		const drain = await drainInheritance();
		const list = await readFetch(
			`/cache/reused/attestations/${metadata.storePathHash}`
		);
		const bundleRead = await readFetch(
			`/cache/reused/attestation-bundles/${digest}`
		);

		expect({
			listStatusBeforeDrain: listBeforeDrain.status,
			drain,
			queued: await queuedInheritances(),
			listStatus: list.status,
			list: attestationListSchema.parse(await list.json()),
			bundleStatus: bundleRead.status
		}).toStrictEqual({
			listStatusBeforeDrain: StatusCodes.NOT_FOUND,
			drain: 'progressed',
			queued: [],
			listStatus: StatusCodes.OK,
			list: {
				attestations: [{ digest, predicateType, size: bundle.byteLength }]
			},
			bundleStatus: StatusCodes.OK
		});
	});

	it('inherits for the committed path, not for the identity in a batch entry', async () => {
		const destination = namedCache('batch-identity');
		const token = await initialiseViaWorker();
		await putWorkerTestCache(token, destination);
		const sourceNar = await verifiableNar('batch-identity-source');
		const targetNar = await verifiableNar('batch-identity-target');
		const source = uploadMetadata({
			storePathHash: uniqueStorePathHash(),
			narHash: sourceNar.narHash,
			narSize: sourceNar.narSize,
			fileHash: sourceNar.fileHash,
			fileSize: sourceNar.narBytes.byteLength
		});
		const target = uploadMetadata({
			storePathHash: uniqueStorePathHash(),
			narHash: targetNar.narHash,
			narSize: targetNar.narSize,
			fileHash: targetNar.fileHash,
			fileSize: targetNar.narBytes.byteLength
		});
		const targetBundle = sigstoreBundleBytes(narDigestHex(targetNar.narHash));
		const targetDigest = sha256HexDigestSchema.parse(
			await sha256HexBytes(targetBundle)
		);
		await pushPathThroughTenant(fixtureTenant, token, source, sourceNar);
		await attachBundle(
			token,
			source.storePathHash,
			sigstoreBundleBytes(narDigestHex(sourceNar.narHash))
		);
		await pushPathThroughTenant(fixtureTenant, token, target, targetNar);
		await attachBundle(token, target.storePathHash, targetBundle);
		await drainInheritance();
		const negotiated = await tenantFetch(
			fixtureTenant,
			cacheScopedPath(destination, '/uploads'),
			token,
			{
				body: JSON.stringify({
					pushId: await testPushIdFor(fixtureTenant),
					paths: [uploadPathNegotiation(target)]
				}),
				headers: { 'content-type': 'application/json' },
				method: 'POST'
			}
		);
		const [decision] = z
			.tuple([uploadDecisionSchema])
			.parse(
				uploadNegotiateResponseSchema.parse(await negotiated.json()).uploads
			);

		if (decision.action !== 'commit') {
			throw new Error(`expected a reuse commit, got ${decision.action}`);
		}

		const session = commitSessionFromResponse(
			await tenantFetch(
				fixtureTenant,
				cacheScopedPath(destination, '/commit'),
				token,
				{ headers: { upgrade: 'websocket' } }
			)
		);
		// A batch entry is client-supplied. This one specifies the source path and
		// NAR, not those of its pending upload.
		session.send({
			op: 'commit-batch',
			commits: [
				{
					uploadId: decision.uploadId,
					storePathHash: source.storePathHash,
					narHash: source.narHash
				}
			]
		});
		const frame = await session.nextFrame();
		session.socket.close();
		const queued = await queuedInheritances();
		await drainInheritance();
		const list = await readFetch(
			`/cache/${destination.name}/attestations/${target.storePathHash}`
		);

		expect({
			frame: frame.ev,
			queued,
			listStatus: list.status,
			listed: list.ok
				? attestationListSchema
						.parse(await list.json())
						.attestations.map((attestation) => attestation.digest)
				: []
		}).toStrictEqual({
			frame: 'settled',
			queued: [{ storePathHash: target.storePathHash, attempts: 0 }],
			listStatus: StatusCodes.OK,
			listed: [targetDigest]
		});
	});

	it('retries inheritance after a failed attempt and after running out of subrequests', async () => {
		const destination = namedCache('reuse-after-attestation-error');
		const token = await initialiseViaWorker();
		await putWorkerTestCache(token, destination);
		const nar = await verifiableNar('reuse-attestation-error');
		const metadata = uploadMetadata({
			storePathHash: uniqueStorePathHash(),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await pushPathThroughTenant(fixtureTenant, token, metadata, nar);
		await attachBundle(
			token,
			metadata.storePathHash,
			sigstoreBundleBytes(narDigestHex(nar.narHash))
		);
		// Drain the source cache's own queued path, so that only the destination
		// remains queued.
		await drainInheritance();
		await pushPathThroughTenant(
			fixtureTenant,
			token,
			metadata,
			nar,
			destination
		);
		const narInfo = await readFetch(
			`/cache/${destination.name}/${metadata.storePathHash}.narinfo`
		);
		const inheritance = vi
			.spyOn(AttestationsService.prototype, 'inheritFromTenant')
			.mockRejectedValueOnce(new Error('attestation lookup failed'));
		const listStatus = async () => {
			const response = await readFetch(
				`/cache/${destination.name}/attestations/${metadata.storePathHash}`
			);

			return response.status;
		};

		try {
			const failed = await drainInheritance();
			const afterFailure = await queuedInheritances();
			await makeQueuedInheritancesDue();
			// Leave the drain enough subrequests for the source lookup and the
			// list write, but not for the bundle.
			const exhausted = await runInDurableObject(
				fixtureWorkerServer(),
				(instance) =>
					withSubrequestSlice(
						() =>
							attestationsFor(instance.context).drainInheritanceQueue(
								rootLogger()
							),
						{
							subrequests:
								subrequestSliceReserve +
								inheritanceLookupSubrequests +
								inheritanceListSubrequests,
							reserve: subrequestSliceReserve
						}
					)
			);
			const afterExhaustion = await queuedInheritances();
			const listAfterExhaustion = await listStatus();
			const completed = await drainInheritance();

			expect({
				narInfoStatus: narInfo.status,
				failed,
				afterFailure,
				exhausted,
				afterExhaustion,
				listAfterExhaustion,
				completed,
				queued: await queuedInheritances(),
				listStatus: await listStatus()
			}).toStrictEqual({
				narInfoStatus: StatusCodes.OK,
				failed: 'progressed',
				afterFailure: [{ storePathHash: metadata.storePathHash, attempts: 1 }],
				exhausted: { progress: 'stalled', dequeued: [] },
				afterExhaustion: [
					{ storePathHash: metadata.storePathHash, attempts: 1 }
				],
				listAfterExhaustion: StatusCodes.NOT_FOUND,
				completed: 'progressed',
				queued: [],
				listStatus: StatusCodes.OK
			});
		} finally {
			inheritance.mockRestore();
		}
	});

	it('writes the list when an interrupted attempt left references without it', async () => {
		const { destination, metadata, digest } = await reusedPathWithSourceBundle(
			'interrupted-inheritance'
		);

		// Reproduce an attempt that the runtime stopped after it referenced the
		// bundle and before it wrote the list.
		await runInDurableObject(fixtureWorkerServer(), async (instance) => {
			await new AttestationCasService(
				instance.context
			).reserveReferenceAndCharge(
				{
					cache: destination,
					storePathHash: metadata.storePathHash,
					generation: narInfoGenerationSchema.parse(0),
					predicateType: predicateTypeSchema.parse(predicateType),
					digest
				},
				1
			);
		});
		const listBeforeDrain = await readFetch(
			`/cache/${destination.name}/attestations/${metadata.storePathHash}`
		);
		await drainInheritance();
		const list = await readFetch(
			`/cache/${destination.name}/attestations/${metadata.storePathHash}`
		);

		expect({
			listStatusBeforeDrain: listBeforeDrain.status,
			queued: await queuedInheritances(),
			listed: list.ok
				? attestationListSchema
						.parse(await list.json())
						.attestations.map((attestation) => attestation.digest)
				: []
		}).toStrictEqual({
			listStatusBeforeDrain: StatusCodes.NOT_FOUND,
			queued: [],
			listed: [digest]
		});
	});

	it('keeps the alarm armed for a retry when an earlier alarm runs, and retries through the alarm', async () => {
		const { destination, metadata } =
			await reusedPathWithSourceBundle('retry-alarm');
		vi.spyOn(AttestationsService.prototype, 'nextInheritanceAt').mockRestore();
		const failing = vi
			.spyOn(AttestationsService.prototype, 'inheritFromTenant')
			.mockRejectedValueOnce(new Error('attestation lookup failed'));

		const retry = await runInDurableObject(
			fixtureWorkerServer(),
			async (instance, state) => {
				await attestationsFor(instance.context).drainInheritanceQueue(
					rootLogger()
				);
				failing.mockRestore();
				const [queued] = instance.context.db
					.select({ notBefore: schema.attestationInheritances.notBefore })
					.from(schema.attestationInheritances)
					.all();
				// An earlier alarm, such as one that a commit arms, runs first.
				await state.storage.setAlarm(Date.now());
				await instance.alarm();

				return {
					retryAt:
						queued === undefined ? undefined : Date.parse(queued.notBefore),
					armedAt: await state.storage.getAlarm()
				};
			}
		);
		await makeQueuedInheritancesDue();
		await runInDurableObject(fixtureWorkerServer(), async (instance, state) => {
			// Start the rotation at the inheritance pass.
			await state.storage.put(maintenancePassCursorKey, 'garbage-collection');
			await instance.alarm();
		});
		const list = await readFetch(
			`/cache/${destination.name}/attestations/${metadata.storePathHash}`
		);

		expect({
			isArmedForRetry:
				retry.retryAt !== undefined &&
				retry.armedAt !== null &&
				retry.armedAt <= retry.retryAt,
			queued: await queuedInheritances(),
			listStatus: list.status
		}).toStrictEqual({
			isArmedForRetry: true,
			queued: [],
			listStatus: StatusCodes.OK
		});
	});

	it('abandons a path after the last attempt fails', async () => {
		const { destination, metadata } = await reusedPathWithSourceBundle(
			'abandoned-inheritance'
		);
		const failing = vi
			.spyOn(AttestationsService.prototype, 'inheritFromTenant')
			.mockRejectedValue(new Error('attestation lookup failed'));
		const attempts: number[][] = [];
		const calls = await (async () => {
			try {
				for (let attempt = 1; attempt <= maxInheritanceAttempts; attempt += 1) {
					await drainInheritance();
					const queued = await queuedInheritances();
					attempts.push(queued.map((row) => row.attempts));
					await makeQueuedInheritancesDue();
				}

				return failing.mock.calls.length;
			} finally {
				failing.mockRestore();
			}
		})();

		const list = await readFetch(
			`/cache/${destination.name}/attestations/${metadata.storePathHash}`
		);

		expect({
			calls,
			attempts,
			listStatus: list.status
		}).toStrictEqual({
			calls: maxInheritanceAttempts,
			attempts: [[1], [2], [3], [4], []],
			listStatus: StatusCodes.NOT_FOUND
		});
	});

	it('does not reference or list bundles for a generation that the path no longer has', async () => {
		const { destination, metadata, token } = await reusedPathWithSourceBundle(
			'superseded-inheritance'
		);
		const ownBundle = sigstoreBundleBytes(
			narDigestHex(metadata.narHash),
			buildOriginPredicateType
		);
		const ownDigest = sha256HexDigestSchema.parse(
			await sha256HexBytes(ownBundle)
		);
		await attachBundle(token, metadata.storePathHash, ownBundle, destination);

		const result = await runInDurableObject(fixtureWorkerServer(), (instance) =>
			attestationsFor(instance.context).inheritFromTenant(rootLogger(), {
				cache: resolvedCache(instance.context, destination),
				storePathHash: metadata.storePathHash,
				generation: narInfoGenerationSchema.parse(1),
				narHash: metadata.narHash
			})
		);
		const list = await readFetch(
			`/cache/${destination.name}/attestations/${metadata.storePathHash}`
		);
		const references = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.select({ generation: d1Schema.attestationReference.generation })
			.from(d1Schema.attestationReference)
			.where(
				and(
					eq(d1Schema.attestationReference.cacheName, destination.name),
					eq(
						d1Schema.attestationReference.storePathHash,
						metadata.storePathHash
					)
				)
			);

		expect({
			result,
			listed: attestationListSchema
				.parse(await list.json())
				.attestations.map((attestation) => attestation.digest),
			generations: references.map((row) => row.generation)
		}).toStrictEqual({
			result: 'superseded',
			listed: [ownDigest],
			generations: [narInfoGenerationSchema.parse(0)]
		});
	});

	it('lists the bundles that an attempt inherited before it failed', async () => {
		const destination = namedCache('partial-inheritance');
		const token = await initialiseViaWorker();
		await putWorkerTestCache(token, destination);
		const nar = await verifiableNar('partial-inheritance');
		const metadata = uploadMetadata({
			storePathHash: uniqueStorePathHash(),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await pushPathThroughTenant(fixtureTenant, token, metadata, nar);
		const bundles = [
			sigstoreBundleBytes(narDigestHex(nar.narHash)),
			sigstoreBundleBytes(narDigestHex(nar.narHash), buildOriginPredicateType)
		];

		for (const bundle of bundles) {
			await attachBundle(token, metadata.storePathHash, bundle);
		}

		await pushPathThroughTenant(
			fixtureTenant,
			token,
			metadata,
			nar,
			destination
		);
		const originalHead = env.BLOBS.head.bind(env.BLOBS);
		let casHeads = 0;
		// The first bundle is referenced; the head of the second bundle fails.
		const failing = vi
			.spyOn(env.BLOBS, 'head')
			.mockImplementation((key: string) => {
				if (key.startsWith('cas/')) {
					casHeads += 1;

					if (casHeads === 2) {
						return Promise.reject(new Error('head failed'));
					}
				}

				return originalHead(key);
			});

		try {
			await drainInheritance();
		} finally {
			failing.mockRestore();
		}

		const list = await readFetch(
			`/cache/${destination.name}/attestations/${metadata.storePathHash}`
		);

		expect({
			queued: await queuedInheritances(),
			listStatus: list.status,
			listed: list.ok
				? attestationListSchema.parse(await list.json()).attestations.length
				: 0
		}).toStrictEqual({
			queued: [{ storePathHash: metadata.storePathHash, attempts: 1 }],
			listStatus: StatusCodes.OK,
			listed: 1
		});
	});

	it.each([
		{ destinationAccess: 'public' },
		{ destinationAccess: 'private' }
	] satisfies {
		destinationAccess: CacheAccessMode;
	}[])(
		'keeps private source bundles private when the destination is $destinationAccess',
		async ({ destinationAccess }) => {
			const source = namedCache('private-source');
			const destination = namedCache(`${destinationAccess}-reused`);
			const token = await initialiseViaWorker();
			await putWorkerTestCache(token, source, 'private');
			await putWorkerTestCache(token, destination, destinationAccess);
			const nar = await verifiableNar('attestation-private-reused-path');
			const metadata = uploadMetadata({
				storePathHash: uniqueStorePathHash(),
				narHash: nar.narHash,
				narSize: nar.narSize,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength
			});
			await pushPathThroughTenant(fixtureTenant, token, metadata, nar, source);
			const bundle = sigstoreBundleBytes(narDigestHex(nar.narHash));
			const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));
			await attachBundle(token, metadata.storePathHash, bundle, source);
			await pushPathThroughTenant(
				fixtureTenant,
				token,
				metadata,
				nar,
				destination
			);
			await drainInheritance();
			await provisionFixtureTenant({
				read: { user: 'alice', password: 'secret' }
			});
			const authorised = {
				headers: { authorization: `Basic ${btoa('alice:secret')}` }
			};

			const list = await readFetch(
				`/cache/${destination.name}/attestations/${metadata.storePathHash}`,
				authorised
			);
			const bundleRead = await readFetch(
				`/cache/${destination.name}/attestation-bundles/${digest}`,
				authorised
			);

			expect({
				listStatus: list.status,
				bundleStatus: bundleRead.status,
				list: list.ok
					? attestationListSchema.parse(await list.json())
					: undefined
			}).toStrictEqual({
				listStatus: StatusCodes.NOT_FOUND,
				bundleStatus: StatusCodes.NOT_FOUND,
				list: undefined
			});
		}
	);

	it('inherits a private cache attestation from its earlier path generation', async () => {
		const cache = namedCache('private-recommit');
		const token = await initialiseViaWorker();
		await putWorkerTestCache(token, cache, 'private');
		const nar = await verifiableNar('private-recommit-attestation');
		const metadata = uploadMetadata({
			storePathHash: uniqueStorePathHash(),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await pushPathThroughTenant(fixtureTenant, token, metadata, nar, cache);
		const bundle = sigstoreBundleBytes(narDigestHex(nar.narHash));
		const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));
		await attachBundle(token, metadata.storePathHash, bundle, cache);
		await env.BLOBS.delete(await currentNarObjectKey(metadata.narHash));
		await runReaperDemote(rootLogger(), env);
		await pushPathThroughTenant(
			fixtureTenant,
			token,
			metadata,
			nar,
			cache,
			async () => {
				await runInDurableObject(fixtureWorkerServer(), async (instance) => {
					const resolved = resolvedCache(instance.context, cache);
					const queued = instance.context.db
						.select()
						.from(schema.narInfoDeletions)
						.where(eq(schema.narInfoDeletions.cacheId, resolved.id))
						.all();
					expect(
						queued.map((row) => ({
							generation: row.generation,
							storePathHash: row.storePathHash
						}))
					).toStrictEqual([
						{
							generation: narInfoGenerationSchema.parse(0),
							storePathHash: metadata.storePathHash
						}
					]);
					const narInfoObjects = new NarInfoObjectsService(instance.context);
					const attestationCas = new AttestationCasService(instance.context);
					const attestations = new AttestationsService(
						instance.context,
						new CacheRegistrationService(instance.context),
						attestationCas,
						narInfoObjects
					);
					const deletionQueue = new DeletionQueueService(
						instance.context,
						attestationCas,
						attestations,
						narInfoObjects
					);

					await instance.context.criticalSection(() =>
						deletionQueue.retireTornDownNarInfos(resolved, queued)
					);
				});
			}
		);
		// The commit has cleared its pending upload, and the new generation is
		// in the inheritance queue. Retirement still defers the queued edge.
		await runInDurableObject(fixtureWorkerServer(), async (instance) => {
			const resolved = resolvedCache(instance.context, cache);
			const queued = instance.context.db
				.select()
				.from(schema.narInfoDeletions)
				.where(eq(schema.narInfoDeletions.cacheId, resolved.id))
				.all();
			const narInfoObjects = new NarInfoObjectsService(instance.context);
			const attestationCas = new AttestationCasService(instance.context);
			const deletionQueue = new DeletionQueueService(
				instance.context,
				attestationCas,
				attestationsFor(instance.context),
				narInfoObjects
			);

			await instance.context.criticalSection(() =>
				deletionQueue.retireTornDownNarInfos(resolved, queued)
			);
		});
		await drainInheritance();
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const references = await database
			.select({ generation: d1Schema.attestationReference.generation })
			.from(d1Schema.attestationReference)
			.where(eq(d1Schema.attestationReference.digest, digest));
		const edge = await database
			.select({ generation: d1Schema.blobReference.generation })
			.from(d1Schema.blobReference)
			.where(
				and(
					eq(d1Schema.blobReference.tenant, fixtureTenant),
					eq(d1Schema.blobReference.cacheName, cache.name),
					eq(d1Schema.blobReference.storePathHash, metadata.storePathHash)
				)
			)
			.orderBy(desc(d1Schema.blobReference.generation))
			.get();

		expect({
			currentGeneration: edge?.generation,
			generations: references.map((row) => row.generation)
		}).toStrictEqual({
			currentGeneration: narInfoGenerationSchema.parse(1),
			generations: [
				narInfoGenerationSchema.parse(0),
				narInfoGenerationSchema.parse(1)
			]
		});
	});

	it('rejects a bundle filed against a different NAR subject', async () => {
		const token = await initialiseViaWorker();
		const storePathHash = uniqueStorePathHash();
		const nar = await verifiableNar('attestation-subject-good');
		const metadata = uploadMetadata({
			storePathHash,
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await pushPathThroughTenant(fixtureTenant, token, metadata, nar);
		const other = await verifiableNar('attestation-subject-wrong');
		const bundle = sigstoreBundleBytes(narDigestHex(other.narHash));

		const response = await attachBundleResponse(
			token,
			metadata.storePathHash,
			bundle
		);
		const list = await readFetch(`/attestations/${metadata.storePathHash}`);
		const body = orpcErrorBodyShape(await response.json());

		expect({
			status: response.status,
			body,
			refs: await attestationReferenceRows(),
			objects: await casObjectRows(),
			listStatus: list.status
		}).toStrictEqual({
			status: StatusCodes.UNPROCESSABLE_ENTITY,
			body: {
				defined: false,
				code: 'UNPROCESSABLE_CONTENT',
				status: StatusCodes.UNPROCESSABLE_ENTITY,
				data: undefined
			},
			refs: [],
			objects: [],
			listStatus: StatusCodes.NOT_FOUND
		});
	});

	it('returns the completed attachment when the client repeats its upload ID', async () => {
		const { token, metadata, bundle } = await committedPathBundle();
		const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));
		const decision = attestationUploadDecisionSchema.parse(
			await negotiate(token, metadata.storePathHash, digest)
		);

		await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });
		const path = `/attestations/${decision.uploadId}/attach`;
		const first = await authorisedWorkerFetch(path, token, { method: 'POST' });
		const repeated = await authorisedWorkerFetch(path, token, {
			method: 'POST'
		});

		expect({
			first: {
				status: first.status,
				body: await first.json()
			},
			repeated: {
				status: repeated.status,
				body: await repeated.json()
			}
		}).toStrictEqual({
			first: {
				status: StatusCodes.OK,
				body: {
					storePathHash: metadata.storePathHash,
					digest,
					predicateType: 'https://slsa.dev/provenance/v1',
					status: 'attached'
				}
			},
			repeated: {
				status: StatusCodes.OK,
				body: {
					storePathHash: metadata.storePathHash,
					digest,
					predicateType: 'https://slsa.dev/provenance/v1',
					status: 'already-present'
				}
			}
		});
	});

	it('rejects non-DSSE Sigstore content without filing a CAS object', async () => {
		const { token, metadata } = await committedPathBundle();
		const encoder = new TextEncoder();
		const garbage = encoder.encode('not a sigstore bundle');

		const response = await attachBundleResponse(
			token,
			metadata.storePathHash,
			garbage
		);
		const body = orpcErrorBodyShape(await response.json());

		expect({
			status: response.status,
			body,
			refs: await attestationReferenceRows(),
			objects: await casObjectRows()
		}).toStrictEqual({
			status: StatusCodes.UNPROCESSABLE_ENTITY,
			body: {
				defined: false,
				code: 'UNPROCESSABLE_CONTENT',
				status: StatusCodes.UNPROCESSABLE_ENTITY,
				data: undefined
			},
			refs: [],
			objects: []
		});
	});

	it('does not materialise a missing descriptor list during a read', async () => {
		const { token, metadata, bundle } = await committedPathBundle();
		await attachBundle(token, metadata.storePathHash, bundle);
		const key = attestationListObjectKey(
			fixtureTenant,
			metadata.storePathHash,
			{ kind: 'default' }
		);
		await env.BLOBS.delete(key);
		const beforeRead = {
			refs: await attestationReferenceRows(),
			objects: await casObjectRows(),
			descriptorPresent: (await env.BLOBS.head(key)) !== null
		};

		const list = await readFetch(`/attestations/${metadata.storePathHash}`);
		const head = await readFetch(`/attestations/${metadata.storePathHash}`, {
			method: 'HEAD'
		});

		expect({
			getStatus: list.status,
			headStatus: head.status,
			beforeRead,
			afterRead: {
				refs: await attestationReferenceRows(),
				objects: await casObjectRows(),
				descriptorPresent: (await env.BLOBS.head(key)) !== null
			}
		}).toStrictEqual({
			getStatus: StatusCodes.NOT_FOUND,
			headStatus: StatusCodes.NOT_FOUND,
			beforeRead,
			afterRead: beforeRead
		});
	});

	it('gates descriptor and bundle reads in private mode', async () => {
		const { token, metadata, bundle, digest } = await committedPathBundle();
		await attachBundle(token, metadata.storePathHash, bundle);
		await provisionFixtureTenant({
			defaultCacheAccess: 'private',
			read: { user: 'alice', password: 'secret' }
		});
		const authorised = {
			headers: { authorization: `Basic ${btoa('alice:secret')}` }
		};

		const listDenied = await readFetch(
			`/attestations/${metadata.storePathHash}`
		);
		const list = await readFetch(
			`/attestations/${metadata.storePathHash}`,
			authorised
		);
		const bundleDenied = await readFetch(`/attestation-bundles/${digest}`);
		const bundleRead = await readFetch(
			`/attestation-bundles/${digest}`,
			authorised
		);

		expect({
			listDenied: listDenied.status,
			list: list.status,
			listControl: list.headers.get('cache-control'),
			bundleDenied: bundleDenied.status,
			bundle: bundleRead.status,
			bundleControl: bundleRead.headers.get('cache-control')
		}).toStrictEqual({
			listDenied: StatusCodes.UNAUTHORIZED,
			list: StatusCodes.OK,
			listControl: 'no-store',
			bundleDenied: StatusCodes.UNAUTHORIZED,
			bundle: StatusCodes.OK,
			bundleControl: 'no-store'
		});
	});

	it('negotiates reuse only from this tenant own attestation edges', async () => {
		const { token, metadata, bundle, digest, nar } =
			await committedPathBundle();
		await attachBundle(token, metadata.storePathHash, bundle);
		const issuer = await provisionNamedTenant('other');
		const otherToken = await issueTokenForTenant(
			testServerFor('other'),
			issuer,
			cacheWriteGrants()
		);
		await pushPathThroughTenant('other', otherToken, metadata, nar);

		const own = await negotiate(token, metadata.storePathHash, digest);
		const other = await negotiateTenant(
			'other',
			otherToken,
			metadata.storePathHash,
			digest
		);
		const otherUpload = attestationUploadDecisionSchema.parse(other);

		expect({
			own,
			other: otherUpload,
			pending: await pendingAttestationRowsFor('other')
		}).toStrictEqual({
			own: {
				action: 'skip',
				storePathHash: metadata.storePathHash,
				digest
			},
			other: {
				action: 'upload',
				storePathHash: metadata.storePathHash,
				digest,
				uploadId: otherUpload.uploadId,
				r2Key: otherUpload.r2Key,
				expiresAt: otherUpload.expiresAt
			},
			pending: [
				{
					id: otherUpload.uploadId,
					r2Key: otherUpload.r2Key,
					expiresAt: otherUpload.expiresAt
				}
			]
		});
	});

	it('404s a referenced bundle whose shared CAS object is absent', async () => {
		const { token, metadata, bundle, digest } = await committedPathBundle();
		await attachBundle(token, metadata.storePathHash, bundle);
		await env.BLOBS.delete(await currentCasObjectKey(digest));

		const response = await readFetch(`/attestation-bundles/${digest}`);

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
	});

	it('rejects over-quota attach before promoting a CAS object', async () => {
		const { token, metadata, nar, bundle, digest } =
			await committedPathBundle();
		const quotaBytes = nar.narBytes.byteLength + bundle.byteLength - 1;
		await provisionFixtureTenant({ quotaBytes });

		const response = await attachBundleResponse(
			token,
			metadata.storePathHash,
			bundle
		);

		const body = orpcErrorBodyShape(await response.json());

		expect({
			status: response.status,
			body,
			refs: await attestationReferenceRows(),
			presence: await tenantCasBlobRows(),
			objects: await casObjectRows(),
			casObjectPresent:
				(await env.BLOBS.head(casObjectKey(digest, 2))) !== null,
			usage: await tenantUsageRow()
		}).toStrictEqual({
			status: StatusCodes.INSUFFICIENT_STORAGE,
			body: {
				defined: false,
				code: 'INSUFFICIENT_STORAGE',
				status: StatusCodes.INSUFFICIENT_STORAGE,
				data: undefined
			},
			refs: [],
			presence: [],
			objects: [],
			casObjectPresent: false,
			usage: {
				bytes: nar.narBytes.byteLength,
				narinfos: 1,
				blobs: 1,
				casBytes: 0,
				casBlobs: 0,
				quotaBytes
			}
		});
	});

	it('does not file an attestation against a generation replaced during attach', async () => {
		const { token, metadata, bundle, digest } = await committedPathBundle();
		const replacement = await verifiableNar('attestation-race-replacement');
		const decision = attestationUploadDecisionSchema.parse(
			await negotiate(token, metadata.storePathHash, digest)
		);

		await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });

		const error = await runInDurableObject(
			fixtureWorkerServer(),
			async (instance) => {
				const cache = resolvedCache(instance.context);

				class RacingAttestationCasService extends AttestationCasService {
					override async measureStagedBundle(
						key: R2ObjectKey
					): ReturnType<typeof instance.measureAttestationBundle> {
						const measured = await super.measureStagedBundle(key);
						instance.context.db
							.update(schema.narInfos)
							.set({
								narHash: replacement.narHash,
								generation: narInfoGenerationSchema.parse(1)
							})
							.where(
								and(
									eq(schema.narInfos.cacheId, cache.id),
									eq(schema.narInfos.storePathHash, metadata.storePathHash)
								)
							)
							.run();

						return measured;
					}
				}
				const attestations = new AttestationsService(
					instance.context,
					new CacheRegistrationService(instance.context),
					new RacingAttestationCasService(instance.context),
					new NarInfoObjectsService(instance.context)
				);

				try {
					return await attestations.attach(cache.scope, decision.uploadId);
				} catch (error: unknown) {
					return error;
				}
			}
		);
		expect(error).toBeInstanceOf(AttestationPathNotFoundError);
		if (!(error instanceof AttestationPathNotFoundError)) {
			throw error;
		}

		expect({
			error: {
				name: error.name,
				status: error.status,
				storePathHash: error.storePathHash
			},
			refs: await attestationReferenceRows(),
			objects: await casObjectRows()
		}).toStrictEqual({
			error: {
				name: AttestationPathNotFoundError.name,
				status: StatusCodes.NOT_FOUND,
				storePathHash: metadata.storePathHash
			},
			refs: [],
			objects: []
		});
	});

	it('garbage-collects expired pending attestation uploads and staging objects', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const { token, metadata, bundle, digest } = await committedPathBundle();
		const existingPending = await pendingAttestationRows();
		const decision = attestationUploadDecisionSchema.parse(
			await negotiate(token, metadata.storePathHash, digest)
		);

		await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });

		const expiredPending = {
			id: decision.uploadId,
			r2Key: decision.r2Key,
			expiresAt: '2026-01-01T00:15:00.000Z'
		};
		expect(await pendingAttestationRows()).toStrictEqual(
			[...existingPending, expiredPending].toSorted(compareById)
		);
		await expect(env.BLOBS.head(decision.r2Key)).resolves.not.toBeNull();

		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));

		await fixtureWorkerServer().runGarbageCollection();

		expect(await pendingAttestationRows()).toStrictEqual(existingPending);
		await expect(env.BLOBS.head(decision.r2Key)).resolves.toBeNull();
	});

	it('rejects an oversized bundle from metadata without filing a CAS object', async () => {
		const { token, metadata } = await committedPathBundle();
		const bundle = new Uint8Array(1024 * 1024 + 1);
		const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));
		const decision = attestationUploadDecisionSchema.parse(
			await negotiate(token, metadata.storePathHash, digest)
		);

		await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });

		const response = await authorisedWorkerFetch(
			`/attestations/${decision.uploadId}/attach`,
			token,
			{ method: 'POST' }
		);

		const staging = await env.BLOBS.head(decision.r2Key);
		const pending = await pendingAttestationRows();
		const body = orpcErrorBodyShape(await response.json());

		expect({
			status: response.status,
			body,
			refs: await attestationReferenceRows(),
			objects: await casObjectRows(),
			pending: pending.filter((row) => row.id === decision.uploadId),
			stagingPresent: staging !== null
		}).toStrictEqual({
			status: StatusCodes.REQUEST_TOO_LONG,
			body: {
				defined: false,
				code: 'PAYLOAD_TOO_LARGE',
				status: StatusCodes.REQUEST_TOO_LONG,
				data: undefined
			},
			refs: [],
			objects: [],
			pending: [],
			stagingPresent: false
		});
	});

	// A re-run of `cupboard attest` over an unchanged closure sends one bundle for
	// each already-attested path, and negotiate heads the CAS object of every one
	// whose path is committed and whose digest it already records. A bundle's
	// digest is the hash of its own document, so no two bundles in a closure
	// share one and the deduplication by digest saves nothing. One page of
	// bundles therefore costs one subrequest each, and a page larger than the
	// invocation's subrequests cannot be served at all: the call that exceeds
	// the ceiling throws, and the caller gets nothing back.
	it('costs one subrequest for each already-attested bundle of a page', async () => {
		const extra = 4;
		const first = await committedPathBundle();
		const { token } = first;
		await attachBundle(token, first.metadata.storePathHash, first.bundle);
		const bundles = [
			{ storePathHash: first.metadata.storePathHash, digest: first.digest }
		];

		for (let index = 0; index < extra; index += 1) {
			const nar = await verifiableNar(`attested-${String(index)}`);
			const metadata = uploadMetadata({
				storePathHash: uniqueStorePathHash(),
				narHash: nar.narHash,
				narSize: nar.narSize,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength
			});
			await pushPathThroughTenant(fixtureTenant, token, metadata, nar);
			const bundle = sigstoreBundleBytes(narDigestHex(nar.narHash));
			await attachBundle(token, metadata.storePathHash, bundle);
			bundles.push({
				storePathHash: metadata.storePathHash,
				digest: sha256HexDigestSchema.parse(await sha256HexBytes(bundle))
			});
		}

		const heads = vi.spyOn(env.BLOBS, 'head');

		try {
			const response = await authorisedWorkerFetch('/attestations', token, {
				body: JSON.stringify({ pushId: testPushId, bundles }),
				headers: { 'content-type': 'application/json' },
				method: 'POST'
			});

			expect(response.status).toBe(StatusCodes.OK);

			const casHeads = heads.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].startsWith('cas/')
			).length;
			const pageHeads =
				(casHeads / bundles.length) * attestationNegotiateMaxBundles;

			expect({
				headsPerBundle: casHeads / bundles.length,
				pageFitsTheCeiling:
					pageHeads <= workersInvocationAllowances.free.subrequests
			}).toStrictEqual({ headsPerBundle: 1, pageFitsTheCeiling: true });
		} finally {
			heads.mockRestore();
		}
	});

	it('fits a maximum distinct-digest page through cold and warm request dispatch', async () => {
		const first = await committedPathBundle();
		const digests = Array.from(
			{ length: attestationNegotiateMaxBundles },
			(_, index) =>
				sha256HexDigestSchema.parse((index + 1).toString(16).padStart(64, '0'))
		);
		const database = drizzleD1(env.CUPBOARD_DB, {
			schema: { casObject: d1Schema.casObject }
		});

		for (const page of chunk(digests, 25)) {
			await database
				.insert(d1Schema.casObject)
				.values(
					page.map((digest) => ({
						digest,
						size: 1,
						storedAt: isoTimestamp(new Date())
					}))
				)
				.run();
		}

		const bundles = digests.map((digest) => ({
			storePathHash: first.metadata.storePathHash,
			digest
		}));
		const uploadIds = Array.from({ length: digests.length * 2 }, () =>
			uploadIdSchema.parse(crypto.randomUUID())
		);
		let nextUploadId = 0;
		const randomUUID = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
			const uploadId = uploadIds[nextUploadId];
			nextUploadId += 1;

			if (uploadId === undefined) {
				throw new Error('negotiation generated more upload IDs than bundles');
			}

			return uploadId;
		});
		const now = new Date();
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const expiresAt = isoTimestamp(new Date(now.getTime() + 15 * 60 * 1000));

		let result;

		try {
			result = await runInDurableObject(
				fixtureWorkerServer(),
				async (instance, state) => {
					const restarted = new CupboardServer(state, {
						...instance.context.env,
						BLOBS: env.BLOBS,
						CUPBOARD_DB: env.CUPBOARD_DB,
						CUPBOARD_SUBREQUESTS_PER_INVOCATION: String(
							workersInvocationAllowances.free.subrequests
						)
					});

					const negotiate = () =>
						withSubrequestSlice(
							async () => {
								const availableBefore = subrequestsAvailable();
								const response = await restarted.fetch(
									new Request('https://cupboard.test/attestations', {
										body: JSON.stringify({ pushId: testPushId, bundles }),
										headers: {
											authorization: `Bearer ${first.token}`,
											'content-type': 'application/json'
										},
										method: 'POST'
									})
								);

								return {
									calls: availableBefore - subrequestsAvailable(),
									httpStatus: response.status,
									body: attestationNegotiateResponseSchema.parse(
										await response.json()
									)
								};
							},
							{
								subrequests: workersInvocationAllowances.free.subrequests,
								reserve: subrequestSafetyReserve
							}
						);

					return {
						cold: await negotiate(),
						warm: await negotiate()
					};
				}
			);
		} finally {
			randomUUID.mockRestore();
			vi.useRealTimers();
		}

		const decisions = (offset: number) =>
			bundles.map((bundle, index) => {
				const uploadId = uploadIds[offset + index];

				if (uploadId === undefined) {
					throw new Error('missing expected upload ID');
				}

				return {
					action: 'upload' as const,
					...bundle,
					uploadId,
					r2Key: attestationStagingObjectKey(testPushId, uploadId),
					expiresAt
				};
			});

		expect(result).toStrictEqual({
			cold: {
				calls: 855,
				httpStatus: StatusCodes.OK,
				body: {
					bundles: decisions(0)
				}
			},
			warm: {
				calls: 854,
				httpStatus: StatusCodes.OK,
				body: {
					bundles: decisions(bundles.length)
				}
			}
		});
	}, 120_000);

	it('decides correctly for more bundles than a statement could bind', async () => {
		// 101 distinct storePathHashes and the cache would be 102 parameters if
		// the read bound a value per hash, so this pins the Durable Object read
		// that negotiate makes from a bound list.
		const { token, metadata, bundle, digest } = await committedPathBundle();
		await attachBundle(token, metadata.storePathHash, bundle);

		const uncommittedHashes = Array.from({ length: maxBoundParameters }, () =>
			uniqueStorePathHash()
		);
		const fakeDigest = sha256HexDigestSchema.parse('ab'.repeat(32));
		const bundles = [
			{ storePathHash: metadata.storePathHash, digest },
			...uncommittedHashes.map((storePathHash) => ({
				storePathHash,
				digest: fakeDigest
			}))
		];

		const response = await authorisedWorkerFetch('/attestations', token, {
			body: JSON.stringify({ pushId: testPushId, bundles }),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		});
		expect(response.status).toBe(StatusCodes.OK);
		const body = attestationNegotiateResponseSchema.parse(
			await response.json()
		);
		const decisions = body.bundles.map((b) =>
			attestationDecisionSchema.parse(b)
		);

		const skipDecisions = decisions.filter((d) => d.action === 'skip');
		const uploadDecisions = decisions.filter((d) => d.action === 'upload');

		expect({
			totalDecisions: decisions.length,
			skipCount: skipDecisions.length,
			uploadCount: uploadDecisions.length,
			skip: skipDecisions
		}).toStrictEqual({
			totalDecisions: maxBoundParameters + 1,
			skipCount: 1,
			uploadCount: maxBoundParameters,
			skip: [{ action: 'skip', storePathHash: metadata.storePathHash, digest }]
		});
	});
});

function attestationsFor(context: ServerContext): AttestationsService {
	return new AttestationsService(
		context,
		new CacheRegistrationService(context),
		new AttestationCasService(context),
		new NarInfoObjectsService(context)
	);
}

// Runs one drain of the inheritance queue, as the maintenance alarm does.
async function drainInheritance(): Promise<MaintenanceProgress> {
	const outcome = await runInDurableObject(fixtureWorkerServer(), (instance) =>
		attestationsFor(instance.context).drainInheritanceQueue(rootLogger())
	);

	return outcome.progress;
}

// Publishes a path to the default cache with one bundle, then publishes it to a
// named destination cache. The destination's inheritance row stays queued.
async function reusedPathWithSourceBundle(name: string): Promise<{
	readonly token: string;
	readonly destination: Extract<CacheScope, { kind: 'named' }>;
	readonly metadata: ReturnType<typeof uploadMetadata>;
	readonly digest: Sha256HexDigest;
}> {
	const destination = namedCache(name);
	const token = await initialiseViaWorker();
	await putWorkerTestCache(token, destination);
	const nar = await verifiableNar(name);
	const metadata = uploadMetadata({
		storePathHash: uniqueStorePathHash(),
		narHash: nar.narHash,
		narSize: nar.narSize,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength
	});
	await pushPathThroughTenant(fixtureTenant, token, metadata, nar);
	const bundle = sigstoreBundleBytes(narDigestHex(nar.narHash));
	const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));
	await attachBundle(token, metadata.storePathHash, bundle);
	await drainInheritance();
	await pushPathThroughTenant(fixtureTenant, token, metadata, nar, destination);

	return { token, destination, metadata, digest };
}

// Makes a failed path due again without waiting for its retry delay.
async function makeQueuedInheritancesDue(): Promise<void> {
	await runInDurableObject(fixtureWorkerServer(), (instance) => {
		instance.context.db
			.update(schema.attestationInheritances)
			.set({ notBefore: isoTimestamp(new Date()) })
			.run();
	});
}

async function queuedInheritances(): Promise<
	{ readonly storePathHash: string; readonly attempts: number }[]
> {
	return runInDurableObject(fixtureWorkerServer(), (instance) =>
		instance.context.db
			.select({
				storePathHash: schema.attestationInheritances.storePathHash,
				attempts: schema.attestationInheritances.attempts
			})
			.from(schema.attestationInheritances)
			.all()
	);
}

async function committedPathBundle(): Promise<{
	readonly token: string;
	readonly nar: Awaited<ReturnType<typeof verifiableNar>>;
	readonly metadata: ReturnType<typeof uploadMetadata>;
	readonly bundle: Uint8Array;
	readonly digest: Sha256HexDigest;
}> {
	const token = await initialiseViaWorker();
	const nar = await verifiableNar('attestation-path');
	const storePathHash = uniqueStorePathHash();
	const metadata = uploadMetadata({
		storePathHash,
		narHash: nar.narHash,
		narSize: nar.narSize,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength
	});
	await pushPathThroughTenant(fixtureTenant, token, metadata, nar);
	const bundle = sigstoreBundleBytes(narDigestHex(nar.narHash));
	const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));

	return { token, nar, metadata, bundle, digest };
}

// Distinct for 1,024 calls: the cursor's two low base-32 digits vary.
function uniqueStorePathHash(): string {
	const nixBase32 = '0123456789abcdfghijklmnpqrsvwxyz';
	const index = storePathHashCursor.next;
	storePathHashCursor.next += 1;

	const high = nixBase32[Math.floor(index / 32) % 32] ?? '0';
	const low = nixBase32[index % 32] ?? '0';

	return `${'0'.repeat(30)}${high}${low}`;
}

async function attachBundle(
	token: string,
	pathHash: string,
	bundle: Uint8Array,
	cache: CacheScope = defaultCacheScope
): Promise<unknown> {
	const response = await attachBundleResponse(token, pathHash, bundle, cache);
	expect(response.status).toBe(StatusCodes.OK);

	return attestationAttachResponseSchema.parse(await response.json());
}

async function attachBundleResponse(
	token: string,
	pathHash: string,
	bundle: Uint8Array,
	cache: CacheScope = defaultCacheScope
): Promise<Response> {
	const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));
	const decision = attestationUploadDecisionSchema.parse(
		await negotiate(token, pathHash, digest, cache)
	);

	await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });

	return authorisedWorkerFetch(
		cacheScopedPath(cache, `/attestations/${decision.uploadId}/attach`),
		token,
		{ method: 'POST' }
	);
}

async function negotiate(
	token: string,
	pathHash: string,
	digest: Sha256HexDigest,
	cache: CacheScope = defaultCacheScope
): Promise<AttestationDecision> {
	const response = await authorisedWorkerFetch(
		cacheScopedPath(cache, '/attestations'),
		token,
		{
			body: JSON.stringify({
				pushId: testPushId,
				bundles: [{ storePathHash: pathHash, digest }]
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		}
	);
	expect(response.status).toBe(StatusCodes.OK);
	const body = attestationNegotiateResponseSchema.parse(await response.json());
	const [bundle] = z.tuple([attestationDecisionSchema]).parse(body.bundles);

	return bundle;
}

async function negotiateTenant(
	tenant: string,
	token: string,
	pathHash: string,
	digest: Sha256HexDigest
): Promise<AttestationDecision> {
	const pushId = await testPushIdFor(tenant);
	const response = await tenantFetch(tenant, '/attestations', token, {
		body: JSON.stringify({
			pushId,
			bundles: [{ storePathHash: pathHash, digest }]
		}),
		headers: { 'content-type': 'application/json' },
		method: 'POST'
	});
	expect(response.status).toBe(StatusCodes.OK);
	const body = attestationNegotiateResponseSchema.parse(await response.json());
	const [bundle] = z.tuple([attestationDecisionSchema]).parse(body.bundles);

	return bundle;
}

async function pendingAttestationRowsFor(
	tenant: string
): Promise<{ id: string; r2Key: string; expiresAt: string }[]> {
	const rows = await runInDurableObject(
		testServerFor(tenant),
		(_instance, state) =>
			drizzle(state.storage, {
				schema: { pendingAttestations: schema.pendingAttestations }
			})
				.select({
					id: schema.pendingAttestations.id,
					r2Key: schema.pendingAttestations.r2Key,
					expiresAt: schema.pendingAttestations.expiresAt
				})
				.from(schema.pendingAttestations)
				.all()
	);

	return rows.toSorted(compareById);
}

async function pushPathThroughTenant(
	tenant: string,
	token: string,
	metadata: ReturnType<typeof uploadMetadata>,
	nar: Awaited<ReturnType<typeof verifiableNar>>,
	cache?: CacheScope,
	beforeCommit?: () => Promise<void>
): Promise<void> {
	const pushId = await testPushIdFor(tenant);
	const negotiated = await tenantFetch(
		tenant,
		cacheScopedPath(cache ?? { kind: 'default' }, '/uploads'),
		token,
		{
			body: JSON.stringify({
				pushId,
				paths: [uploadPathNegotiation(metadata)]
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		}
	);
	expect(negotiated.status).toBe(StatusCodes.OK);
	const body = uploadNegotiateResponseSchema.parse(await negotiated.json());
	const [decision] = z.tuple([uploadDecisionSchema]).parse(body.uploads);
	expect(decision.action).not.toBe('skip');
	if (decision.action === 'skip') {
		throw new Error('Expected an upload or commit decision');
	}

	if (decision.action === 'upload') {
		await putNarBytes(decision.r2Key, nar);
	}

	await beforeCommit?.();

	const committed = await commitUploadViaWorker(token, decision.uploadId, {
		tenant,
		...(cache !== undefined && { cache })
	});
	expect(committed.status).toBe('committed');
}

function tenantFetch(
	tenant: string,
	path: string,
	token: string,
	init: RequestInit
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('authorization', `Bearer ${token}`);

	return handlerFetch(`/t/${tenant}${path}`, { ...init, headers });
}
