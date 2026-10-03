import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import {
	acceptCapabilitiesHeader,
	uploadGraceFactsCapability,
	uploadNegotiateResponseSchema,
	type UploadPathMetadata,
	type UploadPathNegotiation,
	uploadPreviewResponseSchema,
	uploadRequestMaxPathsHeader
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.ts';
import { negotiateHintsHeader } from '../do/negotiate-hints.ts';
import {
	subrequestsAvailable,
	withSubrequestSlice
} from '../do/subrequest-slice.ts';
import {
	armBlobReaperTimer,
	authorisedFetch,
	blobStateArmTimes,
	commitPath,
	CommitSocketError,
	commitUploadRejection,
	currentNarObjectKey,
	currentServer,
	defaultCache,
	deleteBlobReferenceEdge,
	expectSingleCommitDecision,
	expectSingleUploadDecision,
	flakyD1,
	handlerFetch,
	initialise,
	issueServerSignedToken,
	namedCache,
	narInfoDeletionRows,
	narInfoGeneration,
	resetTestServer,
	seedCanonicalBlob,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation,
	useTestServer,
	verifiableNar,
	verifiablePath,
	withoutAlarmArming
} from '../test-support.ts';

import { directUploadPageSize } from './chunked-uploads.ts';
import { computeNegotiateHints } from './negotiate-hints.ts';
import { fixtureTenant } from './tenant-routing.test-support.ts';

function expectCommitSocketError(
	error: unknown
): asserts error is CommitSocketError {
	expect(error).toBeInstanceOf(CommitSocketError);
}

async function negotiateViaWorker(
	token: string,
	paths: readonly UploadPathMetadata[],
	extraHeaders: Record<string, string> = {}
) {
	const response = await handlerFetch(`/t/${fixtureTenant}/uploads`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
			...extraHeaders
		},
		body: JSON.stringify({
			pushId: testPushId,
			paths: paths.map((path) => uploadPathNegotiation(path))
		})
	});

	expect(response.status).toBe(StatusCodes.OK);

	return uploadNegotiateResponseSchema.parse(await response.json());
}

function actionsByPath(response: {
	uploads: readonly { action: string; storePathHash: string }[];
}): Record<string, string> {
	return Object.fromEntries(
		response.uploads.map((upload) => [upload.storePathHash, upload.action])
	);
}

describe('computing negotiate hints', () => {
	const path = uploadPathNegotiation(uploadMetadata({ fileSize: 1 }));
	let hintToken: string;

	function probeRequest(
		body: unknown,
		headers?: Record<string, string>
	): Request {
		return new Request(`https://cache.example/t/${fixtureTenant}/uploads`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(headers ?? { authorization: `Bearer ${hintToken}` })
			},
			body: typeof body === 'string' ? body : JSON.stringify(body)
		});
	}

	beforeEach(async () => {
		await resetTestServer();
		await useTestServer(fixtureTenant);
		hintToken = await initialise();
	});

	it('computes hints only for a signed push id', async () => {
		const signed = await computeNegotiateHints(
			probeRequest({ pushId: testPushId, paths: [path] }),
			env,
			fixtureTenant,
			defaultCache()
		);
		const forged = await computeNegotiateHints(
			probeRequest({ pushId: 'a'.repeat(96), paths: [path] }),
			env,
			fixtureTenant,
			defaultCache()
		);

		expect({ signed, forged }).toStrictEqual({
			signed: { blobStates: [], ownedNarHashes: [], committedEdges: [] },
			forged: undefined
		});
	});

	it('tolerates the grace-facts capability header', async () => {
		const hints = await computeNegotiateHints(
			probeRequest(
				{ pushId: testPushId, paths: [path] },
				{
					authorization: `Bearer ${hintToken}`,
					[acceptCapabilitiesHeader]: uploadGraceFactsCapability
				}
			),
			env,
			fixtureTenant,
			defaultCache()
		);

		expect(hints).toStrictEqual({
			blobStates: [],
			ownedNarHashes: [],
			committedEdges: []
		});
	});

	it('answers a large direct preview through more than one object request', async () => {
		const token = await issueServerSignedToken(
			authorizationDetailsSchema.parse([
				{
					type: 'cupboard_cache',
					actions: ['upload:preview'],
					cache: defaultCache()
				}
			])
		);
		const paths = Array.from({ length: 401 }, () => path);
		const response = await handlerFetch(`/t/${fixtureTenant}/uploads/preview`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({ paths })
		});

		expect({
			status: response.status,
			body: uploadPreviewResponseSchema.parse(await response.json())
		}).toStrictEqual({
			status: StatusCodes.OK,
			body: {
				uploads: paths.map(() => ({
					action: 'upload',
					storePathHash: path.storePathHash,
					narHash: path.narHash
				}))
			}
		});
	});

	it('splits a direct negotiation before repairing a missing canonical NAR', async () => {
		const token = await initialise();
		const nar = await verifiableNar('chunked-missing-nar');
		const metadata = uploadMetadata({
			name: 'chunked-missing',
			storePathHash: '8'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		await commitPath(token, metadata, nar);
		await env.BLOBS.delete(await currentNarObjectKey(nar.narHash));

		const input = Array.from({ length: 200 }, () => metadata);
		const answer = await negotiateViaWorker(token, input);

		expect({
			decisions: answer.uploads.map(({ action, storePathHash, narHash }) => ({
				action,
				storePathHash,
				narHash
			})),
			uniqueUploadIds: new Set(
				answer.uploads
					.filter((decision) => decision.action === 'upload')
					.map((decision) => decision.uploadId)
			).size
		}).toStrictEqual({
			decisions: input.map(() => ({
				action: 'upload',
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash
			})),
			uniqueUploadIds: 200
		});
	});

	it('rejects a negotiation through the Worker before any pending upload is created', async () => {
		const token = await initialise();
		const before = await runInDurableObject(currentServer(), (instance) =>
			instance.context.db.select().from(schema.pendingUploads).all()
		);
		const inputs = Array.from({ length: 401 }, () => path);
		const response = await withSubrequestSlice(
			() =>
				handlerFetch(`/t/${fixtureTenant}/uploads`, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${token}`,
						'content-type': 'application/json'
					},
					body: JSON.stringify({
						pushId: testPushId,
						paths: inputs
					})
				}),
			{ subrequests: 7, reserve: 0 }
		);
		const pending = await runInDurableObject(currentServer(), (instance) =>
			instance.context.db.select().from(schema.pendingUploads).all()
		);
		expect({
			status: response.status,
			retryAfter: response.headers.get('retry-after') ?? undefined,
			limit: response.headers.get('x-cupboard-upload-max-paths'),
			body: await response.json(),
			pending
		}).toStrictEqual({
			status: 413,
			retryAfter: undefined,
			limit: '201',
			body: {
				defined: true,
				code: 'UPLOAD_REQUEST_LIMIT_EXCEEDED',
				status: 413,
				message:
					"The upload request exceeds this invocation's subrequest budget. Send at most 201 paths per request.",
				data: { maxPaths: 201 }
			},
			pending: before
		});
	});

	it('accepts the advertised page limit after an admission retry', async () => {
		const token = await issueServerSignedToken(
			authorizationDetailsSchema.parse([
				{
					type: 'cupboard_cache',
					actions: ['upload:preview'],
					cache: defaultCache()
				}
			])
		);
		const request = (paths: readonly UploadPathNegotiation[]) => ({
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({ paths })
		});
		const first = await handlerFetch(
			`/t/${fixtureTenant}/uploads/preview`,
			request([path])
		);
		const limit = Number(first.headers.get(uploadRequestMaxPathsHeader));
		expect(limit).toBeGreaterThan(0);
		let batchCalls = 0;
		const retryingDatabase = new Proxy(env.CUPBOARD_DB, {
			get(target, property) {
				if (property === 'batch') {
					return async <T>(
						statements: D1PreparedStatement[]
					): Promise<D1Result<T>[]> => {
						batchCalls += 1;
						if (batchCalls === 1) {
							throw new Error('D1_ERROR: transient admission read');
						}
						return target.batch<T>(statements);
					};
				}
				const value: unknown = Reflect.get(target, property);
				if (typeof value !== 'function') {
					return value;
				}
				return (...arguments_: unknown[]): unknown => {
					const result: unknown = Reflect.apply(value, target, arguments_);
					return result;
				};
			}
		});
		const paths = Array.from({ length: limit }, () => path);
		const next = await handlerFetch(
			`/t/${fixtureTenant}/uploads/preview`,
			request(paths),
			{ CUPBOARD_DB: retryingDatabase }
		);
		expect({
			status: next.status,
			limit: next.headers.get(uploadRequestMaxPathsHeader),
			batchCalls
		}).toStrictEqual({
			status: 200,
			limit: String(limit),
			batchCalls: 2
		});
		expect(uploadPreviewResponseSchema.parse(await next.json())).toStrictEqual({
			uploads: paths.map(() => ({
				action: 'upload',
				storePathHash: path.storePathHash,
				narHash: path.narHash
			}))
		});
	}, 60_000);

	it.each([false, true])(
		'bounds a direct page after canonical NAR loss with duplicate paths=%s',
		async (duplicates) => {
			const token = await initialise();
			await withoutAlarmArming(async () => {
				const inputs: UploadPathMetadata[] = [];
				for (
					let index = 0;
					index < (duplicates ? 1 : directUploadPageSize);
					index += 1
				) {
					const nar = await verifiableNar(`direct-budget-${String(index)}`);
					const metadata = uploadMetadata({
						storePathHash: String(index).padStart(32, '0'),
						narHash: nar.narHash,
						fileHash: nar.fileHash,
						fileSize: nar.narBytes.byteLength,
						narSize: nar.narSize
					});
					await commitPath(token, metadata, nar);
					await env.BLOBS.delete(await currentNarObjectKey(nar.narHash));
					inputs.push(metadata);
				}
				const first = inputs[0];
				if (first === undefined) {
					throw new TypeError('Expected a seeded path');
				}
				const input = duplicates
					? Array.from({ length: directUploadPageSize }, () => first)
					: inputs;
				const negotiatedPaths = input.map((metadata) =>
					uploadPathNegotiation(metadata)
				);
				const measured = await runInDurableObject(currentServer(), (instance) =>
					withSubrequestSlice(
						async () => {
							const before = subrequestsAvailable();
							const response = await instance.fetch(
								new Request('https://cache.example/uploads', {
									method: 'POST',
									headers: {
										authorization: `Bearer ${token}`,
										'content-type': 'application/json'
									},
									body: JSON.stringify({
										pushId: testPushId,
										paths: negotiatedPaths
									})
								})
							);
							const answer = uploadNegotiateResponseSchema.parse(
								await response.json()
							);
							return {
								status: response.status,
								calls: before - subrequestsAvailable(),
								actions: answer.uploads.map((decision) => decision.action)
							};
						},
						{ subrequests: 1000, reserve: 100 }
					)
				);
				expect(measured).toStrictEqual({
					status: 200,
					calls: duplicates ? 7 : 205,
					actions: Array.from({ length: directUploadPageSize }, () => 'upload')
				});
			});
		},
		60_000
	);

	it('returns no hints without a bearer header', async () => {
		const hints = await computeNegotiateHints(
			probeRequest({ pushId: testPushId, paths: [path] }, {}),
			env,
			fixtureTenant,
			defaultCache()
		);

		expect(hints).toBeUndefined();
	});

	it('does not read shared D1 for a valid push ID with junk credentials', async () => {
		const prepare = vi.spyOn(env.CUPBOARD_DB, 'prepare');

		try {
			const hints = await computeNegotiateHints(
				probeRequest(
					{ pushId: testPushId, paths: [path] },
					{ authorization: 'Bearer junk' }
				),
				env,
				fixtureTenant,
				defaultCache()
			);

			expect({ hints, reads: prepare.mock.calls }).toStrictEqual({
				hints: undefined,
				reads: []
			});
		} finally {
			prepare.mockRestore();
		}
	});

	it.each([
		{ actions: ['upload:preview'], cache: defaultCache() },
		{ actions: ['upload:negotiate'], cache: namedCache('other') }
	])(
		'does not read shared D1 for a token with $actions on $cache.kind cache',
		async ({ actions, cache }) => {
			const token = await issueServerSignedToken(
				authorizationDetailsSchema.parse([
					{ type: 'cupboard_cache', actions, cache }
				])
			);
			const prepare = vi.spyOn(env.CUPBOARD_DB, 'prepare');

			try {
				const hints = await computeNegotiateHints(
					probeRequest(
						{ pushId: testPushId, paths: [path] },
						{ authorization: `Bearer ${token}` }
					),
					env,
					fixtureTenant,
					defaultCache()
				);

				expect({ hints, reads: prepare.mock.calls }).toStrictEqual({
					hints: undefined,
					reads: []
				});
			} finally {
				prepare.mockRestore();
			}
		}
	);

	it('returns no hints for an unparseable body', async () => {
		const hints = await computeNegotiateHints(
			probeRequest('{not json'),
			env,
			fixtureTenant,
			defaultCache()
		);

		expect(hints).toBeUndefined();
	});

	it('returns no hints past the path cap', async () => {
		const paths = Array.from({ length: 10_001 }, () => path);
		const hints = await computeNegotiateHints(
			probeRequest({ pushId: testPushId, paths }),
			env,
			fixtureTenant,
			defaultCache()
		);

		expect(hints).toBeUndefined();
	});

	it('returns no hints when the shared-fact reads fail', async () => {
		const faultyEnv = {
			...env,
			CUPBOARD_DB: flakyD1(env.CUPBOARD_DB, {
				failures: Number.MAX_SAFE_INTEGER
			})
		};
		const hints = await computeNegotiateHints(
			probeRequest({ pushId: testPushId, paths: [path] }),
			faultyEnv,
			fixtureTenant,
			defaultCache()
		);

		expect(hints).toBeUndefined();
	});
});

describe('negotiate hints', () => {
	beforeEach(async () => {
		await resetTestServer();
		await useTestServer(fixtureTenant);
	});

	it('returns the ordinary authentication refusal without hint reads', async () => {
		const path = uploadPathNegotiation(uploadMetadata({ fileSize: 1 }));
		const prepare = vi.spyOn(env.CUPBOARD_DB, 'prepare');

		try {
			const response = await handlerFetch(`/t/${fixtureTenant}/uploads`, {
				method: 'POST',
				headers: {
					authorization: 'Bearer junk',
					'content-type': 'application/json'
				},
				body: JSON.stringify({ pushId: testPushId, paths: [path] })
			});

			expect({
				status: response.status,
				hintReads: prepare.mock.calls.filter(
					([query]) =>
						query.includes('"blob_state"') ||
						query.includes('"tenant_blob"') ||
						query.includes('"blob_ref_storage"')
				)
			}).toStrictEqual({ status: StatusCodes.UNAUTHORIZED, hintReads: [] });
		} finally {
			prepare.mockRestore();
		}
	});

	it('decides a mixed closure identically with and without hints', async () => {
		const token = await initialise();
		const committedNar = await verifiableNar('hints-committed');
		const committed = uploadMetadata({
			name: 'committed',
			storePathHash: '1'.repeat(32),
			narHash: committedNar.narHash,
			fileHash: committedNar.fileHash,
			fileSize: committedNar.narBytes.byteLength,
			narSize: committedNar.narSize
		});

		await commitPath(token, committed, committedNar);

		const reuse = uploadMetadata({
			name: 'reuse',
			storePathHash: '2'.repeat(32),
			narHash: committedNar.narHash,
			fileHash: committedNar.fileHash,
			fileSize: committedNar.narBytes.byteLength,
			narSize: committedNar.narSize
		});
		const { metadata: fresh } = await verifiablePath('hints-fresh', {
			storePathHash: '3'.repeat(32),
			name: 'fresh'
		});
		const paths = [committed, reuse, fresh];

		const hinted = await negotiateViaWorker(token, paths);
		const direct = await authorisedFetch('/uploads', token, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				pushId: testPushId,
				paths: paths.map((path) => uploadPathNegotiation(path))
			})
		});

		expect(direct.status).toBe(StatusCodes.OK);

		const directDecisions = uploadNegotiateResponseSchema.parse(
			await direct.json()
		);

		expect({
			hinted: actionsByPath(hinted),
			direct: actionsByPath(directDecisions)
		}).toStrictEqual({
			hinted: {
				[committed.storePathHash]: 'skip',
				[reuse.storePathHash]: 'commit',
				[fresh.storePathHash]: 'upload'
			},
			direct: {
				[committed.storePathHash]: 'skip',
				[reuse.storePathHash]: 'commit',
				[fresh.storePathHash]: 'upload'
			}
		});
	});

	it('keeps a committed path skippable when its NAR was rebuilt', async () => {
		const token = await initialise();
		const nar = await verifiableNar('hints-rebuilt');
		const committed = uploadMetadata({
			name: 'rebuilt',
			storePathHash: '9'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, committed, nar);

		const generation = await narInfoGeneration(committed.storePathHash);

		// The hints cover only the new NAR hash. The Durable Object must still read
		// the old committed hash before deciding whether the path can skip.
		const rebuiltNar = await verifiableNar('hints-rebuilt-other');
		const rebuilt = uploadMetadata({
			name: 'rebuilt',
			storePathHash: committed.storePathHash,
			narHash: rebuiltNar.narHash,
			fileHash: rebuiltNar.fileHash,
			fileSize: rebuiltNar.narBytes.byteLength,
			narSize: rebuiltNar.narSize
		});
		const hinted = await negotiateViaWorker(token, [rebuilt]);
		const queued = await narInfoDeletionRows();

		expect({
			decisions: actionsByPath(hinted),
			generation: await narInfoGeneration(committed.storePathHash),
			queued: queued.filter(
				(row) => row.storePathHash === committed.storePathHash
			)
		}).toStrictEqual({
			decisions: { [committed.storePathHash]: 'skip' },
			generation,
			queued: []
		});
	});

	it('fails a hinted edge check towards not-committed', async () => {
		const token = await initialise();
		const nar = await verifiableNar('hints-edge');
		const committed = uploadMetadata({
			name: 'edge',
			storePathHash: '8'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, committed, nar);

		// Leave a narinfo row without its committed edge.
		const generation = await narInfoGeneration(committed.storePathHash);

		expect(generation).toBeDefined();

		if (generation !== undefined) {
			await deleteBlobReferenceEdge(committed.storePathHash, generation);
		}

		const hinted = await negotiateViaWorker(token, [committed]);

		expect(actionsByPath(hinted)).toStrictEqual({
			[committed.storePathHash]: 'commit'
		});
	});

	it('ignores a client-supplied hint token', async () => {
		const token = await initialise();
		const { metadata } = await verifiablePath('hints-forged-token', {
			storePathHash: '4'.repeat(32),
			name: 'forged'
		});

		const response = await negotiateViaWorker(token, [metadata], {
			[negotiateHintsHeader]: crypto.randomUUID()
		});

		expectSingleUploadDecision(response, metadata);
	});

	it('never lets stale hints publish bytes the tenant does not hold', async () => {
		const token = await initialise();
		const nar = await verifiableNar('hints-unowned');
		const metadata = uploadMetadata({
			name: 'unowned',
			storePathHash: '5'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		// A global blob without this tenant's ownership row must not be reusable.
		await seedCanonicalBlob(nar);

		// Stage stale facts that claim ownership the tenant does not have.
		const staged = await currentServer().stageNegotiateHints({
			blobStates: [
				{
					narHash: nar.narHash,
					fileHash: nar.fileHash,
					fileSize: nar.narBytes.byteLength,
					compression: 'zstd',
					narSize: nar.narSize,
					deleteAfter: new Date(Date.now() + 60_000).toISOString()
				}
			],
			ownedNarHashes: [nar.narHash]
		});
		const hintedResponse = await authorisedFetch('/uploads', token, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				[negotiateHintsHeader]: staged
			},
			body: JSON.stringify({
				pushId: testPushId,
				paths: [uploadPathNegotiation(metadata)]
			})
		});

		expect(hintedResponse.status).toBe(StatusCodes.OK);

		const decision = expectSingleCommitDecision(
			uploadNegotiateResponseSchema.parse(await hintedResponse.json()),
			metadata
		);

		const commitError = await commitUploadRejection(token, decision.uploadId);

		expectCommitSocketError(commitError);
		expect({ status: commitError.status }).toStrictEqual({
			status: StatusCodes.NOT_FOUND
		});

		const replayed = await authorisedFetch('/uploads', token, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				[negotiateHintsHeader]: staged
			},
			body: JSON.stringify({
				pushId: testPushId,
				paths: [uploadPathNegotiation(metadata)]
			})
		});

		expect(replayed.status).toBe(StatusCodes.OK);
		expectSingleUploadDecision(
			uploadNegotiateResponseSchema.parse(await replayed.json()),
			metadata
		);
	});

	it('clears the reaper timer for a hinted reuse before answering', async () => {
		const token = await initialise();
		const nar = await verifiableNar('hints-timer');
		const first = uploadMetadata({
			name: 'first',
			storePathHash: '6'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, first, nar);
		await armBlobReaperTimer(nar.narHash);

		const reuse = uploadMetadata({
			name: 'reuse',
			storePathHash: '7'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const response = await negotiateViaWorker(token, [reuse]);

		expectSingleCommitDecision(response, reuse);

		expect(await blobStateArmTimes()).toStrictEqual([
			{ narHash: nar.narHash, deleteAfter: undefined }
		]);
	});
});
