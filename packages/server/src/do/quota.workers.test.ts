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
	verifiableNarStored
} from '../test-support.ts';

// Two encodings of the same NAR: a real zstd frame (smaller) and a stored frame
// (larger). They share a `narHash` but differ in compressed size, so a commit that
// adopts one as canonical while staging the other charges a different size than it
// staged.
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

// `tenant_usage` is charged once per tenant per unique NAR hash on the 0-to-1
// presence transition and credited symmetrically on the 1-to-0. The charge rides
// the reservation's atomic batch, gated so a replay neither double-charges nor
// double-references, and an over-quota charge fails the table's CHECK so the whole
// reservation rolls back.

describe('per-tenant quota', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(testBase);
		await resetTestServer();

		await clearBlobStorage();
	});

	it('charges bytes and counts once per unique nar hash, narinfos per edge', async () => {
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
		// The second path shares the hash, so it reuses the tenant's own presence edge:
		// a new narinfo edge but no second blob charge.
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

	it('credits the charge back as references are deleted', async () => {
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
		// Removing the first edge credits a narinfo back, but the blob stays charged
		// while the second edge still references it.
		await deletePath(token, first.storePathHash);
		const afterFirst = await tenantUsageRow();
		// Removing the last edge credits the blob's bytes and unique-blob count back.
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

	it('rejects an over-quota commit, charging and referencing nothing', async () => {
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
		// A quota one byte short of this blob.
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

		// The small encoding is already the available canonical blob; the quota fits it
		// but not the larger encoding this commit stages and would adopt it over.
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

		// It commits and charges the adopted canonical size, so the advisory pre-check
		// did not reject on the larger staged size.
		expect(await tenantUsageRow()).toStrictEqual({
			bytes: small.narBytes.byteLength,
			narinfos: 1,
			blobs: 1,
			casBytes: 0,
			casBlobs: 0,
			quotaBytes: small.narBytes.byteLength
		});
	});

	it('rejects cleanly when the canonical size exceeds quota though the staged size fits', async () => {
		const token = await initialise();
		const { small, large } = await divergentEncodings('quota-encoding-over');

		// Only the large canonical object exists, with no `blob_state` row, so the
		// advisory pre-check sees the smaller staged size and passes; the promote then
		// adopts the larger canonical size, which the authoritative check rejects. The
		// quota fits the staged size but not the canonical one.
		await putNarBytes(narObjectKey(large.narHash), large);
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
		// A retry must not hang reporting pending: the over-quota verdict is
		// terminal and its staging reclaimed, so the retry is refused outright
		// rather than stranded re-driving.
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

	it('reclaims an over-quota deferred upload in the verify pass and never makes it servable', async () => {
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

		// Stage the upload and mark it pending, the state a too-large-to-verify-inline
		// upload reaches, then lower the quota below the blob so the background verify
		// pass, not the commit pre-check, is what finds it over quota.
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key, nar);
		await markUploadPendingVerification(upload.uploadId);
		await provisionFixtureTenant({ quotaBytes: nar.narBytes.byteLength - 1 });

		await currentServer().runVerification();
		// A second pass must not restore the reclaimed row's object and make an
		// unreferenced, uncharged path servable.
		await currentServer().runVerification();

		const usage = await tenantUsageRow();
		const object = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
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

		// The terminal over-quota row is reaped once its observation window has passed,
		// the same as a mismatch row, rather than lingering forever.
		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));
		await currentServer().runGarbageCollection();

		expect(await pendingUploadVerdict(upload.uploadId)).toBeUndefined();
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
			(await env.BLOBS.head(narInfoObjectKey(fixtureTenant, storePathHash))) !==
			null
	};
}

// The quota pre-checks read the account outside the gate, so a quota or
// status change can land between the probe and the charge. The charge batch's
// CHECK constraint and the in-gate status re-read are the authorities behind
// the probed decision; these drive that window deliberately through the
// background verify pass, holding the probe's canonical head (its account
// read has already resolved) while the account changes underneath it. Real
// timers: the hold is released through a polled R2 marker, and no waiter
// socket is involved, so nothing retries around the hold.
describe('the probe-to-charge window', () => {
	beforeEach(async () => {
		await resetTestServer();
		await clearBlobStorage();
	});

	const releaseKey = 'test/probe-window-release';

	// Holds the verify pass at the probe's canonical head (the second head of
	// the canonical key: the promote's own comes first) until the release
	// marker object appears. Every promise stays in the Durable Object's own
	// request context; the test signals through R2 state instead.
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

		const held = holdProbeHead(narObjectKey(nar.narHash));
		const pass = currentServer().runVerification();

		await vi.waitFor(() => {
			expect(held.heads()).toBe(2);
		});

		return { nar, metadata, decision, held, pass };
	}

	it('recovers cleanly when the charge loses the quota race', async () => {
		const { nar, metadata, decision, held, pass } = await heldVerify(
			(fits) => fits.narBytes.byteLength
		);

		try {
			// The quota shrinks while the probe is held: its account read already
			// resolved under the old quota, so the pre-checks pass and the charge
			// batch is what discovers the loss. The recovery must read that as
			// genuinely over quota, settling terminally with nothing stranded.
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

	it('stops a commit whose tenant was suspended past the probe', async () => {
		const { metadata, decision, held, pass } = await heldVerify(
			(fits) => fits.narBytes.byteLength * 2
		);

		try {
			// The suspension lands while the probe is held, after its account read
			// resolved active: only the in-gate status re-read stands between it
			// and the charge.
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
