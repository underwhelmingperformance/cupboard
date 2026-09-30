import { rootLogger } from '@cupboard/logger';
import {
	narInfoGenerationSchema,
	predicateTypeSchema,
	type Sha256HexDigest,
	sha256HexDigestSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	lateWriteTombstoneHorizonMs,
	reserveObjectIncarnation
} from '../blob/object-incarnation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { UploadedObjectNotFoundError } from '../errors.ts';
import { blobReaperGraceMs, casObjectKey } from '../http/http.ts';
import { runCasReaperDemote } from '../routing/scheduled.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	attestationReferenceRows,
	authorisedFetch,
	casObjectRows,
	clearBlobStorage,
	commitPath,
	currentCasObjectKey,
	currentServer,
	defaultCache,
	deletePath,
	expectStats,
	fileAttestationReference,
	initialise,
	narInfoGeneration,
	offboardTenant,
	provisionFixtureTenant,
	provisionNamedTenant,
	resetTestServer,
	runCasReaperToCompletion as runCasReaper,
	stageAttestationBundle,
	tenantCasBlobRows,
	tenantUsageRow,
	testServerFor,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

import { AttestationCasService } from './attestation-cas-service.ts';
import { BlobReaperService } from './blob-reaper-service.ts';

const textEncoder = new TextEncoder();
const predicateType = predicateTypeSchema.parse(
	'https://slsa.dev/provenance/v1'
);
const storePathHash = storePathHashSchema.parse('a'.repeat(32));

async function casLifecycleRows(digest: Sha256HexDigest) {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const objects = await database
		.select()
		.from(d1Schema.casObject)
		.where(eq(d1Schema.casObject.digest, digest));
	const registry = await database
		.select()
		.from(d1Schema.objectIncarnation)
		.where(eq(d1Schema.objectIncarnation.objectId, digest));

	return {
		objects: objects.map((row) => ({
			...row,
			deleteAfter: row.deleteAfter ?? undefined
		})),
		registry: registry.map((row) => ({
			...row,
			reservationOwner: row.reservationOwner ?? undefined
		}))
	};
}

describe('attestation CAS lifecycle', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		await resetTestServer();
		await clearBlobStorage();
	});

	it.each(['suspended', 'offboarding', 'missing-usage'])(
		'refuses a CAS charge when %s wins after preflight',
		async (change) => {
			const staging = await stageAttestationBundle(
				'charge-gate-race',
				textEncoder.encode('bundle')
			);
			const measured = await currentServer().measureAttestationBundle(staging);
			await currentServer().promoteAttestationBundle(staging, measured);
			const originalBatch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			const objects = await casObjectRows();
			let expectedUsage = await tenantUsageRow();
			let didChange = false;
			const spy = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockImplementation(async (statements) => {
					if (!didChange && statements.length > 2) {
						didChange = true;
						if (change === 'missing-usage') {
							await env.CUPBOARD_DB.prepare(
								'DELETE FROM tenant_usage WHERE tenant = ?'
							)
								.bind(fixtureTenant)
								.run();
						} else {
							await env.CUPBOARD_DB.prepare(
								'UPDATE tenant SET status = ? WHERE id = ?'
							)
								.bind(change, fixtureTenant)
								.run();
						}
						expectedUsage = await tenantUsageRow();
					}
					return originalBatch(statements);
				});
			try {
				await runInDurableObject(currentServer(), async (instance) => {
					await expect(
						instance.reserveAttestationReference(
							{
								cache: defaultCache(),
								storePathHash,
								generation: narInfoGenerationSchema.parse(0),
								predicateType,
								digest: measured.digest
							},
							measured.size
						)
					).rejects.toThrow(
						change === 'missing-usage'
							? 'has no usage row'
							: 'Writes for this tenant are stopped'
					);
				});
				expect({
					didChange,
					refs: await attestationReferenceRows(),
					presence: await tenantCasBlobRows(),
					objects: await casObjectRows(),
					usage: await tenantUsageRow()
				}).toStrictEqual({
					didChange: true,
					refs: [],
					presence: [],
					objects,
					usage: expectedUsage
				});
			} finally {
				spy.mockRestore();
			}
		}
	);

	it('promotes a measured bundle into the shared CAS', async () => {
		const stagingKey = await stageAttestationBundle(
			'bundle-promote',
			textEncoder.encode('bundle')
		);

		const measured = await currentServer().measureAttestationBundle(stagingKey);
		await currentServer().promoteAttestationBundle(stagingKey, measured);

		expect({
			objects: await casObjectRows(),
			stored:
				(await env.BLOBS.head(await currentCasObjectKey(measured.digest))) !==
				null
		}).toStrictEqual({
			objects: [
				{
					digest: measured.digest,
					size: measured.size,
					deleteAfter: undefined
				}
			],
			stored: true
		});
	});

	it('replaces a legacy CAS row written after the versioned reservation', async () => {
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const stagingKey = await stageAttestationBundle(
			'bundle-deployment-overlap',
			textEncoder.encode('bundle')
		);
		const measured = await currentServer().measureAttestationBundle(stagingKey);
		const reserved = await reserveObjectIncarnation(
			database,
			'cas',
			measured.digest
		);

		await env.BLOBS.put(casObjectKey(measured.digest), measured.bytes);
		await database.insert(d1Schema.casObject).values({
			digest: measured.digest,
			size: measured.size,
			storedAt: isoTimestamp(new Date())
		});
		await currentServer().promoteAttestationBundle(stagingKey, measured);

		const state = await database
			.select({ incarnation: d1Schema.casObject.incarnation })
			.from(d1Schema.casObject)
			.where(eq(d1Schema.casObject.digest, measured.digest))
			.get();

		expect({ reserved, state }).toStrictEqual({
			reserved: { incarnation: 2, state: 'pending' },
			state: { incarnation: 2 }
		});
	});

	it('does not record a CAS object when conditional promotion loses without a winner', async () => {
		const stagingKey = await stageAttestationBundle(
			'bundle-no-winner',
			textEncoder.encode('bundle')
		);
		const measured = await currentServer().measureAttestationBundle(stagingKey);
		const key = casObjectKey(measured.digest, 2);
		const originalHead = env.BLOBS.head.bind(env.BLOBS);
		const originalPut = env.BLOBS.put.bind(env.BLOBS);
		const missingObject = await originalHead(key);
		const isStoredBefore = missingObject !== null;
		const putAttempts: {
			readonly key: string;
			readonly onlyIf: R2Conditional | Headers | undefined;
		}[] = [];
		function putLosingConditional(
			objectKey: string,
			value:
				ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
			options: R2PutOptions & { onlyIf: R2Conditional | Headers }
		): Promise<R2Object | null>;
		function putLosingConditional(
			objectKey: string,
			value:
				ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
			options?: R2PutOptions
		): Promise<R2Object>;
		function putLosingConditional(
			objectKey: string,
			value:
				ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
			options?: R2PutOptions
		): Promise<R2Object | null> {
			putAttempts.push({
				key: objectKey,
				onlyIf: options?.onlyIf
			});

			if (objectKey === key && options?.onlyIf !== undefined) {
				return Promise.resolve(missingObject);
			}

			return originalPut(objectKey, value, options);
		}
		const head = vi.spyOn(env.BLOBS, 'head').mockImplementation((objectKey) => {
			if (objectKey === key) {
				return Promise.resolve(missingObject);
			}

			return originalHead(objectKey);
		});
		const put = vi
			.spyOn(env.BLOBS, 'put')
			.mockImplementation(putLosingConditional);

		try {
			const error = await runInDurableObject(
				currentServer(),
				async (instance): Promise<unknown> => {
					try {
						await instance.promoteAttestationBundle(stagingKey, measured);

						return undefined;
					} catch (error_: unknown) {
						return error_;
					}
				}
			);
			expect(error).toBeInstanceOf(UploadedObjectNotFoundError);
			if (!(error instanceof UploadedObjectNotFoundError)) {
				throw error;
			}

			expect({
				storedBefore: isStoredBefore,
				error: {
					name: error.name,
					r2Key: error.r2Key
				},
				putAttempts,
				objects: await casObjectRows()
			}).toStrictEqual({
				storedBefore: false,
				error: {
					name: UploadedObjectNotFoundError.name,
					r2Key: key
				},
				putAttempts: [{ key, onlyIf: { etagDoesNotMatch: '*' } }],
				objects: []
			});
		} finally {
			head.mockRestore();
			put.mockRestore();
		}
	});

	it('charges one tenant CAS blob per digest without changing NAR stats', async () => {
		const token = await initialise();
		const bundle = await fileAttestationReference({
			uploadId: 'stats-bundle',
			bytes: textEncoder.encode('bundle'),
			storePathHash,
			generation: 0,
			predicateType
		});

		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			narFileSize: 0,
			casObjects: 1,
			casFileSize: bundle.size,
			pendingUploads: 0,
			totalFileSize: bundle.size
		});
		expect(await tenantUsageRow()).toStrictEqual({
			bytes: 0,
			narinfos: 0,
			blobs: 0,
			casBytes: bundle.size,
			casBlobs: 1,
			quotaBytes: undefined
		});
	});

	it('deduplicates shared bundles across tenants while charging each tenant once', async () => {
		await provisionNamedTenant('acme');
		const bytes = textEncoder.encode('shared bundle');
		const first = await fileAttestationReference({
			uploadId: 'shared-fixture',
			bytes,
			storePathHash: storePathHashSchema.parse('b'.repeat(32)),
			generation: 0,
			predicateType
		});
		const second = await fileAttestationReference({
			uploadId: 'shared-acme',
			bytes,
			tenant: 'acme',
			storePathHash: storePathHashSchema.parse('c'.repeat(32)),
			generation: 0,
			predicateType
		});

		expect({
			digests: await casObjectRows(),
			presence: await tenantCasBlobRows()
		}).toStrictEqual({
			digests: [
				{
					digest: first.digest,
					size: first.size,
					deleteAfter: undefined
				}
			],
			presence: [
				{ tenant: 'acme', digest: second.digest, size: second.size },
				{ tenant: fixtureTenant, digest: first.digest, size: first.size }
			]
		});
	});

	it('charges one tenant CAS blob until the last reference is removed', async () => {
		const bytes = textEncoder.encode('one tenant shared');
		const first = await fileAttestationReference({
			uploadId: 'tenant-shared-a',
			bytes,
			storePathHash: storePathHashSchema.parse('d'.repeat(32)),
			generation: 0,
			predicateType
		});
		await fileAttestationReference({
			uploadId: 'tenant-shared-b',
			bytes,
			storePathHash: storePathHashSchema.parse('f'.repeat(32)),
			generation: 0,
			predicateType
		});

		await currentServer().removeAttestationReference({
			cache: defaultCache(),
			storePathHash: storePathHashSchema.parse('d'.repeat(32)),
			generation: narInfoGenerationSchema.parse(0),
			predicateType,
			digest: sha256HexDigestSchema.parse(first.digest)
		});
		const afterFirst = await tenantUsageRow();
		await currentServer().removeAttestationReference({
			cache: defaultCache(),
			storePathHash: storePathHashSchema.parse('f'.repeat(32)),
			generation: narInfoGenerationSchema.parse(0),
			predicateType,
			digest: sha256HexDigestSchema.parse(first.digest)
		});

		expect({
			afterFirst,
			afterSecond: await tenantUsageRow(),
			presence: await tenantCasBlobRows()
		}).toStrictEqual({
			afterFirst: {
				bytes: 0,
				narinfos: 0,
				blobs: 0,
				casBytes: first.size,
				casBlobs: 1,
				quotaBytes: undefined
			},
			afterSecond: {
				bytes: 0,
				narinfos: 0,
				blobs: 0,
				casBytes: 0,
				casBlobs: 0,
				quotaBytes: undefined
			},
			presence: []
		});
	});

	it('rejects an over-quota CAS reference without stranding an edge or charge', async () => {
		await provisionFixtureTenant({ quotaBytes: 1 });
		const bytes = textEncoder.encode('too large');
		const stagingKey = await stageAttestationBundle('over-quota', bytes);
		const measured = await currentServer().measureAttestationBundle(stagingKey);
		await currentServer().promoteAttestationBundle(stagingKey, measured);

		const result = await currentServer().reserveAttestationReference(
			{
				cache: defaultCache(),
				storePathHash,
				generation: narInfoGenerationSchema.parse(0),
				predicateType,
				digest: measured.digest
			},
			measured.size
		);

		expect({
			result,
			refs: await attestationReferenceRows(),
			presence: await tenantCasBlobRows(),
			usage: await tenantUsageRow()
		}).toStrictEqual({
			result: 'over-quota',
			refs: [],
			presence: [],
			usage: {
				bytes: 0,
				narinfos: 0,
				blobs: 0,
				casBytes: 0,
				casBlobs: 0,
				quotaBytes: 1
			}
		});
	});

	it('removes only captured-generation refs when a store path is deleted', async () => {
		const token = await initialise();
		const nar = await verifiableNar('attestation-delete');
		const metadata = uploadMetadata({
			storePathHash,
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await commitPath(token, metadata, nar);
		const firstGeneration = await narInfoGeneration(storePathHash);
		await fileAttestationReference({
			uploadId: 'delete-gen-0',
			bytes: textEncoder.encode('gen0'),
			storePathHash,
			generation: 0,
			predicateType
		});

		const deleted = await deletePath(token, storePathHash);
		await commitPath(token, metadata, nar);
		const secondGeneration = await narInfoGeneration(storePathHash);
		const live = await fileAttestationReference({
			uploadId: 'delete-gen-1',
			bytes: textEncoder.encode('gen1'),
			storePathHash,
			generation: 1,
			predicateType
		});
		await currentServer().removeAttestationReference({
			cache: defaultCache(),
			storePathHash,
			generation: narInfoGenerationSchema.parse(0),
			predicateType,
			digest: sha256HexDigestSchema.parse(live.digest)
		});

		expect({
			generations: [firstGeneration, secondGeneration],
			deleteStatus: StatusCodes[deleted.deleted ? 'OK' : 'NOT_FOUND'],
			refs: await attestationReferenceRows()
		}).toStrictEqual({
			generations: [0, 1],
			deleteStatus: StatusCodes.OK,
			refs: [
				{
					tenant: fixtureTenant,
					cache: defaultCache(),
					storePathHash,
					generation: 1,
					predicateType,
					digest: live.digest
				}
			]
		});
	});

	it('collects an unreferenced CAS object after the reaper grace', async () => {
		const stagingKey = await stageAttestationBundle(
			'unreferenced',
			textEncoder.encode('orphan')
		);
		const measured = await currentServer().measureAttestationBundle(stagingKey);
		await currentServer().promoteAttestationBundle(stagingKey, measured);
		const objectKey = await currentCasObjectKey(measured.digest);

		const armed = await runCasReaper(rootLogger(), env, 10);
		vi.setSystemTime(new Date(Date.now() + blobReaperGraceMs + 1));
		const collected = await runCasReaper(rootLogger(), env, 10);

		expect({
			armed,
			collected,
			rows: await casObjectRows(),
			stored: (await env.BLOBS.head(objectKey)) !== null
		}).toStrictEqual({ armed: 0, collected: 1, rows: [], stored: false });
	});

	it('does not delete a CAS object version promoted after collection commits', async () => {
		const bytes = textEncoder.encode('reaper-promotion-race');
		const first = await fileAttestationReference({
			uploadId: 'reaper-race-first',
			bytes,
			storePathHash,
			generation: 0,
			predicateType
		});
		const firstKey = await currentCasObjectKey(first.digest);
		await currentServer().removeAttestationReference({
			cache: defaultCache(),
			storePathHash,
			generation: narInfoGenerationSchema.parse(0),
			predicateType,
			digest: first.digest
		});
		await runCasReaper(rootLogger(), env, 10);
		vi.setSystemTime(new Date(Date.now() + blobReaperGraceMs + 1));

		let isInterleaved = false;
		const bucket: R2Bucket = {
			head: env.BLOBS.head.bind(env.BLOBS),
			get: env.BLOBS.get.bind(env.BLOBS),
			put: env.BLOBS.put.bind(env.BLOBS),
			async delete(keys) {
				if (
					!isInterleaved &&
					(Array.isArray(keys) ? keys : [keys]).includes(firstKey)
				) {
					isInterleaved = true;
					await fileAttestationReference({
						uploadId: 'reaper-race-second',
						bytes,
						storePathHash: storePathHashSchema.parse('b'.repeat(32)),
						generation: 0,
						predicateType
					});
				}

				return env.BLOBS.delete(keys);
			},
			list: env.BLOBS.list.bind(env.BLOBS),
			createMultipartUpload: env.BLOBS.createMultipartUpload.bind(env.BLOBS),
			resumeMultipartUpload: env.BLOBS.resumeMultipartUpload.bind(env.BLOBS)
		};

		await runCasReaper(rootLogger(), { ...env, BLOBS: bucket }, 10);

		const current = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.select({
				digest: d1Schema.casObject.digest,
				incarnation: d1Schema.casObject.incarnation
			})
			.from(d1Schema.casObject)
			.where(eq(d1Schema.casObject.digest, first.digest))
			.get();

		expect({
			isInterleaved,
			current,
			present:
				current !== undefined &&
				(await env.BLOBS.head(
					casObjectKey(current.digest, current.incarnation)
				)) !== null
		}).toStrictEqual({
			isInterleaved: true,
			current: { digest: first.digest, incarnation: 3 },
			present: true
		});
	});

	it('keeps an armed CAS object when a tenant references it again', async () => {
		const bytes = textEncoder.encode('re-reference');
		const stagingKey = await stageAttestationBundle('re-reference-arm', bytes);
		const measured = await currentServer().measureAttestationBundle(stagingKey);
		await currentServer().promoteAttestationBundle(stagingKey, measured);
		const armed = await runCasReaper(rootLogger(), env, 10);

		await fileAttestationReference({
			uploadId: 're-reference-bind',
			bytes,
			storePathHash,
			generation: 0,
			predicateType
		});
		vi.setSystemTime(new Date(Date.now() + blobReaperGraceMs + 1));

		expect({
			armed,
			collected: await runCasReaper(rootLogger(), env, 10),
			rows: await casObjectRows()
		}).toStrictEqual({
			armed: 0,
			collected: 0,
			rows: [
				{ digest: measured.digest, size: measured.size, deleteAfter: undefined }
			]
		});
	});

	it('demotes a CAS object row when the shared R2 object is missing', async () => {
		const bundle = await fileAttestationReference({
			uploadId: 'missing-object',
			bytes: textEncoder.encode('missing'),
			storePathHash,
			generation: 0,
			predicateType
		});
		await env.BLOBS.delete(await currentCasObjectKey(bundle.digest));

		expect(await runCasReaperDemote(rootLogger(), env, 10)).toBe(1);
		expect({
			objects: await casObjectRows(),
			refs: await attestationReferenceRows(),
			presence: await tenantCasBlobRows(),
			usage: await tenantUsageRow()
		}).toStrictEqual({
			objects: [],
			refs: [],
			presence: [],
			usage: {
				bytes: 0,
				narinfos: 0,
				blobs: 0,
				casBytes: 0,
				casBlobs: 0,
				quotaBytes: undefined
			}
		});
	});

	it.each(['reference-demotion', 'object-retirement'] as const)(
		'fences missing-object repair against stale %s',
		async (phase) => {
			const token = await initialise();
			const nar = await verifiableNar(`missing-repair-${phase}`);
			const metadata = uploadMetadata({
				storePathHash,
				narHash: nar.narHash,
				narSize: nar.narSize,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength
			});
			await commitPath(token, metadata, nar);

			const bytes = textEncoder.encode('repaired bundle');
			const bundle = await fileAttestationReference({
				uploadId: `missing-repair-${phase}`,
				bytes,
				storePathHash,
				generation: 0,
				predicateType
			});
			const staging = bundle.stagingKey;
			const measured = await currentServer().measureAttestationBundle(staging);
			const before = {
				refs: await attestationReferenceRows(),
				presence: await tenantCasBlobRows(),
				usage: await tenantUsageRow()
			};
			await env.BLOBS.delete(await currentCasObjectKey(bundle.digest));

			const demoted = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const cas = new AttestationCasService(instance.context);
					const reaper = new BlobReaperService(
						instance.context.d1,
						env.BLOBS,
						{ demote: () => Promise.resolve() },
						{
							async demote(_tenant, demotions) {
								await cas.promoteMeasuredBundle(staging, measured, {
									restoreMissingObject: true
								});

								if (phase === 'reference-demotion') {
									for (const demotion of demotions) {
										await cas.removeCapturedReference(
											{
												cache: defaultCache(),
												storePathHash,
												generation: narInfoGenerationSchema.parse(0),
												predicateType,
												digest: bundle.digest
											},
											demotion.fenceIncarnation
										);
									}
								}
							}
						},
						instance.context.subrequestsPerInvocation
					);

					return reaper.demoteMissingCasObjects(rootLogger(), 10, {
						read: () => Promise.resolve(''),
						advance: () => Promise.resolve()
					});
				}
			);
			const read = await authorisedFetch(
				`/attestation-bundles/${bundle.digest}`,
				token
			);
			const now = isoTimestamp(new Date());

			expect({
				demoted,
				...(await casLifecycleRows(bundle.digest)),
				refs: await attestationReferenceRows(),
				presence: await tenantCasBlobRows(),
				usage: await tenantUsageRow(),
				read: {
					status: read.status,
					bytes: new Uint8Array(await read.arrayBuffer())
				}
			}).toStrictEqual({
				demoted: 0,
				objects: [
					{
						digest: bundle.digest,
						size: bundle.size,
						incarnation: 3,
						storedAt: now,
						deleteAfter: undefined
					}
				],
				registry: [
					{
						kind: 'cas',
						objectId: bundle.digest,
						incarnation: 3,
						state: 'live',
						reservationOwner: undefined,
						updatedAt: now
					}
				],
				...before,
				read: { status: StatusCodes.OK, bytes }
			});
		}
	);

	it.each(['reservation', 'bytes'] as const)(
		'retries a missing-object repair after losing the %s response',
		async (phase) => {
			const bytes = textEncoder.encode('repair retry');
			const bundle = await fileAttestationReference({
				uploadId: 'repair-retry',
				bytes,
				storePathHash,
				generation: 0,
				predicateType
			});
			const measured = await currentServer().measureAttestationBundle(
				bundle.stagingKey
			);
			const before = {
				refs: await attestationReferenceRows(),
				presence: await tenantCasBlobRows(),
				usage: await tenantUsageRow()
			};
			await env.BLOBS.delete(await currentCasObjectKey(bundle.digest));
			const originalBatch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			const originalPut = env.BLOBS.put.bind(env.BLOBS);
			const failure = new Error('repair response lost');
			const lost =
				phase === 'reservation'
					? vi
							.spyOn(env.CUPBOARD_DB, 'batch')
							.mockImplementationOnce(async (statements) => {
								await originalBatch(statements);
								throw failure;
							})
					: vi
							.spyOn(env.BLOBS, 'put')
							.mockImplementationOnce(async (key, value, options) => {
								await originalPut(key, value, options);
								throw failure;
							});

			try {
				await runInDurableObject(currentServer(), async (instance) => {
					await expect(
						new AttestationCasService(instance.context).promoteMeasuredBundle(
							bundle.stagingKey,
							measured,
							{ restoreMissingObject: true }
						)
					).rejects.toThrow('repair response lost');
				});
			} finally {
				lost.mockRestore();
			}

			await runCasReaperDemote(rootLogger(), env, 10);
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			const now = isoTimestamp(new Date());
			expect({
				...(await casLifecycleRows(bundle.digest)),
				refs: await attestationReferenceRows(),
				presence: await tenantCasBlobRows(),
				usage: await tenantUsageRow()
			}).toStrictEqual({
				objects: [],
				registry: [
					{
						kind: 'cas',
						objectId: bundle.digest,
						incarnation: 3,
						state: 'pending',
						reservationOwner: undefined,
						updatedAt: now
					}
				],
				...before
			});

			await runInDurableObject(currentServer(), (instance) =>
				new AttestationCasService(instance.context).promoteMeasuredBundle(
					bundle.stagingKey,
					measured,
					{ restoreMissingObject: true }
				)
			);
			const stored = await env.BLOBS.get(
				await currentCasObjectKey(bundle.digest)
			);
			const removalDeadline = isoTimestamp(
				new Date(Date.now() + lateWriteTombstoneHorizonMs)
			);
			expect({
				...(await casLifecycleRows(bundle.digest)),
				deletions: await database
					.select()
					.from(d1Schema.objectDeletion)
					.orderBy(d1Schema.objectDeletion.incarnation),
				refs: await attestationReferenceRows(),
				presence: await tenantCasBlobRows(),
				usage: await tenantUsageRow(),
				bytes:
					stored === null
						? undefined
						: new Uint8Array(await stored.arrayBuffer())
			}).toStrictEqual({
				objects: [
					{
						digest: bundle.digest,
						size: bundle.size,
						incarnation: 3,
						storedAt: now,
						deleteAfter: undefined
					}
				],
				registry: [
					{
						kind: 'cas',
						objectId: bundle.digest,
						incarnation: 3,
						state: 'live',
						reservationOwner: undefined,
						updatedAt: now
					}
				],
				deletions: [1, 2].map((incarnation) => ({
					kind: 'cas',
					objectId: bundle.digest,
					incarnation,
					removeAfter: removalDeadline
				})),
				...before,
				bytes
			});
		}
	);

	it('leaves a present CAS object and its references intact when a demote is routed for it', async () => {
		const bundle = await fileAttestationReference({
			uploadId: 'repromoted',
			bytes: textEncoder.encode('repromoted'),
			storePathHash,
			generation: 0,
			predicateType
		});

		const before = {
			objects: await casObjectRows(),
			refs: await attestationReferenceRows(),
			presence: await tenantCasBlobRows(),
			usage: await tenantUsageRow()
		};

		// The object is present by the time the Durable Object handles the stale
		// demotion. The presence check must stop reference deletion and quota credit
		// before the storedAt fence is considered.
		await currentServer().demoteAttestationReferences([
			{
				digest: bundle.digest,
				fenceIncarnation: 0
			}
		]);

		expect({
			objects: await casObjectRows(),
			refs: await attestationReferenceRows(),
			presence: await tenantCasBlobRows(),
			usage: await tenantUsageRow()
		}).toStrictEqual(before);
	});

	it('aborts a demote whose fence is stale, keeping the re-promoted reference and its charge', async () => {
		const bundle = await fileAttestationReference({
			uploadId: 'fence-abort',
			bytes: textEncoder.encode('fence-abort'),
			storePathHash,
			generation: 0,
			predicateType
		});

		const before = {
			objects: await casObjectRows(),
			refs: await attestationReferenceRows(),
			presence: await tenantCasBlobRows(),
			usage: await tenantUsageRow()
		};

		// The reaper observed one object version missing, but a concurrent promotion
		// advanced the shared object before the Durable Object acted. The stale
		// demotion for that version must not remove the newer reference or credit its
		// charge.
		await env.BLOBS.delete(await currentCasObjectKey(bundle.digest));
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		await database.batch([
			database
				.update(d1Schema.casObject)
				.set({ incarnation: 3 })
				.where(eq(d1Schema.casObject.digest, bundle.digest)),
			database
				.update(d1Schema.objectIncarnation)
				.set({ incarnation: 3 })
				.where(eq(d1Schema.objectIncarnation.objectId, bundle.digest))
		]);

		await currentServer().demoteAttestationReferences([
			{
				digest: bundle.digest,
				fenceIncarnation: 2
			}
		]);

		expect({
			objects: await casObjectRows(),
			refs: await attestationReferenceRows(),
			presence: await tenantCasBlobRows(),
			usage: await tenantUsageRow()
		}).toStrictEqual(before);
	});

	it('drains attestation refs and tenant CAS presence during offboarding', async () => {
		await provisionNamedTenant('draining');
		const bundle = await fileAttestationReference({
			uploadId: 'offboard-cas',
			bytes: textEncoder.encode('offboard'),
			tenant: 'draining',
			storePathHash,
			generation: 0,
			predicateType
		});
		await offboardTenant('draining');

		const result = await testServerFor('draining').runOffboard(10);

		expect({
			result,
			refs: await attestationReferenceRows(),
			presence: await tenantCasBlobRows(),
			objects: await casObjectRows()
		}).toStrictEqual({
			result: { drained: true },
			refs: [],
			presence: [],
			objects: [
				{ digest: bundle.digest, size: bundle.size, deleteAfter: undefined }
			]
		});
	});

	it('bounds offboarding attestation ref deletion by selected rows', async () => {
		await provisionNamedTenant('draining');
		await fileAttestationReference({
			uploadId: 'offboard-ref-0',
			bytes: textEncoder.encode('offboard-ref-0'),
			tenant: 'draining',
			storePathHash,
			generation: 0,
			predicateType
		});
		const second = await fileAttestationReference({
			uploadId: 'offboard-ref-1',
			bytes: textEncoder.encode('offboard-ref-1'),
			tenant: 'draining',
			storePathHash,
			generation: 1,
			predicateType
		});
		const third = await fileAttestationReference({
			uploadId: 'offboard-ref-2',
			bytes: textEncoder.encode('offboard-ref-2'),
			tenant: 'draining',
			storePathHash,
			generation: 2,
			predicateType
		});
		await offboardTenant('draining');

		const result = await testServerFor('draining').runOffboard(1);
		const references = await attestationReferenceRows();
		const remainingReferences = references
			.toSorted((left, right) => left.generation - right.generation)
			.map((reference) => ({
				tenant: reference.tenant,
				storePathHash: reference.storePathHash,
				generation: reference.generation,
				digest: reference.digest
			}));

		expect({
			result,
			references: remainingReferences
		}).toStrictEqual({
			result: { drained: false },
			references: [
				{
					tenant: 'draining',
					storePathHash,
					generation: 1,
					digest: second.digest
				},
				{
					tenant: 'draining',
					storePathHash,
					generation: 2,
					digest: third.digest
				}
			]
		});
	});
});
