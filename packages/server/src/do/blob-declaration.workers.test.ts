import { rootLogger } from '@cupboard/logger';
import { type CapturedLog, startCapture } from '@cupboard/logger/testing';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	type CommitBatchEntry,
	type CommitBlobDeclaration,
	type CommitSessionFrame
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq, gte, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import {
	lateWriteTombstoneHorizonMs,
	reserveObjectIncarnation
} from '../blob/object-incarnation.ts';
import { abandonWrittenBlob } from '../blob/promote-blob.ts';
import { r2BadDigestCode } from '../blob/r2-errors.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { pendingUploads } from '../db/schema.ts';
import {
	internalOrigin,
	maxVerificationRpcRows,
	narInfoObjectKey,
	narObjectKey,
	narObjectKeyPrefix,
	verifyClaimBatchSize,
	verifyClaimLeaseMs,
	verifyClaimMaxNarBytes
} from '../http/http.ts';
import { verifyTenant } from '../routing/scheduled.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	clearBlobStorage,
	currentServer,
	currentServerTenant,
	expectSingleUploadDecision,
	initialise,
	negotiateUploads,
	nixSha256Hash,
	openCommitSession,
	pendingUploadVerdict,
	putNarBytes,
	resetTestServer,
	seedCanonicalBlob,
	testBase,
	type VerifiableNar,
	verifiableNar,
	verifiablePath,
	verifyCurrentTenant,
	withoutAlarmArming
} from '../test-support.ts';

import { CacheAdminService } from './cache-admin-service.ts';
import { type VerificationResult } from './verification-service.ts';

interface NegotiatedUpload {
	readonly token: string;
	readonly nar: VerifiableNar;
	readonly entry: CommitBatchEntry;
	readonly r2Key: string;
}

// Negotiates a path for the seed's NAR and stages `staged` as its bytes, which
// are the NAR's own unless the test replaces them.
async function stagedUpload(
	seed: string,
	staged?: VerifiableNar
): Promise<NegotiatedUpload> {
	const token = await initialise();
	const { metadata, nar } = await verifiablePath(seed, {
		storePathHash: 'a'.repeat(32),
		name: seed
	});
	const upload = expectSingleUploadDecision(
		await negotiateUploads(token, [metadata]),
		metadata
	);
	await putNarBytes(upload.r2Key, staged ?? nar);

	return {
		token,
		nar,
		r2Key: upload.r2Key,
		entry: {
			uploadId: upload.uploadId,
			storePathHash: metadata.storePathHash,
			narHash: metadata.narHash
		}
	};
}

function declarationOf(nar: VerifiableNar): CommitBlobDeclaration {
	return { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength };
}

async function commitEntry(
	token: string,
	entry: CommitBatchEntry
): Promise<CommitSessionFrame> {
	const session = await openCommitSession(token);

	try {
		session.send({ op: 'commit-batch', commits: [entry] });

		return await session.nextFrame();
	} finally {
		session.socket.close();
	}
}

// Error frames are compared without their message text.
function frameFacts(frame: CommitSessionFrame): object {
	if (frame.ev !== 'error') {
		return frame;
	}

	return { ev: frame.ev, uploadId: frame.uploadId, status: frame.status };
}

async function storedDeclaration(
	uploadId: CommitBatchEntry['uploadId']
): Promise<{ readonly fileHash?: string; readonly fileSize?: number }> {
	const row = await runInDurableObject(currentServer(), (_instance, state) =>
		drizzle(state.storage, { schema: { pendingUploads } })
			.select({
				fileHash: pendingUploads.declaredFileHash,
				fileSize: pendingUploads.declaredFileSize
			})
			.from(pendingUploads)
			.where(eq(pendingUploads.id, uploadId))
			.get()
	);

	const fileHash = row?.fileHash ?? undefined;
	const fileSize = row?.fileSize ?? undefined;

	return {
		...(fileHash !== undefined && { fileHash }),
		...(fileSize !== undefined && { fileSize })
	};
}

describe('blob declarations on commit', () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(testBase);
		await resetTestServer();
	});

	it('stores the declaration and includes it in the verification claim', async () => {
		const { token, nar, entry, r2Key } = await stagedUpload('declared');
		const blob = declarationOf(nar);

		const frame = await commitEntry(token, { ...entry, blob });
		const claim = await currentServer().claimVerificationBatch(
			maxVerificationRpcRows,
			Number.MAX_SAFE_INTEGER
		);

		expect({
			frame,
			stored: await storedDeclaration(entry.uploadId),
			claims: claim.claims
		}).toStrictEqual({
			frame: {
				ev: 'deferred',
				uploadId: entry.uploadId,
				storePathHash: entry.storePathHash,
				narHash: entry.narHash
			},
			stored: blob,
			claims: [
				{
					uploadId: entry.uploadId,
					storePathHash: entry.storePathHash,
					r2Key,
					narHash: entry.narHash,
					narSize: nar.narSize,
					reuse: false,
					blob
				}
			]
		});
	});

	it('omits the declaration from the claim of an upload committed without one', async () => {
		const { token, nar, entry, r2Key } = await stagedUpload('undeclared');

		await commitEntry(token, entry);
		const claim = await currentServer().claimVerificationBatch(
			maxVerificationRpcRows,
			Number.MAX_SAFE_INTEGER
		);

		expect({
			stored: await storedDeclaration(entry.uploadId),
			claims: claim.claims
		}).toStrictEqual({
			stored: {},
			claims: [
				{
					uploadId: entry.uploadId,
					storePathHash: entry.storePathHash,
					r2Key,
					narHash: entry.narHash,
					narSize: nar.narSize,
					reuse: false
				}
			]
		});
	});

	it('accepts the same declaration again', async () => {
		const { token, nar, entry } = await stagedUpload('redeclared');
		const blob = declarationOf(nar);

		await commitEntry(token, { ...entry, blob });
		const repeated = await commitEntry(token, { ...entry, blob });

		expect({
			repeated,
			stored: await storedDeclaration(entry.uploadId)
		}).toStrictEqual({
			repeated: {
				ev: 'deferred',
				uploadId: entry.uploadId,
				storePathHash: entry.storePathHash,
				narHash: entry.narHash
			},
			stored: blob
		});
	});

	it.each([
		{ field: 'file size', change: { fileSize: 1 } },
		{ field: 'file hash', change: { fileHash: nixSha256Hash('1') } }
	])(
		'refuses a declaration with a different $field and keeps the first',
		async ({ change }) => {
			const { token, nar, entry } = await stagedUpload('conflicting');
			const blob = declarationOf(nar);

			await commitEntry(token, { ...entry, blob });
			const conflicting = await commitEntry(token, {
				...entry,
				blob: { ...blob, ...change }
			});

			expect({
				conflicting: frameFacts(conflicting),
				stored: await storedDeclaration(entry.uploadId)
			}).toStrictEqual({
				conflicting: {
					ev: 'error',
					uploadId: entry.uploadId,
					status: StatusCodes.CONFLICT
				},
				stored: blob
			});
		}
	);
});

interface DeclaredClaim extends NegotiatedUpload {
	readonly owner: string;
}

async function declaredClaim(seed: string): Promise<DeclaredClaim> {
	const upload = await stagedUpload(seed);

	await commitEntry(upload.token, {
		...upload.entry,
		blob: declarationOf(upload.nar)
	});
	const claim = await currentServer().claimVerificationBatch(
		maxVerificationRpcRows,
		Number.MAX_SAFE_INTEGER
	);

	return { ...upload, owner: claim.owner };
}

function controlDatabase() {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

interface RegistryRow {
	readonly incarnation: number;
	readonly state: string;
	readonly reservationOwner?: string;
}

async function registryRows(narHash: string): Promise<RegistryRow[]> {
	const rows = await controlDatabase()
		.select({
			incarnation: d1Schema.objectIncarnation.incarnation,
			state: d1Schema.objectIncarnation.state,
			reservationOwner: d1Schema.objectIncarnation.reservationOwner
		})
		.from(d1Schema.objectIncarnation)
		.where(eq(d1Schema.objectIncarnation.objectId, narHash))
		.all();

	return rows.map(({ reservationOwner, ...row }) => ({
		...row,
		...(reservationOwner !== null && { reservationOwner })
	}));
}

async function blobStateRows(narHash: NixSha256HashString): Promise<unknown[]> {
	return controlDatabase()
		.select({
			fileHash: d1Schema.blobState.fileHash,
			fileSize: d1Schema.blobState.fileSize,
			narSize: d1Schema.blobState.narSize,
			incarnation: d1Schema.blobState.incarnation
		})
		.from(d1Schema.blobState)
		.where(eq(d1Schema.blobState.narHash, narHash))
		.all();
}

// Writes the canonical object the way the queue consumer does after it has
// verified the staged bytes.
async function writeCanonicalObject(
	nar: VerifiableNar,
	incarnation: number
): Promise<void> {
	await env.BLOBS.put(narObjectKey(nar.narHash, incarnation), nar.narBytes, {
		sha256: NixSha256Hash.parse(nar.fileHash).digestBytes(),
		customMetadata: { narSize: String(nar.narSize) }
	});
}

function writtenVerdict(
	claim: DeclaredClaim,
	incarnation: number
): VerificationResult {
	return {
		uploadId: claim.entry.uploadId,
		verdict: {
			kind: 'verified',
			verification: { ok: true },
			canonicalWrite: {
				incarnation,
				bytes: claim.nar.narBytes.byteLength,
				durationMs: 0
			}
		}
	};
}

async function hasRecordedVerdict(
	uploadId: CommitBatchEntry['uploadId']
): Promise<boolean> {
	const row = await runInDurableObject(currentServer(), (_instance, state) =>
		drizzle(state.storage, { schema: { pendingUploads } })
			.select({ recordedVerdictJson: pendingUploads.recordedVerdictJson })
			.from(pendingUploads)
			.where(eq(pendingUploads.id, uploadId))
			.get()
	);

	return row !== undefined && row.recordedVerdictJson !== null;
}

// The deletions queued for versioned incarnations. The first reservation for
// a NAR also queues its unversioned key, which these tests do not examine.
async function deletionRows(narHash: NixSha256HashString): Promise<unknown[]> {
	return controlDatabase()
		.select({
			incarnation: d1Schema.objectDeletion.incarnation,
			removeAfter: d1Schema.objectDeletion.removeAfter
		})
		.from(d1Schema.objectDeletion)
		.where(
			and(
				eq(d1Schema.objectDeletion.objectId, narHash),
				gte(d1Schema.objectDeletion.incarnation, 2)
			)
		)
		.all();
}

function lateWriteDeadline(): string {
	return isoTimestamp(new Date(Date.now() + lateWriteTombstoneHorizonMs));
}

// Moves the upload's claim to a new pass once the current lease has expired,
// and returns the new owner.
async function claimAgain(): Promise<string> {
	vi.setSystemTime(Date.now() + verifyClaimLeaseMs + 1000);
	const claim = await currentServer().claimVerificationBatch(
		maxVerificationRpcRows,
		Number.MAX_SAFE_INTEGER
	);

	return claim.owner;
}

const reservationInsert = 'insert into "object_incarnation"';

// Makes the next incarnation reservation for `narHash` contended. Another
// promoter records the NAR's first incarnation as absent after the
// reservation has looked for an absent row and before its insert runs.
function contendNextReservation(narHash: NixSha256HashString): void {
	const prepare = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
	const batch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
	let isCompeting = false;
	let competing: Promise<unknown> | undefined;

	vi.spyOn(env.CUPBOARD_DB, 'prepare').mockImplementation((query) => {
		if (!isCompeting && query.startsWith(reservationInsert)) {
			isCompeting = true;
			competing = controlDatabase()
				.insert(d1Schema.objectIncarnation)
				.values({
					kind: 'nar',
					objectId: narHash,
					incarnation: 2,
					state: 'absent',
					updatedAt: isoTimestamp(testBase)
				})
				.run();
		}

		return prepare(query);
	});
	vi.spyOn(env.CUPBOARD_DB, 'batch').mockImplementation(async (statements) => {
		await competing;

		return batch(statements);
	});
}

describe('canonical writes during verification', () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(testBase);
		await resetTestServer();
		await clearBlobStorage();
	});

	it('reserves the next incarnation for the claim owner', async () => {
		const { owner, entry } = await declaredClaim('reserved');

		const reservation = await currentServer().reserveCanonicalWrite(
			owner,
			entry.uploadId
		);

		expect({
			reservation,
			registry: await registryRows(entry.narHash)
		}).toStrictEqual({
			reservation: { kind: 'reserved', incarnation: 2 },
			registry: [{ incarnation: 2, state: 'pending', reservationOwner: owner }]
		});
	});

	it.each([
		{
			result: 'existing',
			state: 'a canonical object recorded in blob_state',
			arrange: async (claim: DeclaredClaim) => {
				await seedCanonicalBlob(claim.nar);

				return claim.owner;
			}
		},
		{
			result: 'existing',
			state: 'a live incarnation without a blob_state row',
			arrange: async (claim: DeclaredClaim) => {
				await controlDatabase()
					.insert(d1Schema.objectIncarnation)
					.values({
						kind: 'nar',
						objectId: claim.entry.narHash,
						incarnation: 2,
						state: 'live',
						updatedAt: isoTimestamp(testBase)
					});

				return claim.owner;
			}
		},
		{
			result: 'revoked',
			state: 'a claim that another pass owns',
			arrange: (_claim: DeclaredClaim) => Promise.resolve('another-pass')
		},
		{
			result: 'contended',
			state: 'a registry that changes during the reservation',
			arrange: (claim: DeclaredClaim) => {
				contendNextReservation(claim.entry.narHash);

				return Promise.resolve(claim.owner);
			}
		}
	])(
		'reports $result for $state without reserving',
		async ({ result, state, arrange }) => {
			const claim = await declaredClaim(
				`reservation-${state.replaceAll(/\W+/gu, '-')}`
			);
			const owner = await arrange(claim);

			try {
				const reservation = await currentServer().reserveCanonicalWrite(
					owner,
					claim.entry.uploadId
				);

				const registry = await registryRows(claim.entry.narHash);

				expect({
					reservation,
					reserved: registry.filter((row) => row.state === 'pending')
				}).toStrictEqual({ reservation: { kind: result }, reserved: [] });
			} finally {
				vi.restoreAllMocks();
			}
		}
	);

	it('publishes the object that verification wrote', async () => {
		const claim = await declaredClaim('written');
		const reservation = await currentServer().reserveCanonicalWrite(
			claim.owner,
			claim.entry.uploadId
		);

		if (reservation.kind !== 'reserved') {
			throw new Error('the declared upload must reserve an incarnation');
		}

		await writeCanonicalObject(claim.nar, reservation.incarnation);

		await currentServer().recordVerifications(claim.owner, [
			{
				uploadId: claim.entry.uploadId,
				verdict: {
					kind: 'verified',
					verification: { ok: true },
					canonicalWrite: {
						incarnation: reservation.incarnation,
						bytes: claim.nar.narBytes.byteLength,
						durationMs: 0
					}
				}
			}
		]);
		const narInfo = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, claim.entry.storePathHash, {
				kind: 'default'
			})
		);

		expect({
			verdict: await pendingUploadVerdict(claim.entry.uploadId),
			isNarInfoWritten: narInfo !== null,
			blobState: await blobStateRows(claim.entry.narHash),
			registry: await registryRows(claim.entry.narHash)
		}).toStrictEqual({
			verdict: undefined,
			isNarInfoWritten: true,
			blobState: [
				{
					fileHash: claim.nar.fileHash,
					fileSize: claim.nar.narBytes.byteLength,
					narSize: claim.nar.narSize,
					incarnation: reservation.incarnation
				}
			],
			registry: [{ incarnation: reservation.incarnation, state: 'live' }]
		});
	});

	it('queues no deletion when it gives up an incarnation that is already live', async () => {
		const claim = await declaredClaim('abandon-live');
		const incarnation = await reserveFor(claim);
		await controlDatabase()
			.update(d1Schema.objectIncarnation)
			.set({ state: 'live', reservationOwner: sql`null` })
			.where(eq(d1Schema.objectIncarnation.objectId, claim.entry.narHash));

		await abandonWrittenBlob(
			controlDatabase(),
			claim.entry.narHash,
			incarnation,
			claim.owner
		);

		expect({
			registry: await registryRows(claim.entry.narHash),
			deletions: await deletionRows(claim.entry.narHash)
		}).toStrictEqual({
			registry: [{ incarnation, state: 'live' }],
			deletions: []
		});
	});

	it('leaves the upload for another pass when the written object is missing', async () => {
		const claim = await declaredClaim('written-missing');
		const reservation = await currentServer().reserveCanonicalWrite(
			claim.owner,
			claim.entry.uploadId
		);

		if (reservation.kind !== 'reserved') {
			throw new Error('the declared upload must reserve an incarnation');
		}

		await currentServer().recordVerifications(claim.owner, [
			writtenVerdict(claim, reservation.incarnation)
		]);

		expect({
			verdict: await pendingUploadVerdict(claim.entry.uploadId),
			hasRecordedVerdict: await hasRecordedVerdict(claim.entry.uploadId),
			staged: (await env.BLOBS.head(claim.r2Key)) !== null,
			blobState: await blobStateRows(claim.entry.narHash),
			registry: await registryRows(claim.entry.narHash),
			deletions: await deletionRows(claim.entry.narHash)
		}).toStrictEqual({
			verdict: 'committing',
			hasRecordedVerdict: false,
			staged: true,
			blobState: [],
			registry: [{ incarnation: reservation.incarnation, state: 'absent' }],
			deletions: [
				{
					incarnation: reservation.incarnation,
					removeAfter: lateWriteDeadline()
				}
			]
		});
	});

	it.each([
		{
			change: 'another pass claimed the upload',
			arrange: async () => {
				await claimAgain();
			},
			registry: () => [{ incarnation: 2, state: 'absent' as const }]
		},
		{
			change:
				'another pass claimed the upload and reserved a newer incarnation',
			arrange: async (claim: DeclaredClaim) => {
				const owner = await claimAgain();
				await reserveObjectIncarnation(
					controlDatabase(),
					'nar',
					claim.entry.narHash,
					owner
				);

				return owner;
			},
			registry: (owner?: string) => [
				{ incarnation: 3, state: 'pending' as const, reservationOwner: owner }
			]
		},
		{
			change: 'the incarnation was retired',
			arrange: async (claim: DeclaredClaim) => {
				await controlDatabase()
					.update(d1Schema.objectIncarnation)
					.set({ state: 'absent', reservationOwner: sql`null` })
					.where(eq(d1Schema.objectIncarnation.objectId, claim.entry.narHash));
			},
			registry: () => [{ incarnation: 2, state: 'absent' as const }]
		}
	])(
		'deletes a written incarnation after the late-write horizon when $change',
		async ({ change, arrange, registry }) =>
			withoutAlarmArming(async () => {
				const claim = await declaredClaim(
					`abandoned-${change.replaceAll(/\W+/gu, '-')}`
				);
				const reservation = await currentServer().reserveCanonicalWrite(
					claim.owner,
					claim.entry.uploadId
				);

				if (reservation.kind !== 'reserved') {
					throw new Error('the declared upload must reserve an incarnation');
				}

				await writeCanonicalObject(claim.nar, reservation.incarnation);
				const owner = await arrange(claim);
				const abandonedAt = lateWriteDeadline();
				await currentServer().recordVerifications(claim.owner, [
					writtenVerdict(claim, reservation.incarnation)
				]);
				const narInfo = await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, claim.entry.storePathHash, {
						kind: 'default'
					})
				);

				expect({
					verdict: await pendingUploadVerdict(claim.entry.uploadId),
					isNarInfoWritten: narInfo !== null,
					blobState: await blobStateRows(claim.entry.narHash),
					registry: await registryRows(claim.entry.narHash),
					deletions: await deletionRows(claim.entry.narHash)
				}).toStrictEqual({
					verdict: 'committing',
					isNarInfoWritten: false,
					blobState: [],
					registry: registry(owner ?? undefined),
					deletions: [{ incarnation: 2, removeAfter: abandonedAt }]
				});
			})
	);
});

interface R2Traffic {
	readonly stagedReads: () => number;
	readonly writtenKeys: () => string[];
	readonly restore: () => void;
}

// Records the R2 reads of `stagingKey` and the keys of every put.
function watchR2(stagingKey: string): R2Traffic {
	const get = vi.spyOn(env.BLOBS, 'get');
	const put = vi.spyOn(env.BLOBS, 'put');
	const readKeys: string[] = [];
	const putKeys: string[] = [];

	return {
		stagedReads: () => readKeys.filter((key) => key === stagingKey).length,
		writtenKeys: () => putKeys,
		// Restoring a spy clears its calls, so keep them first.
		restore: () => {
			readKeys.push(...get.mock.calls.map(([key]) => key));
			putKeys.push(...put.mock.calls.map(([key]) => key));
			get.mockRestore();
			put.mockRestore();
		}
	};
}

describe('verifying a declared upload in the queue consumer', () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(testBase);
		await resetTestServer();
	});

	it('reads the staged object once and publishes the object written from it', async () => {
		const upload = await stagedUpload('consumer-written');
		await commitEntry(upload.token, {
			...upload.entry,
			blob: declarationOf(upload.nar)
		});
		const traffic = watchR2(upload.r2Key);

		try {
			await verifyCurrentTenant();
		} finally {
			traffic.restore();
		}

		expect({
			verdict: await pendingUploadVerdict(upload.entry.uploadId),
			stagedReads: traffic.stagedReads(),
			writtenKeys: traffic.writtenKeys(),
			blobState: await blobStateRows(upload.entry.narHash)
		}).toStrictEqual({
			verdict: undefined,
			stagedReads: 1,
			writtenKeys: [
				narObjectKey(upload.entry.narHash, 2),
				expect.stringMatching(/narinfo/u)
			],
			blobState: [
				{
					fileHash: upload.nar.fileHash,
					fileSize: upload.nar.narBytes.byteLength,
					narSize: upload.nar.narSize,
					incarnation: 2
				}
			]
		});
	});

	it.each([
		{
			mismatch: 'NAR',
			arrange: async (seed: string) => {
				const other = await verifiableNar(`${seed}-other`);
				const upload = await stagedUpload(seed, other);

				return { upload, blob: declarationOf(other) };
			}
		},
		{
			mismatch: 'declared file hash',
			arrange: async (seed: string) => {
				const upload = await stagedUpload(seed);

				return {
					upload,
					blob: { ...declarationOf(upload.nar), fileHash: nixSha256Hash('1') }
				};
			}
		},
		{
			mismatch: 'declared file size',
			arrange: async (seed: string) => {
				const upload = await stagedUpload(seed);
				const blob = declarationOf(upload.nar);

				return { upload, blob: { ...blob, fileSize: blob.fileSize + 1 } };
			}
		}
	])(
		'records a mismatch and writes no canonical object when the $mismatch differs',
		async ({ mismatch, arrange }) => {
			const { upload, blob } = await arrange(
				`consumer-${mismatch.replaceAll(' ', '-')}`
			);
			await commitEntry(upload.token, { ...upload.entry, blob });

			await verifyCurrentTenant();
			const listed = await env.BLOBS.list({
				prefix: `${narObjectKeyPrefix}${upload.entry.narHash}`
			});

			expect({
				verdict: await pendingUploadVerdict(upload.entry.uploadId),
				canonicalKeys: listed.objects.map((object) => object.key),
				blobState: await blobStateRows(upload.entry.narHash)
			}).toStrictEqual({
				verdict: 'mismatch',
				canonicalKeys: [],
				blobState: []
			});
		}
	);

	it.each([
		{
			upload: 'committed without a declaration',
			seed: 'copied-undeclared',
			arrange: async (upload: NegotiatedUpload) => {
				await commitEntry(upload.token, upload.entry);
			},
			stagedReads: 2,
			incarnation: 2
		},
		{
			upload:
				'with a wrong declared hash whose NAR already has a canonical object',
			seed: 'copied-existing',
			arrange: async (upload: NegotiatedUpload) => {
				await commitEntry(upload.token, {
					...upload.entry,
					blob: { ...declarationOf(upload.nar), fileHash: nixSha256Hash('1') }
				});
				await seedCanonicalBlob(upload.nar);
			},
			stagedReads: 1,
			incarnation: 1
		},
		{
			upload: 'with a wrong declared hash whose reservation is contended',
			seed: 'copied-contended',
			arrange: async (upload: NegotiatedUpload) => {
				await commitEntry(upload.token, {
					...upload.entry,
					blob: { ...declarationOf(upload.nar), fileHash: nixSha256Hash('1') }
				});
				contendNextReservation(upload.entry.narHash);
			},
			stagedReads: 2,
			incarnation: 3
		}
	])(
		'verifies and copies an upload $upload',
		async ({ seed, arrange, stagedReads, incarnation }) => {
			const upload = await stagedUpload(seed);
			await arrange(upload);
			const traffic = watchR2(upload.r2Key);

			try {
				await verifyCurrentTenant();
			} finally {
				traffic.restore();
				vi.restoreAllMocks();
			}

			expect({
				verdict: await pendingUploadVerdict(upload.entry.uploadId),
				stagedReads: traffic.stagedReads(),
				canonicalWrites: traffic
					.writtenKeys()
					.filter((key) => key.startsWith(narObjectKeyPrefix)),
				blobState: await blobStateRows(upload.entry.narHash)
			}).toStrictEqual({
				verdict: undefined,
				stagedReads,
				canonicalWrites:
					incarnation === 1
						? []
						: [narObjectKey(upload.entry.narHash, incarnation)],
				blobState: [
					{
						fileHash: upload.nar.fileHash,
						fileSize: upload.nar.narBytes.byteLength,
						narSize: upload.nar.narSize,
						incarnation
					}
				]
			});
		}
	);

	it('verifies and copies an upload whose earlier write failed', async () => {
		const upload = await stagedUpload('copied-after-write-failure');

		await withoutAlarmArming(async () => {
			await commitEntry(upload.token, {
				...upload.entry,
				blob: declarationOf(upload.nar)
			});
			const originalPut = env.BLOBS.put.bind(env.BLOBS);
			const failingPut = vi
				.spyOn(env.BLOBS, 'put')
				.mockImplementation((key, value, options) =>
					key.startsWith(narObjectKeyPrefix)
						? Promise.reject(new Error('put: internal error (10001)'))
						: originalPut(key, value, options)
				);

			try {
				await verifyCurrentTenant();
			} finally {
				failingPut.mockRestore();
			}

			const afterFailure = await pendingUploadVerdict(upload.entry.uploadId);
			vi.setSystemTime(Date.now() + 10 * 60 * 1000);
			const traffic = watchR2(upload.r2Key);

			try {
				await verifyCurrentTenant();
			} finally {
				traffic.restore();
			}

			expect({
				afterFailure,
				verdict: await pendingUploadVerdict(upload.entry.uploadId),
				stagedReads: traffic.stagedReads()
			}).toStrictEqual({
				afterFailure: 'committing',
				verdict: undefined,
				stagedReads: 2
			});
		});
	});
});

// Reserves the canonical incarnation for the claim and returns it.
async function reserveFor(claim: DeclaredClaim): Promise<number> {
	const reservation = await currentServer().reserveCanonicalWrite(
		claim.owner,
		claim.entry.uploadId
	);

	if (reservation.kind !== 'reserved') {
		throw new Error('the declared upload must reserve an incarnation');
	}

	return reservation.incarnation;
}

// Records the written verdict while R2 fails the promotion's first read of the
// canonical object, so the verdict stays on the upload row for a later pass.
async function holdWrittenVerdict(
	claim: DeclaredClaim,
	incarnation: number
): Promise<void> {
	const canonicalKey = narObjectKey(claim.entry.narHash, incarnation);
	const originalHead = env.BLOBS.head.bind(env.BLOBS);
	const head = vi
		.spyOn(env.BLOBS, 'head')
		.mockImplementation((key) =>
			key === canonicalKey
				? Promise.reject(new Error('head: internal error (10001)'))
				: originalHead(key)
		);

	try {
		await currentServer().recordVerifications(claim.owner, [
			writtenVerdict(claim, incarnation)
		]);
	} finally {
		head.mockRestore();
	}

	if (!(await hasRecordedVerdict(claim.entry.uploadId))) {
		throw new Error('the written verdict must stay on the upload row');
	}
}

function narMismatchVerdict(claim: DeclaredClaim): VerificationResult {
	return {
		uploadId: claim.entry.uploadId,
		verdict: {
			kind: 'verified',
			verification: {
				ok: false,
				reason: 'nar-hash-mismatch',
				actualNarHash: nixSha256Hash('9')
			}
		}
	};
}

function pathOf(upload: NegotiatedUpload): object {
	return {
		uploadId: upload.entry.uploadId,
		storePathHash: upload.entry.storePathHash,
		narHash: upload.entry.narHash
	};
}

describe('logging each promotion', () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(testBase);
		await resetTestServer();
	});

	it.each([
		{
			promotion: 'a declared upload written during verification',
			seed: 'promotion-fused',
			arrange: async (upload: NegotiatedUpload) => {
				await commitEntry(upload.token, {
					...upload.entry,
					blob: declarationOf(upload.nar)
				});
				await verifyCurrentTenant();
			},
			event: (upload: NegotiatedUpload) => ({
				mode: 'fused',
				outcome: 'servable',
				bytes: upload.nar.narBytes.byteLength,
				durationMs: 0,
				commitToServableMs: 0
			})
		},
		{
			promotion: 'an undeclared upload copied after verification',
			seed: 'promotion-copy',
			arrange: async (upload: NegotiatedUpload) => {
				await commitEntry(upload.token, upload.entry);
				await verifyCurrentTenant();
			},
			event: (upload: NegotiatedUpload) => ({
				mode: 'copy',
				outcome: 'servable',
				bytes: upload.nar.narBytes.byteLength,
				durationMs: 0,
				commitToServableMs: 0
			})
		},
		{
			promotion: 'a write that R2 refuses for its declared hash',
			seed: 'promotion-fused-refused',
			arrange: async (upload: NegotiatedUpload) => {
				await commitEntry(upload.token, {
					...upload.entry,
					blob: { ...declarationOf(upload.nar), fileHash: nixSha256Hash('1') }
				});
				await verifyCurrentTenant();
			},
			event: (upload: NegotiatedUpload) => ({
				mode: 'fused',
				outcome: 'mismatch',
				bytes: upload.nar.narBytes.byteLength,
				durationMs: 0,
				r2ErrorCode: r2BadDigestCode
			})
		},
		{
			promotion: 'a copy that R2 refuses for the verified hash',
			seed: 'promotion-copy-refused',
			arrange: async (upload: NegotiatedUpload) => {
				await commitEntry(upload.token, upload.entry);
				const claim = await currentServer().claimVerificationBatch(
					maxVerificationRpcRows,
					Number.MAX_SAFE_INTEGER
				);
				await currentServer().recordVerifications(claim.owner, [
					{
						uploadId: upload.entry.uploadId,
						verdict: {
							kind: 'verified',
							verification: {
								ok: true,
								fileHash: nixSha256Hash('1'),
								fileSize: upload.nar.narBytes.byteLength
							}
						}
					}
				]);
			},
			event: (upload: NegotiatedUpload) => ({
				mode: 'copy',
				outcome: 'mismatch',
				bytes: upload.nar.narBytes.byteLength,
				durationMs: 0,
				r2ErrorCode: r2BadDigestCode
			})
		}
	])('logs one event for $promotion', async ({ seed, arrange, event }) => {
		const upload = await stagedUpload(seed);
		const capture = startCapture();

		try {
			await arrange(upload);
		} finally {
			capture.stop();
		}

		const events = capture.logs
			.filter((record) => record.message === 'nar promotion finished')
			.map((record) => ({
				level: record.level,
				properties: record.properties
			}));

		expect(events).toStrictEqual([
			{
				level: 'info',
				properties: {
					method: 'record-verifications',
					uploadId: upload.entry.uploadId,
					storePathHash: upload.entry.storePathHash,
					narHash: upload.entry.narHash,
					...event(upload)
				}
			}
		]);
	});

	it('logs a failed write attempt and one event when a copy publishes the upload', async () => {
		const upload = await stagedUpload('promotion-write-failed');
		const failure = new Error(
			'put: We encountered an internal error. Please try again. (10001)'
		);
		const capture = startCapture();

		try {
			await withoutAlarmArming(async () => {
				await commitEntry(upload.token, {
					...upload.entry,
					blob: declarationOf(upload.nar)
				});
				const originalPut = env.BLOBS.put.bind(env.BLOBS);
				const put = vi
					.spyOn(env.BLOBS, 'put')
					.mockImplementation((key, value, options) =>
						key.startsWith(narObjectKeyPrefix)
							? Promise.reject(failure)
							: originalPut(key, value, options)
					);

				try {
					await verifyCurrentTenant();
				} finally {
					put.mockRestore();
				}

				vi.setSystemTime(Date.now() + 10 * 60 * 1000);
				await verifyCurrentTenant();
			});
		} finally {
			capture.stop();
		}

		const path = {
			uploadId: upload.entry.uploadId,
			storePathHash: upload.entry.storePathHash,
			narHash: upload.entry.narHash
		};

		expect({
			attempts: attemptEvents(capture.logs),
			events: promotionEvents(capture.logs),
			verdict: await pendingUploadVerdict(upload.entry.uploadId)
		}).toStrictEqual({
			attempts: [
				{
					level: 'info',
					properties: {
						...path,
						mode: 'fused',
						outcome: 'failed',
						bytes: upload.nar.narBytes.byteLength,
						durationMs: 0,
						r2ErrorCode: 10_001
					}
				}
			],
			events: [
				{
					level: 'info',
					properties: {
						method: 'record-verifications',
						...path,
						mode: 'copy',
						outcome: 'servable',
						bytes: upload.nar.narBytes.byteLength,
						durationMs: 0,
						commitToServableMs: 10 * 60 * 1000
					}
				}
			],
			verdict: undefined
		});
	});

	it('logs a failed copy attempt and one event when a later copy publishes the upload', async () => {
		const upload = await stagedUpload('promotion-copy-retried');
		const capture = startCapture();

		try {
			await withoutAlarmArming(async () => {
				await commitEntry(upload.token, upload.entry);
				const claim = await currentServer().claimVerificationBatch(
					maxVerificationRpcRows,
					Number.MAX_SAFE_INTEGER
				);
				const originalPut = env.BLOBS.put.bind(env.BLOBS);
				const failure = { isPending: true };
				const put = vi
					.spyOn(env.BLOBS, 'put')
					.mockImplementation((key, value, options) => {
						if (!key.startsWith(narObjectKeyPrefix) || !failure.isPending) {
							return originalPut(key, value, options);
						}

						failure.isPending = false;

						return Promise.reject(new Error('put: internal error (10001)'));
					});

				try {
					await currentServer().recordVerifications(claim.owner, [
						{
							uploadId: upload.entry.uploadId,
							verdict: {
								kind: 'verified',
								verification: {
									ok: true,
									fileHash: upload.nar.fileHash,
									fileSize: upload.nar.narBytes.byteLength
								}
							}
						}
					]);
					vi.setSystemTime(Date.now() + 10 * 60 * 1000);
					await currentServer().recordVerifications(claim.owner, []);
				} finally {
					put.mockRestore();
				}
			});
		} finally {
			capture.stop();
		}

		const promotion = {
			method: 'record-verifications',
			uploadId: upload.entry.uploadId,
			storePathHash: upload.entry.storePathHash,
			narHash: upload.entry.narHash,
			mode: 'copy',
			bytes: upload.nar.narBytes.byteLength,
			durationMs: 0
		};

		expect({
			attempts: attemptEvents(capture.logs),
			events: promotionEvents(capture.logs)
		}).toStrictEqual({
			attempts: [
				{
					level: 'info',
					properties: { ...promotion, outcome: 'failed', r2ErrorCode: 10_001 }
				}
			],
			events: [
				{
					level: 'info',
					properties: {
						...promotion,
						outcome: 'servable',
						commitToServableMs: 10 * 60 * 1000
					}
				}
			]
		});
	});

	it('logs a written object once when its promotion is retried', async () =>
		withoutAlarmArming(async () => {
			const claim = await declaredClaim('promotion-retried');
			const reservation = await currentServer().reserveCanonicalWrite(
				claim.owner,
				claim.entry.uploadId
			);

			if (reservation.kind !== 'reserved') {
				throw new Error('the declared upload must reserve an incarnation');
			}

			await writeCanonicalObject(claim.nar, reservation.incarnation);
			const canonicalKey = narObjectKey(
				claim.entry.narHash,
				reservation.incarnation
			);
			const originalHead = env.BLOBS.head.bind(env.BLOBS);
			const failure = { isPending: true };
			const head = vi.spyOn(env.BLOBS, 'head').mockImplementation((key) => {
				if (key !== canonicalKey || !failure.isPending) {
					return originalHead(key);
				}

				failure.isPending = false;

				return Promise.reject(new Error('head: internal error (10001)'));
			});
			const capture = startCapture();

			try {
				await currentServer().recordVerifications(claim.owner, [
					writtenVerdict(claim, reservation.incarnation)
				]);
				head.mockRestore();
				vi.setSystemTime(Date.now() + 10 * 60 * 1000);
				await currentServer().recordVerifications(claim.owner, []);
			} finally {
				head.mockRestore();
				capture.stop();
			}

			expect({
				events: promotionEvents(capture.logs),
				verdict: await pendingUploadVerdict(claim.entry.uploadId)
			}).toStrictEqual({
				events: [
					{
						level: 'info',
						properties: {
							method: 'record-verifications',
							uploadId: claim.entry.uploadId,
							storePathHash: claim.entry.storePathHash,
							narHash: claim.entry.narHash,
							mode: 'fused',
							outcome: 'servable',
							bytes: claim.nar.narBytes.byteLength,
							durationMs: 0,
							commitToServableMs: 10 * 60 * 1000
						}
					}
				],
				verdict: undefined
			});
		}));

	it.each([
		{
			change: 'another pass claimed the upload',
			arrange: async () => {
				await claimAgain();
			},
			isWritten: true
		},
		{
			change: 'the incarnation was retired',
			arrange: async (claim: DeclaredClaim) => {
				await controlDatabase()
					.update(d1Schema.objectIncarnation)
					.set({ state: 'absent', reservationOwner: sql`null` })
					.where(eq(d1Schema.objectIncarnation.objectId, claim.entry.narHash));
			},
			isWritten: true
		},
		{
			change: 'the written object is missing',
			arrange: () => Promise.resolve(),
			isWritten: false
		}
	])(
		'logs no event yet for a written object that is not published when $change',
		async ({ change, arrange, isWritten }) =>
			withoutAlarmArming(async () => {
				const claim = await declaredClaim(
					`unpublished-${change.replaceAll(/\W+/gu, '-')}`
				);
				const reservation = await currentServer().reserveCanonicalWrite(
					claim.owner,
					claim.entry.uploadId
				);

				if (reservation.kind !== 'reserved') {
					throw new Error('the declared upload must reserve an incarnation');
				}

				if (isWritten) {
					await writeCanonicalObject(claim.nar, reservation.incarnation);
				}

				await arrange(claim);
				const capture = startCapture();

				try {
					await currentServer().recordVerifications(claim.owner, [
						writtenVerdict(claim, reservation.incarnation)
					]);
				} finally {
					capture.stop();
				}

				expect({
					events: promotionEvents(capture.logs),
					verdict: await pendingUploadVerdict(claim.entry.uploadId)
				}).toStrictEqual({ events: [], verdict: 'committing' });
			})
	);

	it('logs a write attempt that the pass abandons when its budget ends', async () => {
		const upload = await stagedUpload('promotion-aborted');
		await commitEntry(upload.token, {
			...upload.entry,
			blob: declarationOf(upload.nar)
		});
		const originalPut = env.BLOBS.put.bind(env.BLOBS);
		const put = vi
			.spyOn(env.BLOBS, 'put')
			.mockImplementation((key, value, options) =>
				key.startsWith(narObjectKeyPrefix)
					? Promise.withResolvers<R2Object>().promise
					: originalPut(key, value, options)
			);
		const capture = startCapture();

		try {
			await settle(
				verifyTenant(
					rootLogger(),
					env,
					new NarReadBufferPool(),
					currentServerTenant(),
					verifyClaimBatchSize,
					verifyClaimMaxNarBytes,
					3000
				)
			);
			// The pass rejects as soon as its budget ends. The verification of the
			// upload logs its outcome once it has stopped reading.
			for (
				let attempt = 0;
				attempt < 100 && !hasVerificationFinished(capture.logs);
				attempt += 1
			) {
				await scheduler.wait(10);
			}
		} finally {
			put.mockRestore();
			capture.stop();
		}

		expect({
			attempts: attemptEvents(capture.logs),
			events: promotionEvents(capture.logs)
		}).toStrictEqual({
			attempts: [
				{
					level: 'info',
					properties: {
						uploadId: upload.entry.uploadId,
						storePathHash: upload.entry.storePathHash,
						narHash: upload.entry.narHash,
						mode: 'fused',
						outcome: 'aborted',
						bytes: upload.nar.narBytes.byteLength,
						durationMs: 0
					}
				}
			],
			events: []
		});
	});

	it('logs one event when a verdict arrives again after its upload became terminal', async () => {
		const claim = await declaredClaim('promotion-resent');
		const reservation = await reserveFor(claim);
		const verdict: VerificationResult = {
			uploadId: claim.entry.uploadId,
			verdict: {
				kind: 'verified',
				verification: { ok: false, reason: 'file-hash-mismatch' },
				canonicalWrite: {
					incarnation: reservation,
					bytes: claim.nar.narBytes.byteLength,
					durationMs: 0
				}
			}
		};
		const capture = startCapture();

		try {
			await withoutAlarmArming(async () => {
				await currentServer().recordVerifications(claim.owner, [verdict]);
				await currentServer().recordVerifications(claim.owner, [verdict]);
			});
		} finally {
			capture.stop();
		}

		expect({
			events: promotionEvents(capture.logs),
			verdict: await pendingUploadVerdict(claim.entry.uploadId)
		}).toStrictEqual({
			events: [
				{
					level: 'info',
					properties: {
						method: 'record-verifications',
						...pathOf(claim),
						mode: 'fused',
						outcome: 'mismatch',
						bytes: claim.nar.narBytes.byteLength,
						durationMs: 0,
						r2ErrorCode: r2BadDigestCode
					}
				}
			],
			verdict: 'mismatch'
		});
	});

	it.each([
		{
			write: 'after claim revocation discarded its recorded verdict',
			arrange: async (claim: DeclaredClaim, incarnation: number) => {
				await holdWrittenVerdict(claim, incarnation);
				// A client re-drive revokes the claim and leaves the verdict, which
				// no longer matches the claim owner.
				await runInDurableObject(currentServer(), (_instance, state) =>
					drizzle(state.storage, { schema: { pendingUploads } })
						.update(pendingUploads)
						.set({ claimedAt: sql`null`, claimOwner: sql`null` })
						.where(eq(pendingUploads.id, claim.entry.uploadId))
						.run()
				);
			},
			facts: (claim: DeclaredClaim) => ({
				bytes: claim.nar.narBytes.byteLength,
				durationMs: 0
			})
		},
		{
			write: 'whose consumer stopped before it recorded a verdict',
			arrange: () => Promise.resolve(),
			facts: () => ({})
		}
	])(
		'logs one event and gives up a write $write when the upload then fails verification',
		async ({ write, arrange, facts }) =>
			withoutAlarmArming(async () => {
				const claim = await declaredClaim(
					`orphaned-${write.replaceAll(/\W+/gu, '-')}`
				);
				const incarnation = await reserveFor(claim);
				await writeCanonicalObject(claim.nar, incarnation);
				await arrange(claim, incarnation);
				const owner = await claimAgain();
				const abandonedAt = lateWriteDeadline();
				const capture = startCapture();

				try {
					await currentServer().recordVerifications(owner, [
						narMismatchVerdict(claim)
					]);
				} finally {
					capture.stop();
				}

				expect({
					events: promotionEvents(capture.logs),
					verdict: await pendingUploadVerdict(claim.entry.uploadId),
					registry: await registryRows(claim.entry.narHash),
					deletions: await deletionRows(claim.entry.narHash)
				}).toStrictEqual({
					events: [
						{
							level: 'info',
							properties: {
								method: 'record-verifications',
								...pathOf(claim),
								mode: 'fused',
								outcome: 'mismatch',
								...facts(claim)
							}
						}
					],
					verdict: 'mismatch',
					registry: [{ incarnation, state: 'absent' }],
					deletions: [{ incarnation, removeAfter: abandonedAt }]
				});
			})
	);

	it('logs one event and gives up the write when an upload with a held write runs out of retries', async () =>
		withoutAlarmArming(async () => {
			const claim = await declaredClaim('promotion-exhausted');
			const incarnation = await reserveFor(claim);
			await writeCanonicalObject(claim.nar, incarnation);
			await holdWrittenVerdict(claim, incarnation);
			await runInDurableObject(currentServer(), (_instance, state) =>
				drizzle(state.storage, { schema: { pendingUploads } })
					.update(pendingUploads)
					.set({
						settleExhaustion: 'attempt-limit',
						settleRetryAfter: isoTimestamp(new Date()),
						recordedVerdictJson: sql`null`,
						claimedAt: sql`null`,
						claimOwner: sql`null`
					})
					.where(eq(pendingUploads.id, claim.entry.uploadId))
					.run()
			);
			const abandonedAt = lateWriteDeadline();
			const capture = startCapture();

			try {
				await currentServer().recordVerifications(claim.owner, []);
			} finally {
				capture.stop();
			}

			expect({
				events: promotionEvents(capture.logs),
				verdict: await pendingUploadVerdict(claim.entry.uploadId),
				registry: await registryRows(claim.entry.narHash),
				deletions: await deletionRows(claim.entry.narHash)
			}).toStrictEqual({
				events: [
					{
						level: 'info',
						properties: {
							method: 'record-verifications',
							...pathOf(claim),
							mode: 'fused',
							outcome: 'absent',
							bytes: claim.nar.narBytes.byteLength,
							durationMs: 0
						}
					}
				],
				verdict: undefined,
				registry: [{ incarnation, state: 'absent' }],
				deletions: [{ incarnation, removeAfter: abandonedAt }]
			});
		}));

	it('logs one event and gives up the write when the cache is deleted while a write waits', async () =>
		withoutAlarmArming(async () => {
			const claim = await declaredClaim('promotion-cache-deleted');
			const incarnation = await reserveFor(claim);
			await writeCanonicalObject(claim.nar, incarnation);
			await holdWrittenVerdict(claim, incarnation);
			const abandonedAt = lateWriteDeadline();
			const capture = startCapture();

			try {
				await runInDurableObject(currentServer(), async (instance) => {
					const cacheAdmin: unknown = Reflect.get(instance, 'cacheAdmin');

					if (!(cacheAdmin instanceof CacheAdminService)) {
						throw new TypeError('The test server has no cache admin service.');
					}

					await cacheAdmin.tearDownCache(
						instance.context.cacheRepository.require({ kind: 'default' }),
						internalOrigin
					);
				});
			} finally {
				capture.stop();
			}

			expect({
				events: promotionEvents(capture.logs),
				verdict: await pendingUploadVerdict(claim.entry.uploadId),
				registry: await registryRows(claim.entry.narHash),
				deletions: await deletionRows(claim.entry.narHash)
			}).toStrictEqual({
				events: [
					{
						level: 'info',
						properties: {
							...pathOf(claim),
							mode: 'fused',
							outcome: 'absent',
							bytes: claim.nar.narBytes.byteLength,
							durationMs: 0
						}
					}
				],
				verdict: undefined,
				registry: [{ incarnation, state: 'absent' }],
				deletions: [{ incarnation, removeAfter: abandonedAt }]
			});
		}));
});

function hasVerificationFinished(logs: readonly CapturedLog[]): boolean {
	return logs.some(
		(record) => record.message === 'pending upload verification finished'
	);
}

// Waits for an operation that the test expects to reject.
async function settle(operation: Promise<unknown>): Promise<void> {
	try {
		await operation;
	} catch {
		// The test examines what the operation logged.
	}
}

function eventsNamed(logs: readonly CapturedLog[], message: string): unknown[] {
	return logs
		.filter((record) => record.message === message)
		.map((record) => ({ level: record.level, properties: record.properties }));
}

function promotionEvents(logs: readonly CapturedLog[]): unknown[] {
	return eventsNamed(logs, 'nar promotion finished');
}

function attemptEvents(logs: readonly CapturedLog[]): unknown[] {
	return eventsNamed(logs, 'nar promotion attempt failed');
}
