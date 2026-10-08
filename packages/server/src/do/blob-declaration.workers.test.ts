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

import {
	lateWriteTombstoneHorizonMs,
	reserveObjectIncarnation
} from '../blob/object-incarnation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { pendingUploads } from '../db/schema.ts';
import {
	maxVerificationRpcRows,
	narInfoObjectKey,
	narObjectKey,
	narObjectKeyPrefix,
	verifyClaimLeaseMs
} from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	clearBlobStorage,
	currentServer,
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
			canonicalWrite: { incarnation }
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
					canonicalWrite: { incarnation: reservation.incarnation }
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
		async ({ change, arrange, registry }) => {
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
		}
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
