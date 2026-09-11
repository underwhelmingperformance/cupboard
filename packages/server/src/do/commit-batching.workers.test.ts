import { rootLogger } from '@cupboard/logger';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	uploadCommitDecisionSchema,
	uploadNegotiateResponseSchema
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narInfos } from '../db/schema.ts';
import { d1StatementsPerInvocation } from '../http/http.ts';
import {
	authorisedFetch,
	commitPath,
	commitUpload,
	countingD1,
	currentServer,
	defaultCache,
	drivenDirectly,
	expectSingleCommitDecision,
	initialise,
	negotiateUploads,
	openCommitSession,
	provisionFixtureTenant,
	resetTestServer,
	resolvedCache,
	syntheticStorePathHash,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation,
	useTestServer,
	verifiableNar
} from '../test-support.ts';

import { boundedD1 } from './bounded-io.ts';
import { CommitPipelineService } from './commit-pipeline-service.ts';
import { type ServerContext } from './context.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { RetentionService } from './retention-service.ts';
import { SigningKeysService } from './signing-keys-service.ts';
import { withStatementAllowance } from './statement-scope.ts';
import { UploadStateService } from './upload-state-service.ts';

function pipelineFor(context: ServerContext): CommitPipelineService {
	const narInfoObjects = new NarInfoObjectsService(context);

	return new CommitPipelineService(
		context,
		new SigningKeysService(context, narInfoObjects),
		new UploadStateService(context),
		narInfoObjects,
		new RetentionService(context)
	);
}

// `materialiseBatched` shares a flush among the requests already enqueued when
// its gate callback begins. A burst can therefore settle several paths in one
// critical section and one combined charge batch.
describe('commit batching', () => {
	beforeEach(resetTestServer);

	it('settles a synchronous burst in one combined charge batch', async () => {
		const token = await initialise();
		const nar = await verifiableNar('commit-batching');
		const paths = ['a', 'b', 'c', 'd', 'f', 'g'].map((letter, index) =>
			uploadMetadata({
				name: `batched-${String(index)}`,
				storePathHash: letter.repeat(32),
				narHash: nar.narHash,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength,
				narSize: nar.narSize
			})
		);

		const [uploadPath, ...reusePaths] = paths;

		if (uploadPath === undefined) {
			throw new Error('the burst needs at least one path');
		}

		await commitPath(token, uploadPath, nar);

		for (const metadata of reusePaths) {
			const decision = expectSingleCommitDecision(
				await negotiateUploads(token, [metadata]),
				metadata
			);
			await commitUpload(token, decision.uploadId);
		}

		// Replaying a committed row at its current generation is idempotent because
		// the conditional charge statements become no-ops. The test can therefore
		// exercise the shared flush with a known generation for every path.
		const batches = vi.spyOn(env.CUPBOARD_DB, 'batch');

		try {
			const outcomes = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const pipeline = drivenDirectly(pipelineFor(instance.context));
					const cache = resolvedCache(instance.context);
					const [head, ...rest] = paths;

					if (head === undefined) {
						throw new Error('the burst needs at least one path');
					}

					const probe = await pipeline.probeMaterialisation(head);
					// The probe performs its own D1 batch. Clear that call so the assertion
					// counts only the charge batch from the shared flush.
					batches.mockClear();
					const rows = instance.context.db
						.select({
							storePathHash: schema.narInfos.storePathHash,
							generation: schema.narInfos.generation
						})
						.from(schema.narInfos)
						.all();
					const generations = new Map(
						rows.map((row) => [row.storePathHash, row.generation])
					);

					// Enqueue every request in the same turn so the first gate callback can
					// take the whole burst.
					return Promise.all(
						[head, ...rest].map((metadata) => {
							const generation = generations.get(metadata.storePathHash);

							if (generation === undefined) {
								throw new Error('the committed path has no narinfo row');
							}

							return pipeline.materialiseBatched(rootLogger(), {
								cache,
								metadata,
								generation,
								probe,
								mustOwnBlob: true,
								graceDecision: undefined,
								attachRootName: undefined
							});
						})
					);
				}
			);

			expect({
				kinds: outcomes.map((outcome) => outcome.kind),
				chargeBatches: batches.mock.calls.length
			}).toStrictEqual({
				kinds: paths.map(() => 'materialised'),
				chargeBatches: 1
			});
		} finally {
			batches.mockRestore();
		}
	});

	it('reads a set of probe facts in two concurrent batches, then probes from memory', async () => {
		const token = await initialise();

		const paths = await Promise.all(
			['a', 'b', 'c'].map(async (letter, index) => {
				const nar = await verifiableNar(`prefetch-${letter}`);
				const metadata = uploadMetadata({
					name: `prefetch-${String(index)}`,
					storePathHash: letter.repeat(32),
					narHash: nar.narHash,
					fileHash: nar.fileHash,
					fileSize: nar.narBytes.byteLength,
					narSize: nar.narSize
				});
				await commitPath(token, metadata, nar);

				return metadata;
			})
		);

		const narHashes = paths.map((metadata) => metadata.narHash);
		const [head] = paths;

		if (head === undefined) {
			throw new Error('the set needs at least one path');
		}

		const counts = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const pipeline = drivenDirectly(pipelineFor(instance.context));
				const batches = vi.spyOn(env.CUPBOARD_DB, 'batch');

				try {
					const prefetched =
						await pipeline.prefetchMaterialisationFacts(narHashes);
					const prefetchBatches = batches.mock.calls.length;

					batches.mockClear();
					await pipeline.probeMaterialisation(
						head,
						prefetched.get(head.narHash)
					);

					return {
						prefetchBatches,
						probeBatches: batches.mock.calls.length,
						facts: prefetched.size
					};
				} finally {
					batches.mockRestore();
				}
			}
		);

		expect(counts).toStrictEqual({
			prefetchBatches: 2,
			probeBatches: 0,
			facts: 3
		});
	});

	it('makes three D1 batch calls for two reuse entries', async () => {
		const token = await initialise();
		const nar = await verifiableNar('socket-prefetch');
		const paths = ['a', 'b', 'c'].map((letter, index) =>
			uploadMetadata({
				name: `socket-prefetch-${String(index)}`,
				storePathHash: letter.repeat(32),
				narHash: nar.narHash,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength,
				narSize: nar.narSize
			})
		);
		const [first, ...rest] = paths;

		if (first === undefined) {
			throw new Error('the batch needs at least one path');
		}

		await commitPath(token, first, nar);

		const reuseEntries: {
			uploadId: string;
			metadata: (typeof rest)[number];
		}[] = [];

		for (const metadata of rest) {
			const decision = expectSingleCommitDecision(
				await negotiateUploads(token, [metadata]),
				metadata
			);
			reuseEntries.push({ uploadId: decision.uploadId, metadata });
		}

		// The handler performs two prefetch batches for the whole message and one
		// charge batch for the shared flush. Each entry must use the prefetched facts
		// instead of adding its own D1 probe.
		const batches = vi.spyOn(env.CUPBOARD_DB, 'batch');

		try {
			const session = await openCommitSession(token);
			session.send({
				op: 'commit-batch',
				commits: reuseEntries.map(({ uploadId, metadata }) => ({
					uploadId,
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				}))
			});

			for (const _ of reuseEntries) {
				await session.nextFrame();
			}

			session.socket.close();

			expect(batches.mock.calls.length).toBe(3);
		} finally {
			batches.mockRestore();
		}
	});

	it('settles both entries sharing one NAR when the quota allows one blob charge', async () => {
		const nar = await verifiableNar('shared-hash-quota');

		await provisionFixtureTenant({ quotaBytes: nar.narBytes.byteLength });
		const token = await initialise();

		const pathA = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			name: 'shared-hash-a',
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const pathB = uploadMetadata({
			storePathHash: 'b'.repeat(32),
			name: 'shared-hash-b',
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const pathC = uploadMetadata({
			storePathHash: 'c'.repeat(32),
			name: 'shared-hash-c',
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, pathA, nar);

		const decisionB = expectSingleCommitDecision(
			await negotiateUploads(token, [pathB]),
			pathB
		);
		const decisionC = expectSingleCommitDecision(
			await negotiateUploads(token, [pathC]),
			pathC
		);

		const session = await openCommitSession(token);
		session.send({
			op: 'commit-batch',
			commits: [
				{
					uploadId: decisionB.uploadId,
					storePathHash: pathB.storePathHash,
					narHash: pathB.narHash
				},
				{
					uploadId: decisionC.uploadId,
					storePathHash: pathC.storePathHash,
					narHash: pathC.narHash
				}
			]
		});

		const frames = [await session.nextFrame(), await session.nextFrame()];
		session.socket.close();

		expect(
			frames.map((f) => f.ev).toSorted((a, b) => a.localeCompare(b))
		).toStrictEqual(['settled', 'settled']);
	});

	it('attaches every path of a batched session to the bound run root, across flushes', async () => {
		const token = await initialise();
		const nar = await verifiableNar('batch-attach');
		const attachRoot = { name: 'ci/run-1', ttlSeconds: 3600 };
		const paths = ['a', 'b', 'c', 'd'].map((letter, index) =>
			uploadMetadata({
				name: `batch-attach-${String(index)}`,
				storePathHash: letter.repeat(32),
				narHash: nar.narHash,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength,
				narSize: nar.narSize
			})
		);
		const [seed, ...attached] = paths;

		if (seed === undefined) {
			throw new Error('the batch needs a seed path');
		}

		await commitPath(token, seed, nar);

		const negotiated = await authorisedFetch('/uploads', token, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				pushId: testPushId,
				paths: attached.map((path) => uploadPathNegotiation(path)),
				attachRoot
			})
		});
		expect(negotiated.status).toBe(StatusCodes.OK);
		const decisions = uploadNegotiateResponseSchema
			.parse(await negotiated.json())
			.uploads.map((decision) => uploadCommitDecisionSchema.parse(decision));

		const session = await openCommitSession(token);
		const frames: string[] = [];

		for (const chunkOfDecisions of [
			decisions.slice(0, 2),
			decisions.slice(2)
		]) {
			session.send({
				op: 'commit-batch',
				commits: chunkOfDecisions.map((decision) => ({
					uploadId: decision.uploadId,
					storePathHash: decision.storePathHash,
					narHash: decision.narHash
				}))
			});

			const received = await Promise.all(
				chunkOfDecisions.map(() => session.nextFrame())
			);
			frames.push(...received.map((frame) => frame.ev));
		}

		session.socket.close();

		const targets = await runInDurableObject(currentServer(), (instance) =>
			instance.context.db
				.select({
					cacheId: schema.retentionRootTargets.cacheId,
					rootName: schema.retentionRootTargets.rootName,
					storePathHash: schema.retentionRootTargets.storePathHash,
					storePath: schema.retentionRootTargets.storePath
				})
				.from(schema.retentionRootTargets)
				.all()
				.map(({ cacheId, ...row }) => ({
					...row,
					cache: instance.context.cacheRepository.scopeForId(cacheId)
				}))
				.toSorted((left, right) =>
					left.storePathHash.localeCompare(right.storePathHash)
				)
		);

		expect({ frames, targets }).toStrictEqual({
			frames: ['settled', 'settled', 'settled'],
			targets: attached.map((path) => ({
				cache: defaultCache(),
				rootName: attachRoot.name,
				storePathHash: path.storePathHash,
				storePath: path.storePath
			}))
		});
	});
});

// More reuse commits than one invocation's D1 allowance can charge. Each
// materialisation charges five statements, so a burst this size needs more than
// one invocation on the Free allowance of 50.
const pagedBurst = 14;

/**
 * Commits one path, then drives a burst of reuse commits for its NAR through
 * one `materialiseBatched` flush under a single invocation allowance.
 *
 * Reports each request outcome, the D1 statement count, and the tenant's final
 * reference edges, presence rows, and usage.
 */
async function drivePagedBurst(server: string): Promise<{
	readonly kinds: readonly string[];
	readonly statements: number;
	readonly allowance: number;
	readonly edges: number;
	readonly presence: number;
	readonly narinfoUsage: number | null | undefined;
}> {
	await useTestServer(server);

	const token = await initialise();
	const nar = await verifiableNar('paged-burst');
	const paths = Array.from({ length: pagedBurst }, (_, index) =>
		uploadMetadata({
			name: `paged-${String(index)}`,
			storePathHash: syntheticStorePathHash(index),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		})
	);
	const [committed, ...reused] = paths;

	if (committed === undefined) {
		throw new Error('the burst needs at least one path');
	}

	await commitPath(token, committed, nar);

	for (const metadata of reused) {
		const decision = expectSingleCommitDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await commitUpload(token, decision.uploadId);
	}

	const counting = countingD1(env.CUPBOARD_DB);

	return runInDurableObject(currentServer(), async (instance, state) => {
		const real = instance.context.d1;

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: drizzleD1(boundedD1(counting.binding), { schema: d1Schema })
		});

		const local = drizzle(state.storage, { schema: { narInfos } });
		const generations = new Map(
			local
				.select({
					storePathHash: narInfos.storePathHash,
					generation: narInfos.generation
				})
				.from(narInfos)
				.all()
				.map((row) => [row.storePathHash, row.generation] as const)
		);
		const pipeline = pipelineFor(instance.context);
		const before = counting.statementsSent();

		// Use one allowance for the complete burst, as a dispatched method does.
		const kinds = await withStatementAllowance(async () => {
			const probe = await pipeline.probeMaterialisation(committed);

			return Promise.all(
				paths.map((metadata) => {
					const generation = generations.get(metadata.storePathHash);

					if (generation === undefined) {
						throw new Error('the committed path has no narinfo row');
					}

					return pipeline.materialiseBatched(rootLogger(), {
						cache: resolvedCache(instance.context),
						metadata,
						generation,
						probe,
						mustOwnBlob: true,
						graceDecision: undefined,
						attachRootName: undefined
					});
				})
			);
		});
		const statements = counting.statementsSent() - before;

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: real
		});

		const tenant = instance.context.requireTenant();
		const edges = await instance.context.d1
			.select({ narHash: d1Schema.blobReference.narHash })
			.from(d1Schema.blobReference)
			.where(eq(d1Schema.blobReference.tenant, tenant))
			.all();
		const presence = await instance.context.d1
			.select({ narHash: d1Schema.tenantBlob.narHash })
			.from(d1Schema.tenantBlob)
			.where(eq(d1Schema.tenantBlob.tenant, tenant))
			.all();
		const usage = await instance.context.d1
			.select({ narinfos: d1Schema.tenantUsage.narinfos })
			.from(d1Schema.tenantUsage)
			.where(eq(d1Schema.tenantUsage.tenant, tenant))
			.get();

		return {
			kinds: kinds.map((outcome) => outcome.kind).toSorted(byCodeUnit),
			statements,
			allowance: d1StatementsPerInvocation,
			edges: edges.length,
			presence: presence.length,
			narinfoUsage: usage?.narinfos
		};
	});
}

describe('materialise flush paging', () => {
	beforeEach(resetTestServer);

	it('charges requests within the allowance and defers the remaining requests', async () => {
		const driven = await drivePagedBurst('flush-paging');

		// The burst replays paths this fixture already committed, so the charge
		// statements are conditional no-ops and the tenant's edges and usage must
		// come out unchanged: paging a flush must not charge a path twice. Nine of
		// the fourteen fit the allowance once the probe and the account read have
		// taken theirs. The flush returns `deferred` for the other five requests and
		// leaves their uploads pending for verification.
		expect({
			deferred: driven.kinds.filter((kind) => kind === 'deferred').length,
			materialised: driven.kinds.filter((kind) => kind === 'materialised')
				.length,
			otherKinds: driven.kinds.filter(
				(kind) => kind !== 'deferred' && kind !== 'materialised'
			),
			withinAllowance: driven.statements <= driven.allowance,
			edges: driven.edges,
			presence: driven.presence,
			narinfoUsage: driven.narinfoUsage
		}).toStrictEqual({
			deferred: 5,
			materialised: 9,
			otherKinds: [],
			withinAllowance: true,
			edges: pagedBurst,
			presence: 1,
			narinfoUsage: pagedBurst
		});
	}, 240_000);
});
