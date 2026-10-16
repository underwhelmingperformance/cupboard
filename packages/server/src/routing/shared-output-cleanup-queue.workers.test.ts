import { sha256HexDigestSchema } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import {
	listingGeneratorRevisionSchema,
	maxArtifactBytes
} from '@cupboard/protocol/artifacts';
import { workersInvocationAllowances } from '@cupboard/protocol/platform';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { createExecutionContext } from 'cloudflare:test';
import { env as tenantEnv } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { artifactStageIdSchema } from '../blob/artifact-staging.ts';
import { sharedListingOutputEpochSchema } from '../blob/shared-listing-outputs.ts';
import { sharedListingStageKey } from '../blob/shared-listing-staging.ts';
import * as schema from '../db/d1-schema.ts';
import { SharedListingOutputCleanupStore } from '../db/shared-listing-output-cleanup.ts';
import { sharedNarDiscoveryFixture } from '../db/shared-nar-discovery.test-support.ts';
import { withSubrequestSlice } from '../do/subrequest-slice.ts';
import {
	initialise,
	resetTestServer,
	scheduledController,
	testControlEnv
} from '../test-support.ts';
import worker from '../worker.ts';

import type { SharedListingCleanupMessage } from './shared-listing-cleanup-message.ts';
import { SharedListingCleanupQueue } from './shared-listing-cleanup-queue.ts';

const env = Object.assign({}, tenantEnv, testControlEnv);
const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const deadline = isoTimestamp(new Date('2026-01-01T00:00:30.000Z'));
const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
interface Action {
	readonly id: string;
	readonly action: 'ack' | 'retry';
	readonly delaySeconds?: number;
}
function transport(body: unknown, actions: Action[], id = 'wake'): Message {
	return {
		id,
		body,
		timestamp: new Date(now),
		attempts: 1,
		ack: () => {
			actions.push({ id, action: 'ack' });
		},
		retry: (options) => {
			actions.push({
				id,
				action: 'retry',
				delaySeconds: options?.delaySeconds
			});
		}
	};
}
function batch(messages: Message[]): MessageBatch {
	return {
		messages,
		queue: 'cupboard-artifacts',
		metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
		ackAll: () => {
			throw new Error('Unexpected batch ack');
		},
		retryAll: () => {
			throw new Error('Unexpected batch retry');
		}
	};
}
async function fixture(count = 1, revisions = 19) {
	const { database, sources } = await sharedNarDiscoveryFixture(count);
	await database.insert(schema.deploymentTransition).values({
		id: 'shared-listing-output-retirement',
		state: 'expanded',
		updatedAt: now
	});
	const parents = await database.select().from(schema.blobReference);
	for (const source of sources) {
		for (let index = 0; index < revisions; index += 1) {
			await database.insert(schema.sharedListingOutputReference).values({
				narHash: source.narHash,
				generatorRevision: listingGeneratorRevisionSchema.parse(
					`nix-v1-r${String(index + 1).padStart(6, '0')}`
				),
				epoch: sharedListingOutputEpochSchema.parse(crypto.randomUUID()),
				sourceIncarnation: source.sourceIncarnation,
				computationGeneration: 1,
				digest: sha256HexDigestSchema.parse('a'.repeat(64)),
				size: 10,
				createdAt: now
			});
		}
	}
	await database.delete(schema.blobReference);
	await database
		.update(schema.sharedListingOutputCleanup)
		.set({ nextAttemptAt: now });
	const sent: SharedListingCleanupMessage[] = [];
	const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
	const queue: Queue<SharedListingCleanupMessage> = {
		metrics: () => Promise.resolve(metadata.metrics),
		send: (body) => {
			sent.push(body);
			return Promise.resolve({ metadata });
		},
		sendBatch: (entries) => {
			sent.push(...Array.from(entries, (entry) => entry.body));
			return Promise.resolve({ metadata });
		}
	};
	const consumer = () =>
		new SharedListingCleanupQueue({
			database: env.CUPBOARD_DB,
			blobs: env.BLOBS,
			queue
		});
	const narHash = sources[0]?.narHash;
	if (narHash === undefined) {
		throw new Error('The cleanup parent is missing');
	}
	const leaf = { kind: 'shared-listing-output-cleanup', narHash } as const;
	const store = new SharedListingOutputCleanupStore(database);
	return {
		database,
		sources,
		parents,
		narHash,
		leaf,
		sent,
		queue,
		consumer,
		store
	};
}

describe('shared output retirement queue', () => {
	it('dispatches finite unclaimed pages with a fixed D1 cutoff', async () => {
		const { sources, sent, consumer, store } = await fixture(19, 1);
		const before = await store.cutoff();
		await consumer().start();
		const first = [...sent];
		let next = sent.find(
			(message) => message.kind === 'shared-listing-output-sweep'
		);
		if (next?.kind !== 'shared-listing-output-sweep') {
			throw new Error('The output sweep continuation is missing');
		}
		const through = next.through;
		const after = await store.cutoff();
		sent.length = 0;
		const actions: Action[] = [];
		await consumer().handleMessage(transport(next, actions, 'second'));
		const second = [...sent];
		next = sent.find(
			(message) => message.kind === 'shared-listing-output-sweep'
		);
		if (next?.kind !== 'shared-listing-output-sweep') {
			throw new Error('The second output continuation is missing');
		}
		sent.length = 0;
		await consumer().handleMessage(transport(next, actions, 'third'));
		const hints = (start: number, end: number) =>
			sources.slice(start, end).map(({ narHash }) => ({
				kind: 'shared-listing-output-cleanup',
				narHash
			}));
		expect({
			first,
			second,
			third: sent,
			usesD1Clock: through >= before && through <= after,
			actions
		}).toStrictEqual({
			first: [
				...hints(0, 8),
				{
					kind: 'shared-listing-output-sweep',
					through,
					after: { at: now, narHash: sources[7]?.narHash }
				}
			],
			second: [
				...hints(8, 16),
				{
					kind: 'shared-listing-output-sweep',
					through,
					after: { at: now, narHash: sources[15]?.narHash }
				}
			],
			third: hints(16, 19),
			usesD1Clock: true,
			actions: [
				{ id: 'second', action: 'ack' },
				{ id: 'third', action: 'ack' }
			]
		});
	});

	it('routes real Worker hints and continues from each durable revision checkpoint', async () => {
		const { database, leaf, queue, sent } = await fixture();
		const actions: Action[] = [];
		await worker.queue(
			batch([transport(leaf, actions, 'first')]),
			{
				...env,
				ARTIFACT_QUEUE: queue
			},
			createExecutionContext()
		);
		const afterFirst = await database
			.select({ revision: schema.sharedListingOutputCleanup.cursor })
			.from(schema.sharedListingOutputCleanup);
		const next = sent.shift();
		if (next === undefined) {
			throw new Error('The retirement continuation is missing');
		}
		await worker.queue(
			batch([transport(next, actions, 'second')]),
			{
				...env,
				ARTIFACT_QUEUE: queue
			},
			createExecutionContext()
		);
		const last = sent.shift();
		if (last === undefined) {
			throw new Error('The final retirement continuation is missing');
		}
		await worker.queue(
			batch([transport(last, actions, 'third')]),
			{
				...env,
				ARTIFACT_QUEUE: queue
			},
			createExecutionContext()
		);
		await worker.queue(
			batch([transport(leaf, actions, 'duplicate')]),
			{
				...env,
				ARTIFACT_QUEUE: queue
			},
			createExecutionContext()
		);
		expect({
			afterFirst,
			references: await database
				.select()
				.from(schema.sharedListingOutputReference),
			scopes: await database.select().from(schema.sharedListingOutputCleanup),
			sent,
			actions
		}).toStrictEqual({
			afterFirst: [{ revision: 'nix-v1-r000008' }],
			references: [],
			scopes: [],
			sent: [],
			actions: [
				{ id: 'first', action: 'ack' },
				{ id: 'second', action: 'ack' },
				{ id: 'third', action: 'ack' },
				{ id: 'duplicate', action: 'ack' }
			]
		});
	});

	it.each(['sendBatch', 'send'] as const)(
		'recovers failed discovery %s without claiming or advancing scopes',
		async (method) => {
			const { database, queue, consumer, sent, sources } = await fixture(10, 1);
			const scopes = await database
				.select()
				.from(schema.sharedListingOutputCleanup);
			const failed = vi
				.spyOn(queue, method)
				.mockRejectedValueOnce(new Error('output send failed'));
			try {
				await expect(consumer().start()).rejects.toThrow('output send failed');
			} finally {
				failed.mockRestore();
			}
			expect(
				await database.select().from(schema.sharedListingOutputCleanup)
			).toStrictEqual(scopes);
			sent.length = 0;
			await consumer().start();
			expect(
				sent.filter(
					(message) => message.kind === 'shared-listing-output-cleanup'
				)
			).toStrictEqual(
				sources.slice(0, 8).map(({ narHash }) => ({
					kind: 'shared-listing-output-cleanup',
					narHash
				}))
			);
		}
	);

	it.each(['send', 'checkpoint-reply'] as const)(
		'recovers a failed %s from the committed cursor',
		async (phase) => {
			const { database, consumer, queue, leaf, sent } = await fixture();
			const execute = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			async function loseReply<T>(
				statements: D1PreparedStatement[]
			): Promise<D1Result<T>[]> {
				await execute<T>(statements);
				throw new Error('The committed retirement reply was lost');
			}
			const failed =
				phase === 'send'
					? vi
							.spyOn(queue, 'send')
							.mockRejectedValueOnce(new Error('continuation send failed'))
					: vi
							.spyOn(env.CUPBOARD_DB, 'batch')
							.mockImplementationOnce(loseReply);
			const actions: Action[] = [];
			try {
				await consumer().handleMessage(transport(leaf, actions));
			} finally {
				failed.mockRestore();
			}
			const checkpoint = await database
				.select({ revision: schema.sharedListingOutputCleanup.cursor })
				.from(schema.sharedListingOutputCleanup);
			await consumer().handleMessage(transport(leaf, actions, 'retry'));
			expect({
				checkpoint,
				remaining: await database.get<{ count: number }>(
					sql`SELECT count(*) AS count FROM shared_listing_output_ref`
				),
				sent,
				actions
			}).toStrictEqual({
				checkpoint: [{ revision: 'nix-v1-r000008' }],
				remaining: { count: 3 },
				sent: [leaf],
				actions: [
					{ id: 'wake', action: 'retry', delaySeconds: 60 },
					{ id: 'retry', action: 'ack' }
				]
			});
		}
	);

	it('defers a busy scope and recovers expired ownership through a fresh wave', async () => {
		const { database, store, narHash, consumer, leaf, sent } = await fixture(
			1,
			1
		);
		await store.claim(narHash, owner, now);
		const actions: Action[] = [];
		await consumer().handleMessage(transport(leaf, actions, 'busy'));
		vi.setSystemTime(new Date(deadline));
		await consumer().start();
		expect(sent).toStrictEqual([leaf]);
		await consumer().handleMessage(transport(sent[0], actions, 'recovered'));
		expect({
			remaining: await database
				.select()
				.from(schema.sharedListingOutputReference),
			actions
		}).toStrictEqual({
			remaining: [],
			actions: [
				{ id: 'busy', action: 'retry', delaySeconds: 30 },
				{ id: 'recovered', action: 'ack' }
			]
		});
	});

	it('preserves references when the NAR parent returns before consumption', async () => {
		const { database, parents, consumer, leaf } = await fixture();
		const references = await database
			.select()
			.from(schema.sharedListingOutputReference);
		await database.insert(schema.blobReference).values(parents);
		const actions: Action[] = [];
		await consumer().handleMessage(transport(leaf, actions));
		expect({
			references: await database
				.select()
				.from(schema.sharedListingOutputReference),
			scopes: await database.select().from(schema.sharedListingOutputCleanup),
			actions
		}).toStrictEqual({
			references,
			scopes: [],
			actions: [{ id: 'wake', action: 'ack' }]
		});
	});

	it('continues independent hints in one invocation without a fixed message cap', async () => {
		const { consumer, sources, database } = await fixture(2, 1);
		const invocation = consumer();
		const actions: Action[] = [];
		await withSubrequestSlice(
			async () => {
				for (const [index, source] of sources.entries()) {
					await invocation.handleMessage(
						transport(
							{
								kind: 'shared-listing-output-cleanup',
								narHash: source.narHash
							},
							actions,
							String(index)
						)
					);
				}
			},
			{ subrequests: workersInvocationAllowances.free.subrequests }
		);
		expect({
			scopes: await database.select().from(schema.sharedListingOutputCleanup),
			actions
		}).toStrictEqual({
			scopes: [],
			actions: [
				{ id: '0', action: 'ack' },
				{ id: '1', action: 'ack' }
			]
		});
	});

	it('refuses new work after the invocation time or subrequest allowance is exhausted', async () => {
		const { consumer, leaf } = await fixture();
		const actions: Action[] = [];
		const invocation = consumer();
		vi.setSystemTime(new Date(Date.parse(now) + 25_000));
		const reads = vi.spyOn(env.CUPBOARD_DB, 'prepare');
		try {
			await invocation.handleMessage(transport(leaf, actions, 'time'));
			await withSubrequestSlice(
				() => consumer().handleMessage(transport(leaf, actions, 'subrequests')),
				{ subrequests: 7, reserve: 0 }
			);
			expect({ queries: reads.mock.calls.length, actions }).toStrictEqual({
				queries: 0,
				actions: [
					{ id: 'time', action: 'retry', delaySeconds: 60 },
					{ id: 'subrequests', action: 'retry', delaySeconds: 60 }
				]
			});
		} finally {
			reads.mockRestore();
		}
	});

	it('acknowledges malformed output hints before D1 access', async () => {
		const { consumer } = await fixture();
		const actions: Action[] = [];
		const reads = vi.spyOn(env.CUPBOARD_DB, 'prepare');
		try {
			await consumer().handleMessage(
				transport(
					{ kind: 'shared-listing-output-cleanup', narHash: 'bad' },
					actions
				)
			);
			expect({ queries: reads.mock.calls.length, actions }).toStrictEqual({
				queries: 0,
				actions: [{ id: 'wake', action: 'ack' }]
			});
		} finally {
			reads.mockRestore();
		}
	});

	it.each([undefined, 'expanded', 'complete', 'future-state'] as const)(
		'uses the recorded retirement expansion state %s',
		async (state) => {
			const { database, consumer, leaf } = await fixture(1, 1);
			const references = await database
				.select()
				.from(schema.sharedListingOutputReference);
			await database
				.delete(schema.deploymentTransition)
				.where(
					eq(schema.deploymentTransition.id, 'shared-listing-output-retirement')
				);
			if (state !== undefined) {
				await database.insert(schema.deploymentTransition).values({
					id: 'shared-listing-output-retirement',
					state,
					updatedAt: now
				});
			}
			const actions: Action[] = [];
			await consumer().handleMessage(transport(leaf, actions));
			expect({
				references: await database
					.select()
					.from(schema.sharedListingOutputReference),
				actions
			}).toStrictEqual({
				references: state === undefined ? references : [],
				actions: [{ id: 'wake', action: 'ack' }]
			});
		}
	);

	it('works before output tables exist without preparing their queries', async () => {
		const { database, consumer, leaf, sent } = await fixture();
		await database
			.delete(schema.deploymentTransition)
			.where(
				eq(schema.deploymentTransition.id, 'shared-listing-output-retirement')
			);
		const retention = env.TEST_MIGRATIONS.find(
			(entry) => entry.name === '0061_shared_listing_output_retention.sql'
		);
		const retirement = env.TEST_MIGRATIONS.find(
			(entry) => entry.name === '0062_shared_listing_output_retirement.sql'
		);
		if (retention === undefined || retirement === undefined) {
			throw new Error('The output migrations are missing');
		}
		await env.CUPBOARD_DB.batch(
			[
				'DROP TRIGGER shared_listing_output_guard_arm',
				'DROP TRIGGER shared_listing_output_guard_delete',
				'DROP TRIGGER shared_listing_output_guard_retire',
				'DROP TRIGGER shared_listing_output_guard_registry_delete',
				'DROP TRIGGER shared_listing_output_parent_retired',
				'DROP TRIGGER shared_listing_output_fact_insert',
				'DROP TRIGGER shared_listing_output_fact_update',
				'DROP TABLE shared_listing_output_ref',
				'DROP TABLE shared_listing_output_cleanup'
			].map((query) => env.CUPBOARD_DB.prepare(query))
		);
		try {
			const reads = vi.spyOn(env.CUPBOARD_DB, 'prepare');
			const actions: Action[] = [];
			try {
				await consumer().start();
				await consumer().handleMessage(transport(leaf, actions));
				expect({
					outputQueries: reads.mock.calls.filter(([query]) =>
						query.includes('shared_listing_output_')
					),
					sent,
					actions
				}).toStrictEqual({
					outputQueries: [],
					sent: [],
					actions: [{ id: 'wake', action: 'ack' }]
				});
			} finally {
				reads.mockRestore();
			}
		} finally {
			await env.CUPBOARD_DB.batch(
				retention.queries.map((query) => env.CUPBOARD_DB.prepare(query))
			);
			await env.CUPBOARD_DB.batch(
				retirement.queries.map((query) => env.CUPBOARD_DB.prepare(query))
			);
		}
	});

	it('retries a storage failure without changing references', async () => {
		const { database, consumer, leaf } = await fixture(1, 1);
		const references = await database
			.select()
			.from(schema.sharedListingOutputReference);
		const actions: Action[] = [];
		const failed = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockImplementationOnce(() => {
				throw new Error('D1 unavailable');
			});
		try {
			await consumer().handleMessage(transport(leaf, actions));
		} finally {
			failed.mockRestore();
		}
		expect({
			references: await database
				.select()
				.from(schema.sharedListingOutputReference),
			actions
		}).toStrictEqual({
			references,
			actions: [{ id: 'wake', action: 'retry', delaySeconds: 60 }]
		});
	});

	it('uses current D1 ownership when an old hint reaches a recreated parent scope', async () => {
		const { database, parents, store, narHash, consumer, leaf } = await fixture(
			1,
			1
		);
		const old = await store.claim(narHash, owner, now);
		if (old.kind !== 'claimed') {
			throw new Error('The old cleanup claim is missing');
		}
		await database.insert(schema.blobReference).values(parents);
		await database.delete(schema.blobReference);
		await database
			.update(schema.sharedListingOutputCleanup)
			.set({ nextAttemptAt: now });
		const replacement = await database
			.select()
			.from(schema.sharedListingOutputCleanup)
			.get();
		const actions: Action[] = [];
		await consumer().handleMessage(transport(leaf, actions));
		expect({
			scopeChanged: replacement?.epoch !== old.claim.epoch,
			old: await store.drain(old.claim, now),
			references: await database
				.select()
				.from(schema.sharedListingOutputReference),
			actions
		}).toStrictEqual({
			scopeChanged: true,
			old: { kind: 'unavailable' },
			references: [],
			actions: [{ id: 'wake', action: 'ack' }]
		});
	});

	it.each(['stage', 'output', 'both'] as const)(
		'keeps staging and output dispatch independent when %s fails',
		async (phase) => {
			const { database, consumer, queue, sent, narHash, leaf } = await fixture(
				1,
				1
			);
			await database.insert(schema.deploymentTransition).values({
				id: 'shared-listing-staging',
				state: 'expanded',
				updatedAt: now
			});
			const id = artifactStageIdSchema.parse(
				'00000000-0000-4000-8000-000000000001'
			);
			await database.insert(schema.sharedListingStage).values({
				id,
				narHash,
				generatorRevision: listingGeneratorRevisionSchema.parse('nix-v1-r1'),
				sourceIncarnation: 2,
				computationGeneration: 1,
				r2Key: sharedListingStageKey(id),
				maximumBytes: maxArtifactBytes.listing,
				state: 'retired',
				createdAt: now,
				expiresAt: now,
				writeUntil: now,
				cleanupAfter: now,
				nextCleanupAt: now
			});
			const failure = new Error('dispatch failed');
			const attempts: string[] = [];
			const execute = queue.sendBatch.bind(queue);
			const failed = vi
				.spyOn(queue, 'sendBatch')
				.mockImplementation((entries) => {
					const batch = [...entries];
					const kind = batch[0]?.body.kind;
					if (kind === undefined) {
						throw new Error('The dispatch batch is empty');
					}
					attempts.push(kind);
					if (
						phase === 'both' ||
						(phase === 'stage' && kind === 'shared-listing-stage-cleanup') ||
						(phase === 'output' && kind === 'shared-listing-output-cleanup')
					) {
						return Promise.reject(failure);
					}
					return execute(batch);
				});
			let observed: unknown;
			try {
				await consumer().start();
			} catch (error) {
				observed = error;
			} finally {
				failed.mockRestore();
			}
			const errors: readonly unknown[] =
				observed instanceof AggregateError ? observed.errors : [observed];
			expect({
				attempts: attempts.toSorted(byCodeUnit),
				sent,
				errors
			}).toStrictEqual({
				attempts: [
					'shared-listing-output-cleanup',
					'shared-listing-stage-cleanup'
				],
				sent:
					phase === 'stage'
						? [leaf]
						: phase === 'output'
							? [{ kind: 'shared-listing-stage-cleanup', id }]
							: [],
				errors: phase === 'both' ? [failure, failure] : [failure]
			});
		}
	);

	it('starts output retirement through the real cron entrypoint', async () => {
		await resetTestServer();
		await initialise();
		const { queue, sent, leaf } = await fixture(1, 1);
		await worker.scheduled(scheduledController(), {
			...env,
			ARTIFACT_QUEUE: queue
		});
		expect(sent).toStrictEqual([leaf]);
	});

	it('preserves the original cutoff after the Worker clock changes and includes later deadlines in a fresh wave', async () => {
		const { database, consumer, sources, sent } = await fixture(19, 1);
		await consumer().start();
		let next = sent.find(
			(message) => message.kind === 'shared-listing-output-sweep'
		);
		if (next?.kind !== 'shared-listing-output-sweep') {
			throw new Error('The first sweep continuation is missing');
		}
		const through = next.through;
		const future = isoTimestamp(new Date(Date.parse(through) + 60_000));
		const last = sources.at(-1);
		if (last === undefined) {
			throw new Error('The later parent is missing');
		}
		await database
			.update(schema.sharedListingOutputCleanup)
			.set({ nextAttemptAt: future })
			.where(eq(schema.sharedListingOutputCleanup.narHash, last.narHash));
		const firstHints = sent.filter(
			(message) => message.kind === 'shared-listing-output-cleanup'
		);
		sent.length = 0;
		vi.setSystemTime(new Date(future));
		const actions: Action[] = [];
		await consumer().handleMessage(transport(next, actions, 'second'));
		const secondHints = sent.filter(
			(message) => message.kind === 'shared-listing-output-cleanup'
		);
		next = sent.find(
			(message) => message.kind === 'shared-listing-output-sweep'
		);
		if (next?.kind !== 'shared-listing-output-sweep') {
			throw new Error('The last sweep continuation is missing');
		}
		const isPreserved = next.through === through;
		sent.length = 0;
		await consumer().handleMessage(transport(next, actions, 'third'));
		const oldWave = [...firstHints, ...secondHints, ...sent];
		sent.length = 0;
		const clock = vi
			.spyOn(SharedListingOutputCleanupStore.prototype, 'cutoff')
			.mockResolvedValueOnce(future);
		try {
			await consumer().start();
		} finally {
			clock.mockRestore();
		}
		const fresh: SharedListingCleanupMessage[] = [];
		for (let page = 0; page < 3; page += 1) {
			fresh.push(
				...sent.filter(
					(message) => message.kind === 'shared-listing-output-cleanup'
				)
			);
			const continuation = sent.find(
				(message) => message.kind === 'shared-listing-output-sweep'
			);
			sent.length = 0;
			if (continuation === undefined) {
				break;
			}
			await consumer().handleMessage(
				transport(continuation, actions, `fresh-${String(page)}`)
			);
		}
		expect({ preserved: isPreserved, oldWave, fresh }).toStrictEqual({
			preserved: true,
			oldWave: sources.slice(0, 18).map(({ narHash }) => ({
				kind: 'shared-listing-output-cleanup',
				narHash
			})),
			fresh: sources.map(({ narHash }) => ({
				kind: 'shared-listing-output-cleanup',
				narHash
			}))
		});
	});
});
