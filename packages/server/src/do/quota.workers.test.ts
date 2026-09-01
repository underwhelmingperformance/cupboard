import {
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import {
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi
} from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { narInfoObjectKey, narObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	blobReferenceRows,
	clearBlobStorage,
	commitPath,
	commitSharedPath,
	CommitSocketError,
	commitUploadRejection,
	CommitVerdictError,
	currentServer,
	deferFreshUpload,
	deletePath,
	expectSingleUploadDecision,
	fileAttestationReference,
	initialise,
	markUploadPendingVerification,
	negotiateUploads,
	pendingUploadVerdict,
	provisionFixtureTenant,
	putNarBytes,
	resetTestServer,
	seedCanonicalBlob,
	suspendTenant,
	tenantBlobRows,
	tenantUsageRow,
	testBase,
	uploadMetadata,
	type VerifiableNar,
	verifiableNar,
	verifiableNarStored,
	verifyCurrentTenant
} from '../test-support.ts';

// Both encodings decompress to the same NAR and therefore share a narHash. Only
// their compressed sizes differ.
async function divergentEncodings(
	seed: string
): Promise<{ small: VerifiableNar; large: VerifiableNar }> {
	const small = await verifiableNar(seed);
	const large = await verifiableNarStored(seed);

	expect(large.narHash).toBe(small.narHash);
	expect(large.narBytes.byteLength).toBeGreaterThan(small.narBytes.byteLength);

	return { small, large };
}

function expectCommitSocketError(
	error: unknown
): asserts error is CommitSocketError {
	expect(error).toBeInstanceOf(CommitSocketError);
}

function expectCommitVerdictError(
	error: unknown
): asserts error is CommitVerdictError {
	expect(error).toBeInstanceOf(CommitVerdictError);
}

describe('per-tenant quota', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(testBase);
		await resetTestServer();

		await clearBlobStorage();
	});

	it('charges each NAR hash once and counts each narinfo reference', async () => {
		const token = await initialise();
		const nar = await verifiableNar('quota-once');
		const first = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			name: 'first',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const second = uploadMetadata({
			storePathHash: 'b'.repeat(32),
			name: 'second',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await commitPath(token, first, nar);
		await commitSharedPath(token, second);

		expect(await tenantUsageRow()).toStrictEqual({
			bytes: nar.narBytes.byteLength,
			narinfos: 2,
			blobs: 1,
			casBytes: 0,
			casBlobs: 0,
			quotaBytes: undefined
		});
	});

	it('charges each distinct hash', async () => {
		const token = await initialise();
		const one = await verifiableNar('quota-distinct-one');
		const two = await verifiableNar('quota-distinct-two');
		const first = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			name: 'first',
			references: [],
			narHash: one.narHash,
			narSize: one.narSize,
			fileHash: one.fileHash,
			fileSize: one.narBytes.byteLength
		});
		const second = uploadMetadata({
			storePathHash: 'b'.repeat(32),
			name: 'second',
			references: [],
			narHash: two.narHash,
			narSize: two.narSize,
			fileHash: two.fileHash,
			fileSize: two.narBytes.byteLength
		});

		await commitPath(token, first, one);
		await commitPath(token, second, two);

		expect(await tenantUsageRow()).toStrictEqual({
			bytes: one.narBytes.byteLength + two.narBytes.byteLength,
			narinfos: 2,
			blobs: 2,
			casBytes: 0,
			casBlobs: 0,
			quotaBytes: undefined
		});
	});

	it('credits NAR storage only after the last narinfo reference is deleted', async () => {
		const token = await initialise();
		const nar = await verifiableNar('quota-credit');
		const first = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			name: 'first',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const second = uploadMetadata({
			storePathHash: 'b'.repeat(32),
			name: 'second',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await commitPath(token, first, nar);
		await commitSharedPath(token, second);
		await deletePath(token, first.storePathHash);
		const afterFirst = await tenantUsageRow();
		await deletePath(token, second.storePathHash);
		const afterSecond = await tenantUsageRow();

		expect({ afterFirst, afterSecond }).toStrictEqual({
			afterFirst: {
				bytes: nar.narBytes.byteLength,
				narinfos: 1,
				blobs: 1,
				casBytes: 0,
				casBlobs: 0,
				quotaBytes: undefined
			},
			afterSecond: {
				bytes: 0,
				narinfos: 0,
				blobs: 0,
				casBytes: 0,
				casBlobs: 0,
				quotaBytes: undefined
			}
		});
	});

	it('rejects an over-quota commit without recording usage or references', async () => {
		const token = await initialise();
		const nar = await verifiableNar('quota-over');
		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await provisionFixtureTenant({ quotaBytes: nar.narBytes.byteLength - 1 });

		const decision = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(decision.r2Key, nar);
		const commitError = await commitUploadRejection(token, decision.uploadId);

		expectCommitSocketError(commitError);
		expect({
			error: { name: commitError.name, status: commitError.status },
			edges: await blobReferenceRows(),
			presence: await tenantBlobRows(),
			usage: await tenantUsageRow()
		}).toStrictEqual({
			error: {
				name: 'CommitSocketError',
				status: StatusCodes.INSUFFICIENT_STORAGE
			},
			edges: [],
			presence: [],
			usage: {
				bytes: 0,
				narinfos: 0,
				blobs: 0,
				casBytes: 0,
				casBlobs: 0,
				quotaBytes: nar.narBytes.byteLength - 1
			}
		});
	});

	it('rejects a NAR commit when CAS usage has consumed the quota', async () => {
		const token = await initialise();
		const encoder = new TextEncoder();
		const bundle = await fileAttestationReference({
			uploadId: 'quota-cas-consumed',
			bytes: encoder.encode('cas quota use'),
			storePathHash: storePathHashSchema.parse('b'.repeat(32)),
			generation: 0
		});
		const nar = await verifiableNar('quota-mixed-cas-nar');
		const metadata = uploadMetadata({
			storePathHash: 'c'.repeat(32),
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const quotaBytes = bundle.size + nar.narBytes.byteLength - 1;
		await provisionFixtureTenant({ quotaBytes });

		const decision = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(decision.r2Key, nar);
		const commitError = await commitUploadRejection(token, decision.uploadId);

		expectCommitSocketError(commitError);
		expect({
			error: { name: commitError.name, status: commitError.status },
			edges: await blobReferenceRows(),
			presence: await tenantBlobRows(),
			usage: await tenantUsageRow()
		}).toStrictEqual({
			error: {
				name: 'CommitSocketError',
				status: StatusCodes.INSUFFICIENT_STORAGE
			},
			edges: [],
			presence: [],
			usage: {
				bytes: 0,
				narinfos: 0,
				blobs: 0,
				casBytes: bundle.size,
				casBlobs: 1,
				quotaBytes
			}
		});
	});

	it('charges the canonical size, not the larger staged size, when encodings differ', async () => {
		const token = await initialise();
		const { small, large } = await divergentEncodings('quota-encoding-fit');

		await seedCanonicalBlob(small);
		await provisionFixtureTenant({ quotaBytes: small.narBytes.byteLength });

		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			references: [],
			narHash: large.narHash,
			narSize: large.narSize,
			fileHash: large.fileHash,
			fileSize: large.narBytes.byteLength
		});
		await commitPath(token, metadata, large);

		expect(await tenantUsageRow()).toStrictEqual({
			bytes: small.narBytes.byteLength,
			narinfos: 1,
			blobs: 1,
			casBytes: 0,
			casBlobs: 0,
			quotaBytes: small.narBytes.byteLength
		});
	});

	it('rejects the canonical size terminally when the smaller staged size fits the quota', async () => {
		const token = await initialise();
		const { small, large } = await divergentEncodings('quota-encoding-over');

		// Leave `blob_state` absent so the advisory check uses the smaller staged
		// size. Promotion adopts the larger canonical object, whose size exceeds the
		// quota.
		await putNarBytes(narObjectKey(large.narHash, 2), large);
		await provisionFixtureTenant({ quotaBytes: small.narBytes.byteLength });

		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			references: [],
			narHash: small.narHash,
			narSize: small.narSize,
			fileHash: small.fileHash,
			fileSize: small.narBytes.byteLength
		});
		const decision = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(decision.r2Key, small);
		const commitError = await commitUploadRejection(token, decision.uploadId);
		const retryError = await commitUploadRejection(token, decision.uploadId);

		const usage = await tenantUsageRow();

		expectCommitVerdictError(commitError);
		expectCommitSocketError(retryError);
		expect({
			error: { name: commitError.name, verdict: commitError.verdict },
			retryError: { name: retryError.name, status: retryError.status },
			edges: await blobReferenceRows(),
			presence: await tenantBlobRows(),
			bytes: usage?.bytes
		}).toStrictEqual({
			error: { name: 'CommitVerdictError', verdict: 'over-quota' },
			retryError: {
				name: 'CommitSocketError',
				status: StatusCodes.NOT_FOUND
			},
			edges: [],
			presence: [],
			bytes: 0
		});
	});

	it('reclaims an over-quota deferred upload, keeps it unservable, and later reaps the verdict', async () => {
		const token = await initialise();
		const nar = await verifiableNar('quota-deferred');
		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key, nar);
		await markUploadPendingVerification(upload.uploadId);
		await provisionFixtureTenant({ quotaBytes: nar.narBytes.byteLength - 1 });

		await verifyCurrentTenant();
		// Run verification again to prove that the reclaimed reservation cannot
		// republish the narinfo object.
		await verifyCurrentTenant();

		const usage = await tenantUsageRow();
		const object = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
				kind: 'default'
			})
		);

		expect({
			edges: await blobReferenceRows(),
			presence: await tenantBlobRows(),
			bytes: usage?.bytes,
			verdict: await pendingUploadVerdict(upload.uploadId),
			objectPresent: object !== null
		}).toStrictEqual({
			edges: [],
			presence: [],
			bytes: 0,
			verdict: 'over-quota',
			objectPresent: false
		});

		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));
		await currentServer().runGarbageCollection();

		expect(await pendingUploadVerdict(upload.uploadId)).toBeUndefined();
	});

	it('refreshes shared-NAR ownership so two deferred uploads consume one charge', async () => {
		const token = await initialise();
		const nar = await verifiableNar('quota-shared-hash');

		// Both uploads are prefetched before either materialises. After the first
		// charges the shared NAR, the second must refresh its stale ownership fact
		// before treating the upload as over quota.
		const first = await deferFreshUpload(
			token,
			'quota-shared-hash',
			'a'.repeat(32)
		);
		const second = await deferFreshUpload(
			token,
			'quota-shared-hash',
			'b'.repeat(32)
		);

		await provisionFixtureTenant({ quotaBytes: nar.narBytes.byteLength });

		await verifyCurrentTenant();

		const firstServable = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, first.metadata.storePathHash, {
				kind: 'default'
			})
		);
		const secondServable = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, second.metadata.storePathHash, {
				kind: 'default'
			})
		);

		expect({
			firstServable: firstServable !== null,
			secondServable: secondServable !== null,
			usage: await tenantUsageRow()
		}).toStrictEqual({
			firstServable: true,
			secondServable: true,
			usage: {
				bytes: nar.narBytes.byteLength,
				narinfos: 2,
				blobs: 1,
				casBytes: 0,
				casBlobs: 0,
				quotaBytes: nar.narBytes.byteLength
			}
		});
	});
});

async function probeWindowState(storePathHash: StorePathHash): Promise<{
	edges: unknown[];
	presence: unknown[];
	bytes: number | undefined;
	servable: boolean;
}> {
	const usage = await tenantUsageRow();

	return {
		edges: await blobReferenceRows(),
		presence: await tenantBlobRows(),
		bytes: usage?.bytes,
		servable:
			(await env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, storePathHash, { kind: 'default' })
			)) !== null
	};
}

// Status and quota are read before the gate, but the charge batch rechecks
// both. These tests pause after the advisory read and mutate the tenant row.
describe('the probe-to-charge window', () => {
	beforeEach(async () => {
		await resetTestServer();
		await clearBlobStorage();
	});

	const releaseKey = 'test/probe-window-release';

	// Promotion performs the first canonical head, so pause on the second head
	// during materialisation. An R2 marker coordinates the requests without
	// moving a promise outside the Durable Object request context.
	function holdProbeHead(canonicalKey: string): {
		spy: MockInstance;
		heads: () => number;
	} {
		const originalHead = env.BLOBS.head.bind(env.BLOBS);
		let heads = 0;
		const spy = vi
			.spyOn(env.BLOBS, 'head')
			.mockImplementation(async (key: string) => {
				if (key === canonicalKey) {
					heads += 1;

					if (heads === 2) {
						for (let poll = 0; poll < 400; poll += 1) {
							if ((await originalHead(releaseKey)) !== null) {
								break;
							}

							await new Promise((resolve) => setTimeout(resolve, 25));
						}
					}
				}

				return originalHead(key);
			});

		return { spy, heads: () => heads };
	}

	async function heldVerify(quotaOf: (nar: VerifiableNar) => number) {
		const token = await initialise();
		const nar = await verifiableNar('probe-window');
		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await provisionFixtureTenant({ quotaBytes: quotaOf(nar) });

		const decision = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		await putNarBytes(decision.r2Key, nar);
		await markUploadPendingVerification(decision.uploadId);

		const held = holdProbeHead(narObjectKey(nar.narHash, 2));
		const pass = verifyCurrentTenant();

		await vi.waitFor(() => {
			expect(held.heads()).toBe(2);
		});

		return { nar, metadata, decision, held, pass };
	}

	it('rejects a charge after quota shrinks between the pre-check and charge', async () => {
		const { nar, metadata, decision, held, pass } = await heldVerify(
			(fits) => fits.narBytes.byteLength
		);

		try {
			// The advisory read has already observed the old quota. The charge batch
			// must detect the lower value and record an over-quota result.
			await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
				.update(d1Schema.tenantUsage)
				.set({ quotaBytes: nar.narBytes.byteLength - 1 })
				.where(eq(d1Schema.tenantUsage.tenant, fixtureTenant))
				.run();
			await env.BLOBS.put(releaseKey, 'go');
			await pass;

			expect({
				verdict: await pendingUploadVerdict(decision.uploadId),
				...(await probeWindowState(metadata.storePathHash))
			}).toStrictEqual({
				verdict: 'over-quota',
				edges: [],
				presence: [],
				bytes: 0,
				servable: false
			});
		} finally {
			held.spy.mockRestore();
		}
	});

	it('rejects a commit after the tenant is suspended between the pre-check and charge', async () => {
		const { metadata, decision, held, pass } = await heldVerify(
			(fits) => fits.narBytes.byteLength * 2
		);

		try {
			// The advisory read has already observed an active tenant. The charge
			// batch must reject the newly suspended tenant.
			await suspendTenant(fixtureTenant);
			await env.BLOBS.put(releaseKey, 'go');
			await pass;

			expect({
				verdict: await pendingUploadVerdict(decision.uploadId),
				...(await probeWindowState(metadata.storePathHash))
			}).toStrictEqual({
				verdict: undefined,
				edges: [],
				presence: [],
				bytes: 0,
				servable: false
			});
		} finally {
			held.spy.mockRestore();
		}
	});
});
