import { rootLogger } from '@cupboard/logger';
import { startCapture } from '@cupboard/logger/testing';
import {
	nixSha256HashSchema,
	sha256HexDigestSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { publicationStagingKey } from '@cupboard/protocol/publication';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { pushIdSchema, uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	PushIdSigningKeyMissingError,
	TenantNotConfiguredError
} from '../errors.ts';
import {
	attestationStagingObjectKey,
	r2ObjectKeySchema,
	stagingObjectKey,
	stagingPushPrefix
} from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	asOneInvocation,
	clearBlobStorage,
	currentServer,
	garbageCollectionOf,
	initialise,
	negotiateUploads,
	provisionNamedTenant,
	resetTestServer,
	resolvedCache,
	runGcResult,
	syntheticNarHash,
	testPushId,
	testPushIdFor,
	testServerFor,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

import { type GarbageCollectionOutcome } from './context.ts';
import { maxOrphanListPages } from './garbage-collection-service.ts';
import { type CupboardServer } from './server.ts';

// A push credential is scoped to `staging/<pushId>/`, so a client may write keys
// beneath it that it never negotiated. The negotiated keys have pending rows the
// reaper owns; reconciliation reclaims the rest once they age past the upload
// grace. The harness fakes `Date` at a fixed epoch but R2 stamps
// `R2Object.uploaded` from the real wall clock, so these tests read the real time
// back from a probe object and move the garbage collector's clock relative to it.

const uploadGraceMs = 15 * 60 * 1000;

async function realUploadInstant(): Promise<number> {
	await env.BLOBS.put('probe/now', new Uint8Array([0]));
	const head = await env.BLOBS.head('probe/now');
	await env.BLOBS.delete('probe/now');

	if (head === null) {
		throw new Error('probe object vanished');
	}

	return head.uploaded.getTime();
}

interface CollectionPass {
	readonly outcome: GarbageCollectionOutcome;
	readonly issuerResolutions: number;
}

interface CollectionOptions {
	readonly wrapBlobs?: (blobs: R2Bucket) => R2Bucket;
	readonly issuerError?: Error;
}

async function collectGarbageIn(
	stub: DurableObjectStub<CupboardServer>,
	{ wrapBlobs = (blobs) => blobs, issuerError }: CollectionOptions = {}
): Promise<CollectionPass> {
	return runInDurableObject(stub, async (instance) => {
		const original = instance.context.env;
		instance.context.env = { ...original, BLOBS: wrapBlobs(original.BLOBS) };
		const pushCredentials = vi.spyOn(instance.context, 'pushCredentials');

		if (issuerError !== undefined) {
			pushCredentials.mockImplementation(() => {
				throw issuerError;
			});
		}

		try {
			const outcome = await asOneInvocation(() =>
				garbageCollectionOf(instance).collectGarbage(rootLogger(), {
					scope: 'tenant'
				})
			);

			return { outcome, issuerResolutions: pushCredentials.mock.calls.length };
		} finally {
			pushCredentials.mockRestore();
			instance.context.env = original;
		}
	});
}

async function presentKeys(keys: readonly string[]): Promise<string[]> {
	const present: string[] = [];

	for (const key of keys) {
		if ((await env.BLOBS.head(key)) !== null) {
			present.push(key);
		}
	}

	return present;
}

interface ListingPass {
	startAfter: string | undefined;
	readonly listed: string[];
}

// Lists one key per page so a pass reaches its page limit after
// `maxOrphanListPages` keys. Records the keys that the pass listed and the
// `startAfter` of its first request.
function recordingOnePerPage(target: R2Bucket, pass: ListingPass): R2Bucket {
	let isFirstCall = true;

	return new Proxy(target, {
		get(bucketTarget, property) {
			if (property === 'list') {
				return async (options?: R2ListOptions) => {
					if (isFirstCall && options?.prefix === 'staging/') {
						pass.startAfter = options.startAfter;
						isFirstCall = false;
					}

					const listed = await bucketTarget.list({ ...options, limit: 1 });
					pass.listed.push(...listed.objects.map((object) => object.key));

					return listed;
				};
			}

			const value: unknown = Reflect.get(bucketTarget, property, bucketTarget);

			if (typeof value !== 'function') {
				return value;
			}

			const bound: unknown = value.bind(bucketTarget);

			return bound;
		}
	});
}

describe('orphan staging reconciliation', () => {
	beforeEach(async () => {
		await resetTestServer();
		await clearBlobStorage();
	});

	it('protects new staging with an authentic push lease and reclaims expired or forged leases', async () => {
		const realNow = await realUploadInstant();
		const expiry = Math.floor(realNow / 1000) + 3600;
		const push = await testPushIdFor(fixtureTenant, 2, expiry);
		const forged = pushIdSchema.parse(
			`${push.slice(0, -1)}${push.endsWith('0') ? '1' : '0'}`
		);
		const id = 'a'.repeat(64);
		const liveKey = publicationStagingKey(fixtureTenant, push, id);
		const forgedKey = publicationStagingKey(fixtureTenant, forged, id);
		await env.BLOBS.put(liveKey, new Uint8Array([1]));
		await env.BLOBS.put(forgedKey, new Uint8Array([1]));
		vi.setSystemTime(new Date(realNow + 20 * 60 * 1000));
		await initialise();
		const first = await collectGarbageIn(currentServer());
		expect({
			deleted: first.outcome.orphanStagingDeleted,
			present: await presentKeys([liveKey, forgedKey])
		}).toStrictEqual({ deleted: 1, present: [liveKey] });
		vi.setSystemTime(new Date((expiry + 1) * 1000));
		const second = await collectGarbageIn(currentServer());
		expect({
			deleted: second.outcome.orphanStagingDeleted,
			present: await presentKeys([liveKey])
		}).toStrictEqual({ deleted: 1, present: [] });
	});

	it('reclaims an un-negotiated staging object and spares the negotiated one', async () => {
		const realNow = await realUploadInstant();
		vi.setSystemTime(new Date(realNow + uploadGraceMs + 5 * 60 * 1000));

		const token = await initialise();
		const nar = await verifiableNar('orphan-tracked');
		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		const negotiation = await negotiateUploads(token, [metadata]);
		const decision = negotiation.uploads[0];

		if (decision?.action !== 'upload') {
			throw new Error('expected an upload decision for a fresh nar');
		}

		const trackedKey = decision.r2Key;
		const pushPrefix = trackedKey.slice(0, trackedKey.lastIndexOf('/') + 1);
		const orphanKey = `${pushPrefix}un-negotiated.nar.zst`;

		await env.BLOBS.put(trackedKey, nar.narBytes);
		await env.BLOBS.put(orphanKey, new Uint8Array([1, 2, 3]));

		const result = await runGcResult();

		expect({
			orphanStagingDeleted: result.orphanStagingDeleted,
			trackedPresent: (await env.BLOBS.head(trackedKey)) !== null,
			orphanPresent: (await env.BLOBS.head(orphanKey)) !== null
		}).toStrictEqual({
			orphanStagingDeleted: 1,
			trackedPresent: true,
			orphanPresent: false
		});
	});

	it('spares pending NAR and attestation objects with current and historical keys', async () => {
		const fixtures = [
			{
				kind: 'nar',
				id: uploadIdSchema.parse('historical-nar'),
				key: r2ObjectKeySchema.parse('staging/historical-nar.nar.zst')
			},
			{
				kind: 'nar',
				id: uploadIdSchema.parse('current-nar'),
				key: stagingObjectKey(testPushId, uploadIdSchema.parse('current-nar'))
			},
			{
				kind: 'attestation',
				id: uploadIdSchema.parse('historical-attestation'),
				key: r2ObjectKeySchema.parse(
					'staging/attestations/historical-attestation'
				)
			},
			{
				kind: 'attestation',
				id: uploadIdSchema.parse('current-attestation'),
				key: attestationStagingObjectKey(
					testPushId,
					uploadIdSchema.parse('current-attestation')
				)
			}
		] as const;
		const realNow = await realUploadInstant();
		const collectionTime = realNow + uploadGraceMs + 5 * 60 * 1000;
		const expiresAt = isoTimestampSchema.parse(
			new Date(collectionTime + 60 * 60 * 1000).toISOString()
		);

		await Promise.all(
			fixtures.map((fixture) =>
				env.BLOBS.put(fixture.key, new Uint8Array([1, 2, 3]))
			)
		);
		await runInDurableObject(currentServer(), (instance) => {
			const cacheId = resolvedCache(instance.context).id;

			for (const fixture of fixtures) {
				if (fixture.kind === 'nar') {
					instance.context.db
						.insert(schema.pendingUploads)
						.values({
							id: fixture.id,
							cacheId,
							narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
							r2Key: fixture.key,
							metadataJson: '{}',
							createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
							expiresAt,
							verdict: 'pending'
						})
						.run();

					continue;
				}

				instance.context.db
					.insert(schema.pendingAttestations)
					.values({
						id: fixture.id,
						cacheId,
						storePathHash: storePathHashSchema.parse('a'.repeat(32)),
						digest: sha256HexDigestSchema.parse('0'.repeat(64)),
						r2Key: fixture.key,
						createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
						expiresAt
					})
					.run();
			}
		});
		vi.setSystemTime(new Date(collectionTime));

		const result = await runGcResult();
		const objects = await Promise.all(
			fixtures.map(async (fixture) => ({
				key: fixture.key,
				present: (await env.BLOBS.head(fixture.key)) !== null
			}))
		);

		expect({
			orphanStagingDeleted: result.orphanStagingDeleted,
			objects
		}).toStrictEqual({
			orphanStagingDeleted: 0,
			objects: fixtures.map((fixture) => ({
				key: fixture.key,
				present: true
			}))
		});
	});

	it('spares an untracked staging object still within the upload grace', async () => {
		const realNow = await realUploadInstant();
		vi.setSystemTime(new Date(realNow + 60_000));

		const orphanKey = stagingObjectKey(
			testPushId,
			uploadIdSchema.parse('recent')
		);
		await env.BLOBS.put(orphanKey, new Uint8Array([1, 2, 3]));

		const result = await runGcResult();

		expect({
			orphanStagingDeleted: result.orphanStagingDeleted,
			orphanPresent: (await env.BLOBS.head(orphanKey)) !== null
		}).toStrictEqual({ orphanStagingDeleted: 0, orphanPresent: true });
	});

	it('bounds list pages when every staged object is still young', async () => {
		const realNow = await realUploadInstant();
		vi.setSystemTime(new Date(realNow + 60_000));
		const key = 'staging/recent-push/recent.nar.zst';
		await env.BLOBS.put(key, new Uint8Array([1]));
		const page = await env.BLOBS.list({ prefix: 'staging/' });
		let listCalls = 0;

		const result = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const original = instance.context.env;
				instance.context.env = {
					...original,
					BLOBS: {
						...original.BLOBS,
						head: original.BLOBS.head.bind(original.BLOBS),
						get: original.BLOBS.get.bind(original.BLOBS),
						put: original.BLOBS.put.bind(original.BLOBS),
						delete: original.BLOBS.delete.bind(original.BLOBS),
						list: () => {
							listCalls += 1;

							return Promise.resolve({
								...page,
								truncated: true,
								cursor: String(listCalls)
							});
						},
						createMultipartUpload: original.BLOBS.createMultipartUpload.bind(
							original.BLOBS
						),
						resumeMultipartUpload: original.BLOBS.resumeMultipartUpload.bind(
							original.BLOBS
						)
					}
				};

				try {
					return await asOneInvocation(() =>
						garbageCollectionOf(instance).collectGarbage(rootLogger(), {
							scope: 'tenant'
						})
					);
				} finally {
					instance.context.env = original;
				}
			}
		);

		expect({
			listCalls,
			deleted: result.orphanStagingDeleted,
			objectPresent: (await env.BLOBS.head(key)) !== null
		}).toStrictEqual({
			listCalls: maxOrphanListPages,
			deleted: 0,
			objectPresent: true
		});
	});

	it('checks one listed key at constant cost as the pending backlog grows', async () => {
		const measured = await runInDurableObject(currentServer(), (instance) => {
			const { db, dbCost } = instance.context;
			const cacheId = resolvedCache(instance.context).id;
			const garbageCollection = (
				instance as unknown as {
					garbageCollection: {
						trackedStagingKeys(keys: readonly string[]): ReadonlySet<string>;
					};
				}
			).garbageCollection;
			const insert = (from: number, to: number): void => {
				for (let index = from; index < to; index += 1) {
					const uploadId = uploadIdSchema.parse(`pending-${String(index)}`);
					const attestationId = uploadIdSchema.parse(
						`attestation-${String(index)}`
					);

					db.insert(schema.pendingUploads)
						.values({
							id: uploadId,
							cacheId,
							narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
							r2Key: r2ObjectKeySchema.parse(
								`staging/push/${uploadId}.nar.zst`
							),
							metadataJson: '{}',
							createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
							expiresAt: isoTimestampSchema.parse('2026-01-02T00:00:00.000Z')
						})
						.run();
					db.insert(schema.pendingAttestations)
						.values({
							id: attestationId,
							cacheId,
							storePathHash: storePathHashSchema.parse('a'.repeat(32)),
							digest: sha256HexDigestSchema.parse('0'.repeat(64)),
							r2Key: r2ObjectKeySchema.parse(
								`staging/push/attestations/${attestationId}`
							),
							createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
							expiresAt: isoTimestampSchema.parse('2026-01-02T00:00:00.000Z')
						})
						.run();
				}
			};
			const measure = (): number => {
				dbCost.recordOutstanding();
				const before = dbCost.rowsRead;
				garbageCollection.trackedStagingKeys([
					'staging/push/not-pending.nar.zst',
					'staging/push/attestations/not-pending'
				]);
				dbCost.recordOutstanding();

				return dbCost.rowsRead - before;
			};

			insert(0, 3);
			const smallBacklog = measure();
			insert(3, 503);
			const largeBacklog = measure();

			return { smallBacklog, largeBacklog };
		});

		expect(measured.largeBacklog).toBe(measured.smallBacklog);
	});

	it('caps the reclaim per run and leaves the overflow for the next run', async () => {
		const perRunCap = 1000;
		const total = perRunCap + 1;

		const realNow = await realUploadInstant();
		vi.setSystemTime(new Date(realNow + uploadGraceMs + 5 * 60 * 1000));

		const keys = Array.from({ length: total }, (_unused, index) =>
			stagingObjectKey(testPushId, uploadIdSchema.parse(String(index)))
		);
		await Promise.all(
			keys.map((key) => env.BLOBS.put(key, new Uint8Array([1])))
		);

		const capture = startCapture();

		let result;
		try {
			result = await runGcResult();
		} finally {
			capture.stop();
		}

		const remaining = await env.BLOBS.list({
			prefix: stagingPushPrefix(testPushId)
		});
		const nextResult = await runGcResult();
		const remainingAfterNext = await env.BLOBS.list({
			prefix: stagingPushPrefix(testPushId)
		});

		expect({
			orphanStagingDeleted: result.orphanStagingDeleted,
			remaining: remaining.objects.length,
			next: {
				orphanStagingDeleted: nextResult.orphanStagingDeleted,
				remaining: remainingAfterNext.objects.length
			},
			capLogs: capture.logs
				.filter(
					(entry) => entry.message === 'orphan staging scan hit the per-run cap'
				)
				.map((entry) => ({ level: entry.level, properties: entry.properties }))
		}).toStrictEqual({
			orphanStagingDeleted: perRunCap,
			remaining: total - perRunCap,
			next: { orphanStagingDeleted: total - perRunCap, remaining: 0 },
			capLogs: [
				{
					level: 'debug',
					properties: {
						job: 'garbage-collection',
						method: 'POST',
						path: '/gc',
						reclaimed: perRunCap
					}
				}
			]
		});
	});

	it("reclaims only the orphans under its own tenant's push IDs", async () => {
		const otherTenant = tenantIdSchema.parse('orphan-staging-other');
		await provisionNamedTenant(otherTenant);
		const ownPushId = await testPushIdFor(fixtureTenant);
		const otherPushId = await testPushIdFor(otherTenant);
		const uploadId = uploadIdSchema.parse('untracked');
		const ownKeys = [
			stagingObjectKey(ownPushId, uploadId),
			attestationStagingObjectKey(ownPushId, uploadId)
		];
		const otherKeys = [
			stagingObjectKey(otherPushId, uploadId),
			attestationStagingObjectKey(otherPushId, uploadId)
		];
		const realNow = await realUploadInstant();
		await Promise.all(
			[...ownKeys, ...otherKeys].map((key) =>
				env.BLOBS.put(key, new Uint8Array([1, 2, 3]))
			)
		);
		vi.setSystemTime(new Date(realNow + uploadGraceMs + 5 * 60 * 1000));

		const ownPass = await collectGarbageIn(currentServer());
		const afterOwnPass = await presentKeys([...ownKeys, ...otherKeys]);
		const otherPass = await collectGarbageIn(testServerFor(otherTenant));
		const afterOtherPass = await presentKeys([...ownKeys, ...otherKeys]);

		expect({
			ownPass: {
				orphanStagingDeleted: ownPass.outcome.orphanStagingDeleted,
				issuerResolutions: ownPass.issuerResolutions,
				present: afterOwnPass
			},
			otherPass: {
				orphanStagingDeleted: otherPass.outcome.orphanStagingDeleted,
				issuerResolutions: otherPass.issuerResolutions,
				present: afterOtherPass
			}
		}).toStrictEqual({
			ownPass: {
				orphanStagingDeleted: 2,
				issuerResolutions: 1,
				present: otherKeys
			},
			otherPass: {
				orphanStagingDeleted: 2,
				issuerResolutions: 1,
				present: []
			}
		});
	});

	it('spares staging keys whose first segment is not a push ID', async () => {
		const legacyKeys = [
			'staging/legacy-upload.nar.zst',
			'staging/attestations/legacy-attestation'
		];
		const realNow = await realUploadInstant();
		await Promise.all(
			legacyKeys.map((key) => env.BLOBS.put(key, new Uint8Array([1, 2, 3])))
		);
		vi.setSystemTime(new Date(realNow + uploadGraceMs + 5 * 60 * 1000));

		const pass = await collectGarbageIn(currentServer());

		expect({
			orphanStagingDeleted: pass.outcome.orphanStagingDeleted,
			issuerResolutions: pass.issuerResolutions,
			present: await presentKeys(legacyKeys)
		}).toStrictEqual({
			orphanStagingDeleted: 0,
			issuerResolutions: 0,
			present: legacyKeys
		});
	});

	it('reclaims an orphan under its own push ID after the push ID expires', async () => {
		const expiredPushId = await testPushIdFor(fixtureTenant, 1, 1);
		const uploadId = uploadIdSchema.parse('untracked');
		const keys = [
			stagingObjectKey(expiredPushId, uploadId),
			attestationStagingObjectKey(expiredPushId, uploadId)
		];
		const realNow = await realUploadInstant();
		await Promise.all(
			keys.map((key) => env.BLOBS.put(key, new Uint8Array([1, 2, 3])))
		);
		vi.setSystemTime(new Date(realNow + uploadGraceMs + 5 * 60 * 1000));

		const pass = await collectGarbageIn(currentServer());

		expect({
			orphanStagingDeleted: pass.outcome.orphanStagingDeleted,
			present: await presentKeys(keys)
		}).toStrictEqual({ orphanStagingDeleted: 2, present: [] });
	});

	it('resumes the listing after the last examined key and restarts from the beginning after the end', async () => {
		const keys = Array.from(
			{ length: maxOrphanListPages + 2 },
			(_unused, index) =>
				stagingObjectKey(
					testPushId,
					uploadIdSchema.parse(`young-${String(index)}`)
				)
		);
		const realNow = await realUploadInstant();
		await Promise.all(
			keys.map((key) => env.BLOBS.put(key, new Uint8Array([1])))
		);
		vi.setSystemTime(new Date(realNow + 60_000));

		const passes: ListingPass[] = [];

		for (let index = 0; index < 3; index += 1) {
			const pass: ListingPass = { startAfter: undefined, listed: [] };
			await collectGarbageIn(currentServer(), {
				wrapBlobs: (blobs) => recordingOnePerPage(blobs, pass)
			});
			passes.push(pass);
		}

		const firstPassKeys = keys.slice(0, maxOrphanListPages);

		expect(passes).toStrictEqual([
			{ startAfter: undefined, listed: firstPassKeys },
			{
				startAfter: firstPassKeys.at(-1),
				listed: keys.slice(maxOrphanListPages)
			},
			{ startAfter: undefined, listed: firstPassKeys }
		]);
	});

	it.each([
		{
			name: 'TenantNotConfiguredError',
			issuerError: new TenantNotConfiguredError()
		},
		{
			name: 'PushIdSigningKeyMissingError',
			issuerError: new PushIdSigningKeyMissingError()
		}
	])(
		'finishes the pass without deleting orphans when the issuer fails with $name',
		async ({ issuerError }) => {
			const realNow = await realUploadInstant();
			await initialise();
			const reapedId = uploadIdSchema.parse('reaped-upload');
			const reapedKey = stagingObjectKey(testPushId, reapedId);
			const orphanKeys = [
				stagingObjectKey(
					await testPushIdFor(fixtureTenant, 1),
					uploadIdSchema.parse('untracked')
				),
				stagingObjectKey(
					await testPushIdFor(fixtureTenant, 2),
					uploadIdSchema.parse('untracked')
				)
			];
			await Promise.all(
				[reapedKey, ...orphanKeys].map((key) =>
					env.BLOBS.put(key, new Uint8Array([1, 2, 3]))
				)
			);
			await runInDurableObject(currentServer(), (instance) => {
				instance.context.db
					.insert(schema.pendingUploads)
					.values({
						id: reapedId,
						cacheId: resolvedCache(instance.context).id,
						narHash: syntheticNarHash(1),
						r2Key: reapedKey,
						metadataJson: '{}',
						createdAt: isoTimestampSchema.parse('1970-01-01T00:00:00.000Z'),
						expiresAt: isoTimestampSchema.parse('1970-01-01T00:00:00.000Z')
					})
					.run();
			});
			vi.setSystemTime(new Date(realNow + uploadGraceMs + 5 * 60 * 1000));

			const capture = startCapture();
			let pass: CollectionPass;

			try {
				pass = await collectGarbageIn(currentServer(), { issuerError });
			} finally {
				capture.stop();
			}

			expect({
				outcome: pass.outcome,
				issuerResolutions: pass.issuerResolutions,
				present: await presentKeys([reapedKey, ...orphanKeys]),
				warnings: capture.logs
					.filter((entry) => entry.level === 'warning')
					.map((entry) => ({
						message: entry.message,
						properties: entry.properties
					}))
			}).toStrictEqual({
				outcome: {
					pendingUploadsDeleted: 1,
					pendingAttestationsDeleted: 0,
					rootsExpired: 0,
					pathsCollected: 0,
					hasMoreExpiredRoots: false,
					hasMoreWork: false,
					narInfosDeleted: 0,
					orphanStagingDeleted: 0
				},
				issuerResolutions: 1,
				present: orphanKeys,
				warnings: [
					{
						message: 'orphan staging scan cannot check push ID ownership',
						properties: { job: 'garbage-collection', error: issuerError }
					}
				]
			});
		}
	);
});
