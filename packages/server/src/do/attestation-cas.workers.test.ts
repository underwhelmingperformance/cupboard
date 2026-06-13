import {
	type PredicateType,
	type Sha256HexDigest
} from '@cupboard/nix/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { UploadedObjectNotFoundError } from '../errors.ts';
import { blobReaperGraceMs, casObjectKey } from '../http/http.ts';
import { runCasReaper, runCasReaperDemote } from '../routing/scheduled.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	attestationReferenceRows,
	casObjectRows,
	clearBlobStorage,
	commitPath,
	currentServer,
	deletePath,
	expectStats,
	fileAttestationReference,
	initialise,
	narInfoGeneration,
	offboardTenant,
	provisionFixtureTenant,
	provisionNamedTenant,
	resetTestServer,
	stageAttestationBundle,
	tenantCasBlobRows,
	tenantUsageRow,
	testServerFor,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

const predicateType = 'https://slsa.dev/provenance/v1' as PredicateType;
const storePathHash = 'a'.repeat(32);

describe('attestation CAS lifecycle', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		await resetTestServer();
		await clearBlobStorage();
	});

	it('promotes a measured bundle into the shared CAS', async () => {
		const stagingKey = await stageAttestationBundle(
			'bundle-promote',
			new TextEncoder().encode('bundle')
		);

		const measured = await currentServer().measureAttestationBundle(stagingKey);
		await currentServer().promoteAttestationBundle(stagingKey, measured);

		expect({
			objects: await casObjectRows(),
			stored: (await env.BLOBS.head(casObjectKey(measured.digest))) !== null
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

	it('does not record a CAS fact when conditional promotion loses without a winner', async () => {
		const stagingKey = await stageAttestationBundle(
			'bundle-no-winner',
			new TextEncoder().encode('bundle')
		);
		const measured = await currentServer().measureAttestationBundle(stagingKey);
		const key = casObjectKey(measured.digest);
		const originalHead = env.BLOBS.head.bind(env.BLOBS);
		const missingObject = JSON.parse('null') as R2Object | null;
		const head = vi.spyOn(env.BLOBS, 'head').mockImplementation((objectKey) => {
			if (objectKey === key) {
				return Promise.resolve(missingObject);
			}

			return originalHead(objectKey);
		});
		const put = vi.spyOn(env.BLOBS, 'put').mockImplementation(((
			objectKey: string
		) => {
			if (objectKey === key) {
				return Promise.resolve(missingObject as unknown as R2Object);
			}

			throw new Error(`unexpected put: ${objectKey}`);
		}) as typeof env.BLOBS.put);

		try {
			const error = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const service = instance as unknown as {
						readonly attestationCas: {
							promoteMeasuredBundle(
								key: string,
								bundle: typeof measured
							): Promise<void>;
						};
					};

					return service.attestationCas
						.promoteMeasuredBundle(stagingKey, measured)
						.catch((error_: unknown) => error_);
				}
			);

			expect(error).toMatchObject({
				name: UploadedObjectNotFoundError.name
			});
		} finally {
			head.mockRestore();
			put.mockRestore();
		}

		expect(await casObjectRows()).toStrictEqual([]);
	});

	it('charges one tenant CAS blob per digest without changing NAR stats', async () => {
		const token = await initialise();
		const bundle = await fileAttestationReference({
			uploadId: 'stats-bundle',
			bytes: new TextEncoder().encode('bundle'),
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
		const bytes = new TextEncoder().encode('shared bundle');
		const first = await fileAttestationReference({
			uploadId: 'shared-fixture',
			bytes,
			storePathHash: 'b'.repeat(32),
			generation: 0,
			predicateType
		});
		const second = await fileAttestationReference({
			uploadId: 'shared-acme',
			bytes,
			tenant: 'acme',
			storePathHash: 'c'.repeat(32),
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
		const bytes = new TextEncoder().encode('one tenant shared');
		const first = await fileAttestationReference({
			uploadId: 'tenant-shared-a',
			bytes,
			storePathHash: 'd'.repeat(32),
			generation: 0,
			predicateType
		});
		await fileAttestationReference({
			uploadId: 'tenant-shared-b',
			bytes,
			storePathHash: 'e'.repeat(32),
			generation: 0,
			predicateType
		});

		await currentServer().removeAttestationReference({
			cache: '',
			storePathHash: 'd'.repeat(32),
			generation: 0,
			predicateType,
			digest: first.digest as Sha256HexDigest
		});
		const afterFirst = await tenantUsageRow();
		await currentServer().removeAttestationReference({
			cache: '',
			storePathHash: 'e'.repeat(32),
			generation: 0,
			predicateType,
			digest: first.digest as Sha256HexDigest
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
		const bytes = new TextEncoder().encode('too large');
		const stagingKey = await stageAttestationBundle('over-quota', bytes);
		const measured = await currentServer().measureAttestationBundle(stagingKey);
		await currentServer().promoteAttestationBundle(stagingKey, measured);

		const result = await currentServer().reserveAttestationReference(
			{
				cache: '',
				storePathHash,
				generation: 0,
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
		if (firstGeneration === undefined) {
			throw new Error('expected first committed generation');
		}
		expect(firstGeneration).toBe(0);
		await fileAttestationReference({
			uploadId: 'delete-gen-0',
			bytes: new TextEncoder().encode('gen0'),
			storePathHash,
			generation: firstGeneration,
			predicateType
		});

		const deleted = await deletePath(token, storePathHash);
		await commitPath(token, metadata, nar);
		const secondGeneration = await narInfoGeneration(storePathHash);
		if (secondGeneration === undefined) {
			throw new Error('expected second committed generation');
		}
		expect(secondGeneration).toBe(1);
		const live = await fileAttestationReference({
			uploadId: 'delete-gen-1',
			bytes: new TextEncoder().encode('gen1'),
			storePathHash,
			generation: secondGeneration,
			predicateType
		});
		await currentServer().removeAttestationReference({
			cache: '',
			storePathHash,
			generation: 0,
			predicateType,
			digest: live.digest as Sha256HexDigest
		});

		expect({
			deleteStatus: deleted.deleted ? StatusCodes.OK : StatusCodes.NOT_FOUND,
			refs: await attestationReferenceRows()
		}).toStrictEqual({
			deleteStatus: StatusCodes.OK,
			refs: [
				{
					tenant: fixtureTenant,
					cache: '',
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
			new TextEncoder().encode('orphan')
		);
		const measured = await currentServer().measureAttestationBundle(stagingKey);
		await currentServer().promoteAttestationBundle(stagingKey, measured);

		expect(await runCasReaper(env, 10)).toBe(0);
		vi.setSystemTime(new Date(Date.now() + blobReaperGraceMs + 1));
		expect(await runCasReaper(env, 10)).toBe(1);

		expect({
			rows: await casObjectRows(),
			stored: (await env.BLOBS.head(casObjectKey(measured.digest))) !== null
		}).toStrictEqual({ rows: [], stored: false });
	});

	it('keeps an armed CAS object when a tenant references it again', async () => {
		const bytes = new TextEncoder().encode('re-reference');
		const stagingKey = await stageAttestationBundle('re-reference-arm', bytes);
		const measured = await currentServer().measureAttestationBundle(stagingKey);
		await currentServer().promoteAttestationBundle(stagingKey, measured);
		expect(await runCasReaper(env, 10)).toBe(0);

		await fileAttestationReference({
			uploadId: 're-reference-bind',
			bytes,
			storePathHash,
			generation: 0,
			predicateType
		});
		vi.setSystemTime(new Date(Date.now() + blobReaperGraceMs + 1));

		expect(await runCasReaper(env, 10)).toBe(0);
		expect(await casObjectRows()).toStrictEqual([
			{ digest: measured.digest, size: measured.size, deleteAfter: undefined }
		]);
	});

	it('demotes a CAS object fact when the shared R2 object is missing', async () => {
		const bundle = await fileAttestationReference({
			uploadId: 'missing-object',
			bytes: new TextEncoder().encode('missing'),
			storePathHash,
			generation: 0,
			predicateType
		});
		await env.BLOBS.delete(casObjectKey(bundle.digest));

		expect(await runCasReaperDemote(env, 10)).toBe(1);
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

	it('leaves a present CAS object and its references intact when a demote is routed for it', async () => {
		const bundle = await fileAttestationReference({
			uploadId: 'repromoted',
			bytes: new TextEncoder().encode('repromoted'),
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

		// The reaper routes a demote for this digest, but the shared object is present
		// in the Durable Object: a concurrent re-promote restored it, or the reaper's
		// head was stale. Stripping the references and crediting quota would corrupt a
		// live object's accounting, so the demote re-checks and is a no-op. The stale
		// fence value is never consulted because the presence check short-circuits.
		await currentServer().demoteAttestationReferences(
			bundle.digest,
			'2000-01-01T00:00:00.000Z'
		);

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
			bytes: new TextEncoder().encode('fence-abort'),
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

		// The reaper observed the object gone at one storedAt, but a concurrent
		// re-promote rewrote the object and bumped cas_object.storedAt by the time the
		// Durable Object acts. The object is absent again here, so the re-head guard
		// passes and the per-reference storedAt fence is what must abort: a row carrying
		// a different storedAt means the reference is live and must not be stripped, nor
		// its charge credited away.
		await env.BLOBS.delete(casObjectKey(bundle.digest));
		await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.update(d1Schema.casObject)
			.set({ storedAt: '2099-01-01T00:00:00.000Z' })
			.where(eq(d1Schema.casObject.digest, bundle.digest))
			.run();

		await currentServer().demoteAttestationReferences(
			bundle.digest,
			'2000-01-01T00:00:00.000Z'
		);

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
			bytes: new TextEncoder().encode('offboard'),
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
			bytes: new TextEncoder().encode('offboard-ref-0'),
			tenant: 'draining',
			storePathHash,
			generation: 0,
			predicateType
		});
		const second = await fileAttestationReference({
			uploadId: 'offboard-ref-1',
			bytes: new TextEncoder().encode('offboard-ref-1'),
			tenant: 'draining',
			storePathHash,
			generation: 1,
			predicateType
		});
		const third = await fileAttestationReference({
			uploadId: 'offboard-ref-2',
			bytes: new TextEncoder().encode('offboard-ref-2'),
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
