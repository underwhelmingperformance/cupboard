import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import {
	managedCacheCapacityFailureSchema,
	managedCacheGroupIdSchema,
	managedPolicyRevisionSchema,
	managedPolicySummarySchema
} from '@cupboard/protocol/managed-caches';
import { reuseViewNameSchema } from '@cupboard/protocol/reuse-views';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	authorisedFetch,
	bootstrap,
	currentServer,
	issueServerSignedToken,
	resetTestServer,
	useTestServer
} from '../test-support.ts';

import { renewManagedCacheLease } from './managed-cache-service.ts';

const orpcErrorSchema = z.strictObject({
	defined: z.boolean(),
	code: z.string(),
	status: z.number(),
	message: z.string(),
	data: z.unknown().optional()
});
const groupParticipantRowsSchema = z.array(z.object({ policyId: z.string() }));
const groupTransitionBlockedStatuses: readonly ('retiring' | 'updating')[] = [
	'retiring',
	'updating'
];

function uniqueRepositoryId(): string {
	return String(Number.parseInt(crypto.randomUUID().slice(0, 8), 16));
}

function uniqueReuseViewName(prefix: string): string {
	return reuseViewNameSchema.parse(
		`${prefix}-${crypto.randomUUID().slice(0, 8)}`
	);
}

function byCodeUnit(left: string, right: string): number {
	if (left < right) {
		return -1;
	}

	return left > right ? 1 : 0;
}

async function putPolicy(
	token: string,
	maximumLiveCaches = 100,
	repositoryId = '123',
	priority = 40,
	reuseViewPriority = 50,
	reuseViewName = 'pull-requests'
) {
	const response = await authorisedFetch(
		`/managed-cache-policies/github/${repositoryId}`,
		token,
		{
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				ownerId: '42',
				reuseViewName,
				reuseViewPriority,
				access: 'private',
				priority,
				maximumLiveCaches
			})
		}
	);

	if (!response.ok) {
		throw new Error(
			`Managed policy request failed with ${response.status.toString()}: ${await response.text()}`
		);
	}

	return managedPolicySummarySchema.parse(await response.json());
}

async function provisionToken(
	policyId: string,
	cacheName: string
): Promise<string> {
	return issueServerSignedToken(
		authorizationDetailsSchema.parse([
			{
				type: 'cupboard_cache',
				actions: ['cache:provision'],
				cache: { kind: 'named', name: cacheName },
				managedPolicy: policyId
			}
		])
	);
}

async function provisionCache(
	token: string,
	cacheName: string
): Promise<Response> {
	return authorisedFetch(`/caches/${cacheName}/provision`, token, {
		method: 'POST'
	});
}

async function finishGroupAccessTransition(): Promise<void> {
	await runInDurableObject(currentServer(), async (instance) => {
		const tenant = instance.context.requireTenant();

		for (let attempt = 0; attempt < 256; attempt += 1) {
			const active = await instance.context.d1
				.select({ status: d1Schema.managedGroupAccessTransition.status })
				.from(d1Schema.managedGroupAccessTransition)
				.where(
					and(
						eq(d1Schema.managedGroupAccessTransition.tenant, tenant),
						inArray(d1Schema.managedGroupAccessTransition.status, [
							'running',
							'finalising'
						])
					)
				)
				.limit(1)
				.get();

			if (active === undefined) {
				await instance.context.ctx.storage.deleteAlarm();
				return;
			}

			await instance.alarm();
		}

		throw new Error('The managed group access transition did not complete');
	});
}

describe('managed caches', () => {
	beforeEach(resetTestServer);

	it('creates one policy and idempotently provisions an isolated PR cache', async () => {
		await useTestServer('managed-cache-provision');
		const admin = await bootstrap();
		const policy = await putPolicy(admin.token);
		const cacheName = cacheNameSchema.parse('gh-123-pr-1');
		const token = await provisionToken(policy.id, cacheName);

		const first = await provisionCache(token, cacheName);
		const firstBody = await first.json();
		const initialLease = await runInDurableObject(
			currentServer(),
			(instance) =>
				instance.context.db
					.select()
					.from(schema.caches)
					.where(eq(schema.caches.name, cacheName))
					.get()?.leaseExpiresAt
		);
		const second = await provisionCache(token, cacheName);
		const secondBody = await second.json();
		const repeatedLease = await runInDurableObject(
			currentServer(),
			(instance) =>
				instance.context.db
					.select()
					.from(schema.caches)
					.where(eq(schema.caches.name, cacheName))
					.get()?.leaseExpiresAt
		);

		expect({
			policy: {
				ownerId: policy.ownerId,
				repositoryId: policy.repositoryId,
				cacheNamespace: policy.cacheNamespace,
				access: policy.configuration.access
			},
			firstStatus: first.status,
			firstBody,
			secondStatus: second.status,
			secondBody,
			leaseUnchanged: repeatedLease === initialLease
		}).toStrictEqual({
			policy: {
				ownerId: '42',
				repositoryId: '123',
				cacheNamespace: 'gh-123-pr-',
				access: 'private'
			},
			firstStatus: StatusCodes.OK,
			firstBody: secondBody,
			secondStatus: StatusCodes.OK,
			secondBody,
			leaseUnchanged: true
		});
	});

	it('finishes an interrupted managed-cache activation from its repair intent', async () => {
		await useTestServer('managed-cache-activation-repair');
		const admin = await bootstrap();
		const policy = await putPolicy(admin.token);
		const cacheName = cacheNameSchema.parse('gh-123-pr-1');
		const token = await provisionToken(policy.id, cacheName);
		await runInDurableObject(currentServer(), async (instance) => {
			await instance.context.d1.delete(d1Schema.projectionRepairIntent);
		});
		const provisioned = await provisionCache(token, cacheName);

		expect(provisioned.status).toBe(StatusCodes.OK);

		const repaired = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const intent = await instance.context.d1
					.select()
					.from(d1Schema.projectionRepairIntent)
					.where(
						eq(
							d1Schema.projectionRepairIntent.operation,
							'managed-cache-activation'
						)
					)
					.get();

				if (intent === undefined) {
					throw new Error('Provisioning did not record its activation repair');
				}
				const creationExpiresAt = isoTimestamp(new Date(Date.now() + 60_000));

				await instance.context.d1
					.update(d1Schema.projectionRepairIntent)
					.set({ status: 'pending' })
					.where(eq(d1Schema.projectionRepairIntent.id, intent.id));
				await instance.context.d1
					.update(d1Schema.cacheLifecycle)
					.set({
						state: 'creating',
						creationExpiresAt,
						leaseExpiresAt: sql`NULL`,
						selectionState: 'detached'
					})
					.where(eq(d1Schema.cacheLifecycle.cacheName, cacheName));
				const outcome = await instance.resolveProjectionRepair(
					instance.context.requireTenant(),
					intent.id,
					intent.operation,
					intent.payloadJson
				);
				const lifecycle = await instance.context.d1
					.select({
						state: d1Schema.cacheLifecycle.state,
						selectionState: d1Schema.cacheLifecycle.selectionState
					})
					.from(d1Schema.cacheLifecycle)
					.where(eq(d1Schema.cacheLifecycle.cacheName, cacheName))
					.get();
				const completed = await instance.context.d1
					.select({ status: d1Schema.projectionRepairIntent.status })
					.from(d1Schema.projectionRepairIntent)
					.where(eq(d1Schema.projectionRepairIntent.id, intent.id))
					.get();

				await instance.context.d1
					.update(d1Schema.projectionRepairIntent)
					.set({ status: 'pending' })
					.where(eq(d1Schema.projectionRepairIntent.id, intent.id));
				instance.context.db
					.update(schema.caches)
					.set({
						lifecycleState: 'creating',
						creationExpiresAt,
						leaseExpiresAt: sql`NULL`,
						selectionState: 'detached'
					})
					.where(eq(schema.caches.name, cacheName))
					.run();
				const inverseOutcome = await instance.resolveProjectionRepair(
					instance.context.requireTenant(),
					intent.id,
					intent.operation,
					intent.payloadJson
				);
				const local = instance.context.db
					.select({
						state: schema.caches.lifecycleState,
						selectionState: schema.caches.selectionState
					})
					.from(schema.caches)
					.where(eq(schema.caches.name, cacheName))
					.get();

				return {
					outcome,
					lifecycle,
					intent: completed,
					inverseOutcome,
					local
				};
			}
		);

		expect(repaired).toStrictEqual({
			outcome: { outcome: 'complete' },
			lifecycle: { state: 'active', selectionState: 'source-active' },
			intent: { status: 'complete' },
			inverseOutcome: { outcome: 'complete' },
			local: { state: 'active', selectionState: 'source-active' }
		});
	});

	it('finishes a deferred activation before freezing a group transition', async () => {
		await useTestServer('managed-cache-group-deferred-activation');
		const admin = await bootstrap();
		const policy = await putPolicy(admin.token);
		const cacheName = cacheNameSchema.parse('gh-123-pr-1');
		await runInDurableObject(currentServer(), async (instance) => {
			await instance.context.d1.delete(d1Schema.projectionRepairIntent);
		});
		const provisioned = await provisionCache(
			await provisionToken(policy.id, cacheName),
			cacheName
		);
		expect(provisioned.status).toBe(StatusCodes.OK);
		await runInDurableObject(currentServer(), async (instance) => {
			const intent = await instance.context.d1
				.select()
				.from(d1Schema.projectionRepairIntent)
				.where(
					eq(
						d1Schema.projectionRepairIntent.operation,
						'managed-cache-activation'
					)
				)
				.get();

			if (intent === undefined) {
				throw new Error('Provisioning did not record its activation repair');
			}
			const creationExpiresAt = isoTimestamp(new Date(Date.now() + 60_000));
			await instance.context.d1.batch([
				instance.context.d1
					.update(d1Schema.projectionRepairIntent)
					.set({ status: 'pending' })
					.where(eq(d1Schema.projectionRepairIntent.id, intent.id)),
				instance.context.d1
					.update(d1Schema.cacheLifecycle)
					.set({
						state: 'creating',
						creationExpiresAt,
						leaseExpiresAt: sql`NULL`,
						selectionState: 'detached'
					})
					.where(eq(d1Schema.cacheLifecycle.cacheName, cacheName))
			]);
		});

		const changed = await authorisedFetch(
			`/managed-cache-groups/${policy.configuration.groupId}/access`,
			admin.token,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ access: 'public' })
			}
		);
		if (changed.ok) {
			await finishGroupAccessTransition();
		}
		const state = await runInDurableObject(
			currentServer(),
			async (instance) => {
				return {
					local: instance.context.db
						.select({
							access: schema.caches.access,
							state: schema.caches.lifecycleState
						})
						.from(schema.caches)
						.where(eq(schema.caches.name, cacheName))
						.get(),
					catalogue: await instance.context.d1
						.select({
							access: d1Schema.cacheLifecycle.access,
							state: d1Schema.cacheLifecycle.state
						})
						.from(d1Schema.cacheLifecycle)
						.where(eq(d1Schema.cacheLifecycle.cacheName, cacheName))
						.get(),
					transition: await instance.context.d1
						.select({ status: d1Schema.managedGroupAccessTransition.status })
						.from(d1Schema.managedGroupAccessTransition)
						.where(
							eq(
								d1Schema.managedGroupAccessTransition.groupId,
								policy.configuration.groupId
							)
						)
						.get(),
					repair: await instance.context.d1
						.select({ status: d1Schema.projectionRepairIntent.status })
						.from(d1Schema.projectionRepairIntent)
						.where(
							eq(
								d1Schema.projectionRepairIntent.operation,
								'managed-cache-activation'
							)
						)
						.get()
				};
			}
		);

		expect({ changedStatus: changed.status, state }).toStrictEqual({
			changedStatus: StatusCodes.OK,
			state: {
				local: { access: 'public', state: 'active' },
				catalogue: { access: 'public', state: 'active' },
				transition: { status: 'complete' },
				repair: { status: 'complete' }
			}
		});
	});

	it('requires the policy-derived name and counts creating and active caches', async () => {
		await useTestServer('managed-cache-capacity');
		const admin = await bootstrap();
		const policy = await putPolicy(admin.token, 1);
		const wrongName = 'pr-1';
		const wrongToken = await provisionToken(policy.id, wrongName);
		const wrong = await provisionCache(wrongToken, wrongName);
		const firstName = cacheNameSchema.parse('gh-123-pr-1');
		const firstToken = await provisionToken(policy.id, firstName);
		const first = await provisionCache(firstToken, firstName);
		const firstLease = await runInDurableObject(
			currentServer(),
			(instance) =>
				instance.context.db
					.select({ leaseExpiresAt: schema.caches.leaseExpiresAt })
					.from(schema.caches)
					.where(eq(schema.caches.name, firstName))
					.get()?.leaseExpiresAt
		);

		if (firstLease === null || firstLease === undefined) {
			throw new Error('The provisioned cache has no provisional lease');
		}
		const secondName = 'gh-123-pr-2';
		const secondToken = await provisionToken(policy.id, secondName);
		const full = await provisionCache(secondToken, secondName);
		const wrongBody = orpcErrorSchema.parse(await wrong.json());
		const fullBody = orpcErrorSchema.parse(await full.json());
		const expectedRetryAt = isoTimestamp(
			new Date(new Date(firstLease).getTime() + 5000)
		);

		expect({
			wrong: { status: wrong.status, code: wrongBody.code },
			first: first.status,
			full: {
				status: full.status,
				code: fullBody.code,
				data: managedCacheCapacityFailureSchema.parse(fullBody.data)
			}
		}).toStrictEqual({
			wrong: {
				status: StatusCodes.CONFLICT,
				code: 'MANAGED_CACHE_CONFLICT'
			},
			first: StatusCodes.OK,
			full: {
				status: StatusCodes.SERVICE_UNAVAILABLE,
				code: 'MANAGED_CACHE_CAPACITY',
				data: {
					kind: 'temporarily-full',
					retryAt: expectedRetryAt
				}
			}
		});
	});

	it('resumes its own creating cache while policy capacity is full', async () => {
		await useTestServer('managed-cache-capacity-resume');
		const admin = await bootstrap();
		const policy = await putPolicy(admin.token, 1);
		const cacheName = cacheNameSchema.parse('gh-123-pr-1');
		const token = await provisionToken(policy.id, cacheName);
		const first = await provisionCache(token, cacheName);
		expect(first.status).toBe(StatusCodes.OK);
		await runInDurableObject(currentServer(), async (instance) => {
			const creationExpiresAt = isoTimestamp(new Date(Date.now() + 60_000));
			instance.context.db
				.update(schema.caches)
				.set({
					lifecycleState: 'creating',
					creationExpiresAt,
					leaseExpiresAt: sql`NULL`,
					selectionState: 'detached'
				})
				.where(eq(schema.caches.name, cacheName))
				.run();
			await instance.context.d1
				.update(d1Schema.cacheLifecycle)
				.set({
					state: 'creating',
					creationExpiresAt,
					leaseExpiresAt: sql`NULL`,
					selectionState: 'detached'
				})
				.where(eq(d1Schema.cacheLifecycle.cacheName, cacheName))
				.run();
		});

		const resumed = await provisionCache(token, cacheName);
		const state = await runInDurableObject(
			currentServer(),
			async (instance) => ({
				local: instance.context.db
					.select({ state: schema.caches.lifecycleState })
					.from(schema.caches)
					.where(eq(schema.caches.name, cacheName))
					.get(),
				catalogue: await instance.context.d1
					.select({ state: d1Schema.cacheLifecycle.state })
					.from(d1Schema.cacheLifecycle)
					.where(eq(d1Schema.cacheLifecycle.cacheName, cacheName))
					.get()
			})
		);

		expect({ status: resumed.status, state }).toStrictEqual({
			status: StatusCodes.OK,
			state: {
				local: { state: 'active' },
				catalogue: { state: 'active' }
			}
		});
	});

	it('uses a creating cache deadline for a capacity retry', async () => {
		await useTestServer('managed-cache-capacity-creating-deadline');
		const admin = await bootstrap();
		const policy = await putPolicy(admin.token, 1);
		const firstName = cacheNameSchema.parse('gh-123-pr-1');
		const first = await provisionCache(
			await provisionToken(policy.id, firstName),
			firstName
		);
		expect(first.status).toBe(StatusCodes.OK);
		const creationExpiresAt = isoTimestamp(new Date(Date.now() + 60_000));
		await runInDurableObject(currentServer(), async (instance) => {
			instance.context.db
				.update(schema.caches)
				.set({
					lifecycleState: 'creating',
					creationExpiresAt,
					leaseExpiresAt: sql`NULL`,
					selectionState: 'detached'
				})
				.where(eq(schema.caches.name, firstName))
				.run();
			await instance.context.d1
				.update(d1Schema.cacheLifecycle)
				.set({
					state: 'creating',
					creationExpiresAt,
					leaseExpiresAt: sql`NULL`,
					selectionState: 'detached'
				})
				.where(eq(d1Schema.cacheLifecycle.cacheName, firstName))
				.run();
		});
		const secondName = cacheNameSchema.parse('gh-123-pr-2');
		const full = await provisionCache(
			await provisionToken(policy.id, secondName),
			secondName
		);
		const body = orpcErrorSchema.parse(await full.json());

		expect({
			status: full.status,
			code: body.code,
			data: managedCacheCapacityFailureSchema.parse(body.data)
		}).toStrictEqual({
			status: StatusCodes.SERVICE_UNAVAILABLE,
			code: 'MANAGED_CACHE_CAPACITY',
			data: { kind: 'temporarily-full', retryAt: creationExpiresAt }
		});
	});

	it('retires an empty managed cache after its activity lease expires', async () => {
		await useTestServer('managed-cache-retirement');
		const admin = await bootstrap();
		const policy = await putPolicy(admin.token);
		const cacheName = cacheNameSchema.parse('gh-123-pr-1');
		const token = await provisionToken(policy.id, cacheName);
		const provisioned = await provisionCache(token, cacheName);
		expect(provisioned.status).toBe(StatusCodes.OK);

		const state = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const expiredAt = isoTimestamp(new Date(Date.now() - 1000));
				instance.context.db
					.update(schema.caches)
					.set({ leaseExpiresAt: expiredAt })
					.where(eq(schema.caches.name, cacheName))
					.run();
				await instance.context.d1
					.update(d1Schema.cacheLifecycle)
					.set({ leaseExpiresAt: expiredAt })
					.where(eq(d1Schema.cacheLifecycle.cacheName, cacheName))
					.run();

				await instance.alarm();

				return {
					local: instance.context.db
						.select({
							state: schema.caches.lifecycleState,
							deletedAt: schema.caches.deletedAt
						})
						.from(schema.caches)
						.where(eq(schema.caches.name, cacheName))
						.get(),
					catalogue: await instance.context.d1
						.select({ state: d1Schema.cacheLifecycle.state })
						.from(d1Schema.cacheLifecycle)
						.where(eq(d1Schema.cacheLifecycle.cacheName, cacheName))
						.get()
				};
			}
		);

		expect({
			local: state.local && {
				state: state.local.state,
				isDeleted: state.local.deletedAt !== null
			},
			catalogue: state.catalogue
		}).toStrictEqual({
			local: { state: 'retiring', isDeleted: true },
			catalogue: { state: 'retiring' }
		});
	});

	it('changes access for every policy and cache in a shared group', async () => {
		await useTestServer('managed-cache-group-access');
		const admin = await bootstrap();
		const firstPolicy = await putPolicy(admin.token);
		const secondPolicy = await putPolicy(admin.token, 100, '456');
		const reuseViewName = reuseViewNameSchema.parse('pull-requests');
		const firstName = cacheNameSchema.parse('gh-123-pr-1');
		const secondName = cacheNameSchema.parse('gh-456-pr-1');
		const firstToken = await provisionToken(firstPolicy.id, firstName);
		const secondToken = await provisionToken(secondPolicy.id, secondName);
		const firstProvision = await provisionCache(firstToken, firstName);
		const secondProvision = await provisionCache(secondToken, secondName);
		expect(firstProvision.status).toBe(StatusCodes.OK);
		expect(secondProvision.status).toBe(StatusCodes.OK);

		const initialLeases = await runInDurableObject(
			currentServer(),
			(instance) =>
				instance.context.db
					.select({
						name: schema.caches.name,
						leaseExpiresAt: schema.caches.leaseExpiresAt
					})
					.from(schema.caches)
					.where(eq(schema.caches.managementKind, 'managed'))
					.orderBy(schema.caches.name)
					.all()
		);
		const response = await authorisedFetch(
			`/managed-cache-groups/${firstPolicy.configuration.groupId}/access`,
			admin.token,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ access: 'public' })
			}
		);
		expect(response.status).toBe(StatusCodes.OK);
		await finishGroupAccessTransition();

		const state = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const policies = await instance.context.d1
					.select({
						repositoryId: d1Schema.managedPolicyFamily.repositoryId,
						status: d1Schema.managedPolicyFamily.status,
						currentRevision: d1Schema.managedPolicyFamily.currentRevision,
						pendingRevision: d1Schema.managedPolicyFamily.pendingRevision
					})
					.from(d1Schema.managedPolicyFamily)
					.orderBy(d1Schema.managedPolicyFamily.repositoryId)
					.all();

				const transition = await instance.context.d1
					.select({
						status: d1Schema.managedGroupAccessTransition.status,
						targetGroupId: d1Schema.managedGroupAccessTransition.targetGroupId
					})
					.from(d1Schema.managedGroupAccessTransition)
					.where(
						eq(
							d1Schema.managedGroupAccessTransition.groupId,
							firstPolicy.configuration.groupId
						)
					)
					.get();

				if (transition === undefined) {
					throw new Error('The group access transition is missing');
				}

				return {
					groups: await instance.context.d1
						.select({
							id: d1Schema.managedCacheGroup.id,
							access: d1Schema.managedCacheGroup.access,
							state: d1Schema.managedCacheGroup.state
						})
						.from(d1Schema.managedCacheGroup)
						.where(
							inArray(d1Schema.managedCacheGroup.id, [
								firstPolicy.configuration.groupId,
								transition.targetGroupId
							])
						)
						.orderBy(d1Schema.managedCacheGroup.createdAt)
						.all(),
					policies: policies.map((policy) => ({
						repositoryId: policy.repositoryId,
						status: policy.status,
						currentRevision: policy.currentRevision,
						hasPendingRevision: policy.pendingRevision !== null
					})),
					caches: instance.context.db
						.select({
							name: schema.caches.name,
							access: schema.caches.access,
							policyRevision: schema.caches.managedPolicyRevision,
							selectionState: schema.caches.selectionState,
							updateHold: schema.caches.updateHold,
							leaseExpiresAt: schema.caches.leaseExpiresAt
						})
						.from(schema.caches)
						.where(eq(schema.caches.managementKind, 'managed'))
						.orderBy(schema.caches.name)
						.all(),
					view: instance.context.db
						.select({ access: schema.reuseViews.access })
						.from(schema.reuseViews)
						.where(eq(schema.reuseViews.name, reuseViewName))
						.get(),
					transition
				};
			}
		);

		const targetGroupId = state.transition.targetGroupId;

		expect(state).toStrictEqual({
			groups: [
				{
					id: firstPolicy.configuration.groupId,
					access: 'private',
					state: 'retired'
				},
				{ id: targetGroupId, access: 'public', state: 'active' }
			],
			policies: [
				{
					repositoryId: '123',
					status: 'active',
					currentRevision: 2,
					hasPendingRevision: false
				},
				{
					repositoryId: '456',
					status: 'active',
					currentRevision: 2,
					hasPendingRevision: false
				}
			],
			caches: initialLeases.map((cache) => ({
				name: cache.name,
				access: 'public',
				policyRevision: 2,
				selectionState: 'source-active',
				updateHold: false,
				leaseExpiresAt: cache.leaseExpiresAt
			})),
			view: { access: 'public' },
			transition: { status: 'complete', targetGroupId }
		});
	});

	it('preserves the managed view priority through an access transition', async () => {
		await useTestServer('managed-cache-group-view-priority');
		const admin = await bootstrap();
		const repositoryId = uniqueRepositoryId();
		const policy = await putPolicy(
			admin.token,
			100,
			repositoryId,
			40,
			70,
			uniqueReuseViewName('priority')
		);
		const response = await authorisedFetch(
			`/managed-cache-groups/${policy.configuration.groupId}/access`,
			admin.token,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ access: 'public' })
			}
		);
		expect(response.status).toBe(StatusCodes.OK);
		await finishGroupAccessTransition();

		const state = await runInDurableObject(
			currentServer(),
			async (instance) => ({
				policyPriority: policy.reuseViewPriority,
				group: await instance.context.d1
					.select({ priority: d1Schema.managedCacheGroup.reuseViewPriority })
					.from(d1Schema.managedCacheGroup)
					.where(eq(d1Schema.managedCacheGroup.state, 'active'))
					.get(),
				view: instance.context.db
					.select({ priority: schema.reuseViews.priority })
					.from(schema.reuseViews)
					.where(eq(schema.reuseViews.name, policy.reuseViewName))
					.get()
			})
		);

		expect(state).toStrictEqual({
			policyPriority: 70,
			group: { priority: 70 },
			view: { priority: 70 }
		});
	});

	it('moves a full policy group and paged cache worklist within D1 budgets', async () => {
		await useTestServer('managed-cache-group-statement-bound');
		const admin = await bootstrap();
		const repositoryId = '30001';
		const reuseViewName = uniqueReuseViewName('large-group');
		const policy = await putPolicy(
			admin.token,
			100,
			repositoryId,
			40,
			50,
			reuseViewName
		);

		for (let index = 2; index <= 20; index += 1) {
			await putPolicy(
				admin.token,
				100,
				String(30_000 + index),
				40,
				50,
				reuseViewName
			);
		}

		const cacheNames = Array.from({ length: 49 }, (_value, index) =>
			cacheNameSchema.parse(`gh-${repositoryId}-pr-${String(index + 1)}`)
		);

		for (const cacheName of cacheNames) {
			const response = await provisionCache(
				await provisionToken(policy.id, cacheName),
				cacheName
			);

			expect(response.status).toBe(StatusCodes.OK);
		}

		const changed = await authorisedFetch(
			`/managed-cache-groups/${policy.configuration.groupId}/access`,
			admin.token,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ access: 'public' })
			}
		);
		expect(changed.status).toBe(StatusCodes.OK);
		await finishGroupAccessTransition();
		const state = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const transition = await instance.context.d1
					.select({
						id: d1Schema.managedGroupAccessTransition.id,
						status: d1Schema.managedGroupAccessTransition.status,
						targetGroupId: d1Schema.managedGroupAccessTransition.targetGroupId,
						participantPoliciesJson:
							d1Schema.managedGroupAccessTransition.participantPoliciesJson
					})
					.from(d1Schema.managedGroupAccessTransition)
					.where(
						eq(
							d1Schema.managedGroupAccessTransition.groupId,
							policy.configuration.groupId
						)
					)
					.get();

				if (transition === undefined) {
					throw new Error('The group access transition is missing');
				}

				return {
					transition: {
						status: transition.status,
						targetGroupId: transition.targetGroupId,
						participants: groupParticipantRowsSchema.parse(
							JSON.parse(transition.participantPoliciesJson)
						).length
					},
					groups: await instance.context.d1
						.select({
							id: d1Schema.managedCacheGroup.id,
							access: d1Schema.managedCacheGroup.access,
							state: d1Schema.managedCacheGroup.state
						})
						.from(d1Schema.managedCacheGroup)
						.where(
							inArray(d1Schema.managedCacheGroup.id, [
								policy.configuration.groupId,
								transition.targetGroupId
							])
						)
						.orderBy(d1Schema.managedCacheGroup.createdAt)
						.all(),
					policies: await instance.context.d1
						.select({
							status: d1Schema.managedPolicyFamily.status,
							currentRevision: d1Schema.managedPolicyFamily.currentRevision
						})
						.from(d1Schema.managedPolicyFamily)
						.orderBy(d1Schema.managedPolicyFamily.repositoryId)
						.all(),
					worklist: await instance.context.d1
						.select({
							cacheName: d1Schema.managedGroupAccessTransitionCache.cacheName,
							state: d1Schema.managedGroupAccessTransitionCache.state
						})
						.from(d1Schema.managedGroupAccessTransitionCache)
						.where(
							eq(
								d1Schema.managedGroupAccessTransitionCache.transitionId,
								transition.id
							)
						)
						.orderBy(d1Schema.managedGroupAccessTransitionCache.cacheName)
						.all(),
					caches: instance.context.db
						.select({
							name: schema.caches.name,
							access: schema.caches.access,
							managedGroupId: schema.caches.managedGroupId,
							updateHold: schema.caches.updateHold
						})
						.from(schema.caches)
						.where(eq(schema.caches.managedPolicyId, policy.id))
						.orderBy(schema.caches.name)
						.all()
				};
			}
		);
		const targetGroupId = state.transition.targetGroupId;

		expect(state).toStrictEqual({
			transition: {
				status: 'complete',
				targetGroupId,
				participants: 20
			},
			groups: [
				{
					id: policy.configuration.groupId,
					access: 'private',
					state: 'retired'
				},
				{
					id: targetGroupId,
					access: 'public',
					state: 'active'
				}
			],
			policies: Array.from({ length: 20 }, () => ({
				status: 'active',
				currentRevision: 2
			})),
			worklist: cacheNames.toSorted(byCodeUnit).map((cacheName) => ({
				cacheName,
				state: 'complete'
			})),
			caches: cacheNames.toSorted(byCodeUnit).map((name) => ({
				name,
				access: 'public',
				managedGroupId: targetGroupId,
				updateHold: false
			}))
		});
	});

	it('cancels creating caches through persisted bounded transition work', async () => {
		await useTestServer('managed-cache-group-creation-bound');
		const admin = await bootstrap();
		const repositoryId = '31001';
		const policy = await putPolicy(admin.token, 100, repositoryId);
		const cacheNames = Array.from({ length: 46 }, (_value, index) =>
			cacheNameSchema.parse(`gh-${repositoryId}-pr-${String(index + 1)}`)
		);

		for (const cacheName of cacheNames) {
			const response = await provisionCache(
				await provisionToken(policy.id, cacheName),
				cacheName
			);

			expect(response.status).toBe(StatusCodes.OK);
		}

		const creationExpiresAt = isoTimestamp(new Date(Date.now() + 60_000));
		await runInDurableObject(currentServer(), async (instance) => {
			instance.context.db
				.update(schema.caches)
				.set({
					lifecycleState: 'creating',
					creationExpiresAt,
					leaseExpiresAt: sql`NULL`,
					selectionState: 'detached'
				})
				.where(inArray(schema.caches.name, cacheNames))
				.run();
			await instance.context.d1
				.update(d1Schema.cacheLifecycle)
				.set({
					state: 'creating',
					creationExpiresAt,
					leaseExpiresAt: sql`NULL`,
					selectionState: 'detached'
				})
				.where(inArray(d1Schema.cacheLifecycle.cacheName, cacheNames))
				.run();
		});

		const changed = await authorisedFetch(
			`/managed-cache-groups/${policy.configuration.groupId}/access`,
			admin.token,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ access: 'public' })
			}
		);
		expect(changed.status).toBe(StatusCodes.OK);
		const started = await runInDurableObject(
			currentServer(),
			async (instance) =>
				instance.context.d1
					.select({
						status: d1Schema.managedGroupAccessTransition.status,
						phase: d1Schema.managedGroupAccessTransition.phase
					})
					.from(d1Schema.managedGroupAccessTransition)
					.where(
						eq(
							d1Schema.managedGroupAccessTransition.groupId,
							policy.configuration.groupId
						)
					)
					.get()
		);
		expect(started).toStrictEqual({
			status: 'running',
			phase: 'cancel-creations'
		});
		const fencedCacheName = cacheNameSchema.parse(`gh-${repositoryId}-pr-47`);
		const fenced = await provisionCache(
			await provisionToken(policy.id, fencedCacheName),
			fencedCacheName
		);
		expect(fenced.status).toBe(StatusCodes.CONFLICT);

		await finishGroupAccessTransition();
		const state = await runInDurableObject(
			currentServer(),
			async (instance) => ({
				transition: await instance.context.d1
					.select({ status: d1Schema.managedGroupAccessTransition.status })
					.from(d1Schema.managedGroupAccessTransition)
					.where(
						eq(
							d1Schema.managedGroupAccessTransition.groupId,
							policy.configuration.groupId
						)
					)
					.get(),
				catalogue: await instance.context.d1
					.select({
						name: d1Schema.cacheLifecycle.cacheName,
						state: d1Schema.cacheLifecycle.state
					})
					.from(d1Schema.cacheLifecycle)
					.where(inArray(d1Schema.cacheLifecycle.cacheName, cacheNames))
					.orderBy(d1Schema.cacheLifecycle.cacheName)
					.all(),
				local: instance.context.db
					.select({ name: schema.caches.name })
					.from(schema.caches)
					.where(inArray(schema.caches.name, cacheNames))
					.all()
			})
		);

		expect(state).toStrictEqual({
			transition: { status: 'complete' },
			catalogue: cacheNames.toSorted(byCodeUnit).map((name) => ({
				name,
				state: 'deleted'
			})),
			local: []
		});
	});

	it.each(groupTransitionBlockedStatuses)(
		'refuses a group access transition while a member family is $status',
		async (status) => {
			await useTestServer(`managed-cache-group-${status}-member`);
			const admin = await bootstrap();
			const repositoryId = uniqueRepositoryId();
			const siblingRepositoryId = uniqueRepositoryId();
			const viewName = uniqueReuseViewName(status);
			const firstPolicy = await putPolicy(
				admin.token,
				100,
				repositoryId,
				40,
				50,
				viewName
			);
			const secondPolicy = await putPolicy(
				admin.token,
				100,
				siblingRepositoryId,
				40,
				50,
				viewName
			);
			const cacheName = cacheNameSchema.parse(`gh-${repositoryId}-pr-1`);
			const siblingCacheName = cacheNameSchema.parse(
				`gh-${siblingRepositoryId}-pr-1`
			);
			const firstProvision = await provisionCache(
				await provisionToken(firstPolicy.id, cacheName),
				cacheName
			);
			const siblingProvision = await provisionCache(
				await provisionToken(secondPolicy.id, siblingCacheName),
				siblingCacheName
			);

			expect({
				first: firstProvision.status,
				sibling: siblingProvision.status
			}).toStrictEqual({
				first: StatusCodes.OK,
				sibling: StatusCodes.OK
			});
			await runInDurableObject(currentServer(), async (instance) => {
				await instance.context.d1
					.update(d1Schema.managedPolicyFamily)
					.set({ status })
					.where(eq(d1Schema.managedPolicyFamily.id, secondPolicy.id))
					.run();
			});

			const response = await authorisedFetch(
				`/managed-cache-groups/${firstPolicy.configuration.groupId}/access`,
				admin.token,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ access: 'public' })
				}
			);
			const state = await runInDurableObject(
				currentServer(),
				async (instance) => ({
					transition: await instance.context.d1
						.select()
						.from(d1Schema.managedGroupAccessTransition)
						.where(
							eq(
								d1Schema.managedGroupAccessTransition.groupId,
								firstPolicy.configuration.groupId
							)
						)
						.get(),
					localHold: instance.context.db
						.select({ updateHold: schema.caches.updateHold })
						.from(schema.caches)
						.where(eq(schema.caches.name, cacheName))
						.get(),
					catalogueHold: await instance.context.d1
						.select({ updateHold: d1Schema.cacheLifecycle.updateHold })
						.from(d1Schema.cacheLifecycle)
						.where(eq(d1Schema.cacheLifecycle.cacheName, cacheName))
						.get()
				})
			);

			expect({ response: response.status, state }).toStrictEqual({
				response: StatusCodes.CONFLICT,
				state: {
					transition: undefined,
					localHold: { updateHold: false },
					catalogueHold: { updateHold: false }
				}
			});
		}
	);

	it('freezes group membership and cache work when an access transition starts', async () => {
		await useTestServer('managed-cache-group-stable-worklist');
		const admin = await bootstrap();
		const repositoryId = uniqueRepositoryId();
		const joiningRepositoryId = uniqueRepositoryId();
		const reuseViewName = uniqueReuseViewName('worklist');
		const policy = await putPolicy(
			admin.token,
			100,
			repositoryId,
			40,
			50,
			reuseViewName
		);
		const cacheNames = Array.from({ length: 5 }, (_value, index) =>
			cacheNameSchema.parse(`gh-${repositoryId}-pr-${String(index + 1)}`)
		);

		for (const cacheName of cacheNames) {
			const response = await provisionCache(
				await provisionToken(policy.id, cacheName),
				cacheName
			);

			expect(response.status).toBe(StatusCodes.OK);
		}

		const transition = await authorisedFetch(
			`/managed-cache-groups/${policy.configuration.groupId}/access`,
			admin.token,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ access: 'public' })
			}
		);
		expect(transition.status).toBe(StatusCodes.OK);
		await runInDurableObject(currentServer(), async (instance) => {
			await instance.alarm();
			await instance.alarm();
		});
		const joining = await authorisedFetch(
			`/managed-cache-policies/github/${joiningRepositoryId}`,
			admin.token,
			{
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					ownerId: '42',
					reuseViewName,
					reuseViewPriority: 50,
					access: 'private'
				})
			}
		);
		const stored = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const row = await instance.context.d1
					.select({
						id: d1Schema.managedGroupAccessTransition.id,
						participantPoliciesJson:
							d1Schema.managedGroupAccessTransition.participantPoliciesJson,
						targetGroupId: d1Schema.managedGroupAccessTransition.targetGroupId
					})
					.from(d1Schema.managedGroupAccessTransition)
					.where(
						eq(
							d1Schema.managedGroupAccessTransition.groupId,
							policy.configuration.groupId
						)
					)
					.get();
				const policies = await instance.context.d1
					.select({ repositoryId: d1Schema.managedPolicyFamily.repositoryId })
					.from(d1Schema.managedPolicyFamily)
					.orderBy(d1Schema.managedPolicyFamily.repositoryId)
					.all();
				const worklist =
					row === undefined
						? []
						: await instance.context.d1
								.select({
									cacheName:
										d1Schema.managedGroupAccessTransitionCache.cacheName
								})
								.from(d1Schema.managedGroupAccessTransitionCache)
								.where(
									eq(
										d1Schema.managedGroupAccessTransitionCache.transitionId,
										row.id
									)
								)
								.orderBy(d1Schema.managedGroupAccessTransitionCache.cacheName)
								.all();
				const groups = await instance.context.d1
					.select({
						id: d1Schema.managedCacheGroup.id,
						state: d1Schema.managedCacheGroup.state
					})
					.from(d1Schema.managedCacheGroup)
					.orderBy(d1Schema.managedCacheGroup.createdAt)
					.all();

				await instance.context.ctx.storage.deleteAlarm();

				return { row, policies, worklist, groups };
			}
		);

		if (stored.row === undefined) {
			throw new Error('The access transition did not persist its worklist');
		}
		const participants = groupParticipantRowsSchema.parse(
			JSON.parse(stored.row.participantPoliciesJson)
		);

		expect({
			joining: joining.status,
			participants,
			cacheNames: stored.worklist.map((cache) => cache.cacheName),
			policies: stored.policies,
			groups: stored.groups
		}).toStrictEqual({
			joining: StatusCodes.CONFLICT,
			participants: [{ policyId: policy.id }],
			cacheNames,
			policies: [{ repositoryId }],
			groups: [
				{ id: policy.configuration.groupId, state: 'transitioning' },
				{ id: stored.row.targetGroupId, state: 'transitioning' }
			]
		});
	});

	it('refuses a twenty-first policy in one managed group', async () => {
		await useTestServer('managed-cache-group-policy-bound');
		const admin = await bootstrap();
		const viewName = uniqueReuseViewName('bounded');

		for (let index = 1; index <= 20; index += 1) {
			await putPolicy(
				admin.token,
				100,
				String(10_000 + index),
				40,
				50,
				viewName
			);
		}

		const response = await authorisedFetch(
			'/managed-cache-policies/github/10021',
			admin.token,
			{
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					ownerId: '42',
					reuseViewName: viewName,
					reuseViewPriority: 50,
					access: 'private'
				})
			}
		);
		const body = orpcErrorSchema.parse(await response.json());

		expect({ status: response.status, code: body.code }).toStrictEqual({
			status: StatusCodes.CONFLICT,
			code: 'MANAGED_POLICY_CONFLICT'
		});
	});

	it('reconciles an immutable policy revision without changing cache leases', async () => {
		await useTestServer('managed-cache-policy-update');
		const admin = await bootstrap();
		const policy = await putPolicy(admin.token);
		const cacheNames = Array.from({ length: 6 }, (_value, index) =>
			cacheNameSchema.parse(`gh-123-pr-${(index + 1).toString()}`)
		);

		for (const cacheName of cacheNames) {
			const token = await provisionToken(policy.id, cacheName);
			const response = await provisionCache(token, cacheName);

			expect(response.status).toBe(StatusCodes.OK);
		}

		const initialLeases = await runInDurableObject(
			currentServer(),
			(instance) =>
				instance.context.db
					.select({
						name: schema.caches.name,
						leaseExpiresAt: schema.caches.leaseExpiresAt
					})
					.from(schema.caches)
					.where(eq(schema.caches.managedPolicyId, policy.id))
					.orderBy(schema.caches.name)
					.all()
		);
		const updating = await putPolicy(admin.token, 100, '123', 25);
		const existingCacheName = cacheNames[0];

		if (existingCacheName === undefined) {
			throw new Error('The managed policy update fixture has no caches');
		}

		const existingToken = await provisionToken(policy.id, existingCacheName);
		const fenced = await provisionCache(existingToken, existingCacheName);

		expect({ status: updating.status, fenced: fenced.status }).toStrictEqual({
			status: 'updating',
			fenced: StatusCodes.CONFLICT
		});

		const state = await runInDurableObject(
			currentServer(),
			async (instance) => {
				await instance.alarm();
				await instance.alarm();
				const storedPolicy = await instance.context.d1
					.select({
						status: d1Schema.managedPolicyFamily.status,
						currentRevision: d1Schema.managedPolicyFamily.currentRevision,
						pendingRevision: d1Schema.managedPolicyFamily.pendingRevision
					})
					.from(d1Schema.managedPolicyFamily)
					.where(eq(d1Schema.managedPolicyFamily.id, policy.id))
					.get();
				const policyState =
					storedPolicy === undefined
						? undefined
						: {
								...storedPolicy,
								pendingRevision: storedPolicy.pendingRevision ?? undefined
							};

				return {
					policy: policyState,
					caches: instance.context.db
						.select({
							name: schema.caches.name,
							priority: schema.caches.priority,
							policyRevision: schema.caches.managedPolicyRevision,
							updateHold: schema.caches.updateHold,
							leaseExpiresAt: schema.caches.leaseExpiresAt
						})
						.from(schema.caches)
						.where(eq(schema.caches.managedPolicyId, policy.id))
						.orderBy(schema.caches.name)
						.all()
				};
			}
		);

		expect(state).toStrictEqual({
			policy: {
				status: 'active',
				currentRevision: 2,
				pendingRevision: undefined
			},
			caches: initialLeases.map((cache) => ({
				name: cache.name,
				priority: 25,
				policyRevision: 2,
				updateHold: false,
				leaseExpiresAt: cache.leaseExpiresAt
			}))
		});
	});

	it('moves a policy update forwards into retirement', async () => {
		await useTestServer('managed-cache-policy-retire-during-update');
		const admin = await bootstrap();
		const policy = await putPolicy(admin.token);
		const cacheNames = Array.from({ length: 5 }, (_value, index) =>
			cacheNameSchema.parse(`gh-123-pr-${(index + 1).toString()}`)
		);

		for (const cacheName of cacheNames) {
			const token = await provisionToken(policy.id, cacheName);
			const provisioned = await provisionCache(token, cacheName);

			expect(provisioned.status).toBe(StatusCodes.OK);
		}

		const updating = await putPolicy(admin.token, 100, '123', 25);
		const response = await authorisedFetch(
			`/managed-cache-policies/${policy.id}/retire`,
			admin.token,
			{ method: 'POST' }
		);
		const body = managedPolicySummarySchema.parse(await response.json());
		await runInDurableObject(currentServer(), async (instance) => {
			instance.context.db
				.update(schema.caches)
				.set({ updateHold: true })
				.where(eq(schema.caches.managedPolicyId, policy.id))
				.run();
			await instance.context.d1
				.update(d1Schema.cacheLifecycle)
				.set({ updateHold: true })
				.where(eq(d1Schema.cacheLifecycle.managedPolicyId, policy.id))
				.run();
		});
		const repeated = await authorisedFetch(
			`/managed-cache-policies/${policy.id}/retire`,
			admin.token,
			{ method: 'POST' }
		);
		await runInDurableObject(currentServer(), async (instance) => {
			await instance.alarm();
			await instance.alarm();
		});
		const stored = await runInDurableObject(
			currentServer(),
			async (instance) => ({
				status: await instance.context.d1
					.select({ status: d1Schema.managedPolicyFamily.status })
					.from(d1Schema.managedPolicyFamily)
					.where(eq(d1Schema.managedPolicyFamily.id, policy.id))
					.get(),
				localHolds: instance.context.db
					.select({ updateHold: schema.caches.updateHold })
					.from(schema.caches)
					.where(eq(schema.caches.managedPolicyId, policy.id))
					.all(),
				catalogueHolds: await instance.context.d1
					.select({ updateHold: d1Schema.cacheLifecycle.updateHold })
					.from(d1Schema.cacheLifecycle)
					.where(eq(d1Schema.cacheLifecycle.managedPolicyId, policy.id))
					.all()
			})
		);

		expect({
			updating: updating.status,
			response: { status: response.status, policyStatus: body.status },
			repeated: repeated.status,
			stored
		}).toStrictEqual({
			updating: 'updating',
			response: {
				status: StatusCodes.OK,
				policyStatus: 'retiring'
			},
			repeated: StatusCodes.OK,
			stored: {
				status: { status: 'retiring' },
				localHolds: cacheNames.map(() => ({ updateHold: false })),
				catalogueHolds: cacheNames.map(() => ({ updateHold: false }))
			}
		});
	});

	it('finishes a partially applied policy revision before releasing retirement holds', async () => {
		await useTestServer('managed-cache-policy-retire-partial-update');
		const admin = await bootstrap();
		const policy = await putPolicy(admin.token);
		const cacheNames = Array.from({ length: 5 }, (_value, index) =>
			cacheNameSchema.parse(`gh-123-pr-${(index + 1).toString()}`)
		);

		for (const cacheName of cacheNames) {
			const token = await provisionToken(policy.id, cacheName);
			const provisioned = await provisionCache(token, cacheName);

			expect(provisioned.status).toBe(StatusCodes.OK);
		}

		const updating = await putPolicy(admin.token, 100, '123', 25);
		const lastCacheName = cacheNames.at(-1);

		if (lastCacheName === undefined) {
			throw new Error('The partial update fixture has no final cache');
		}

		const originalRevision = managedPolicyRevisionSchema.parse(1);

		const partialBeforeRetirement = await runInDurableObject(
			currentServer(),
			async (instance) => {
				instance.context.db
					.update(schema.caches)
					.set({ managedPolicyRevision: originalRevision, updateHold: true })
					.where(eq(schema.caches.name, lastCacheName))
					.run();
				await instance.context.d1
					.update(d1Schema.cacheLifecycle)
					.set({ managedPolicyRevision: originalRevision, updateHold: true })
					.where(eq(d1Schema.cacheLifecycle.cacheName, lastCacheName))
					.run();
				await instance.context.ctx.storage.deleteAlarm();

				return instance.context.db
					.select({
						name: schema.caches.name,
						policyRevision: schema.caches.managedPolicyRevision,
						updateHold: schema.caches.updateHold
					})
					.from(schema.caches)
					.where(eq(schema.caches.managedPolicyId, policy.id))
					.orderBy(schema.caches.name)
					.all();
			}
		);
		const retiring = await authorisedFetch(
			`/managed-cache-policies/${policy.id}/retire`,
			admin.token,
			{ method: 'POST' }
		);
		const afterMaintenance = await runInDurableObject(
			currentServer(),
			async (instance) => {
				await instance.alarm();
				await instance.alarm();
				const family = await instance.context.d1
					.select({
						status: d1Schema.managedPolicyFamily.status,
						currentRevision: d1Schema.managedPolicyFamily.currentRevision,
						pendingRevision: d1Schema.managedPolicyFamily.pendingRevision
					})
					.from(d1Schema.managedPolicyFamily)
					.where(eq(d1Schema.managedPolicyFamily.id, policy.id))
					.get();

				return {
					family:
						family === undefined
							? undefined
							: {
									...family,
									pendingRevision: family.pendingRevision ?? undefined
								},
					caches: instance.context.db
						.select({
							name: schema.caches.name,
							priority: schema.caches.priority,
							policyRevision: schema.caches.managedPolicyRevision,
							updateHold: schema.caches.updateHold
						})
						.from(schema.caches)
						.where(eq(schema.caches.managedPolicyId, policy.id))
						.orderBy(schema.caches.name)
						.all()
				};
			}
		);

		expect({
			updating: updating.status,
			retiring: retiring.status,
			partialBeforeRetirement,
			afterMaintenance
		}).toStrictEqual({
			updating: 'updating',
			retiring: StatusCodes.OK,
			partialBeforeRetirement: cacheNames.map((name, index) => ({
				name,
				policyRevision: index < 4 ? 2 : 1,
				updateHold: true
			})),
			afterMaintenance: {
				family: {
					status: 'retiring',
					currentRevision: 2,
					pendingRevision: undefined
				},
				caches: cacheNames.map((name) => ({
					name,
					priority: 25,
					policyRevision: 2,
					updateHold: false
				}))
			}
		});
	});

	it('finishes policy retirement and releases its namespace and view', async () => {
		await useTestServer('managed-cache-policy-retirement-finalisation');
		const admin = await bootstrap();
		const policy = await putPolicy(admin.token);
		const cacheName = cacheNameSchema.parse('gh-123-pr-1');
		const token = await provisionToken(policy.id, cacheName);
		const provisioned = await provisionCache(token, cacheName);
		expect(provisioned.status).toBe(StatusCodes.OK);

		const retiring = await authorisedFetch(
			`/managed-cache-policies/${policy.id}/retire`,
			admin.token,
			{ method: 'POST' }
		);
		expect(retiring.status).toBe(StatusCodes.OK);

		const finalised = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const deletedAt = isoTimestamp(new Date());
				instance.context.db
					.delete(schema.caches)
					.where(eq(schema.caches.name, cacheName))
					.run();
				await instance.context.d1
					.update(d1Schema.cacheLifecycle)
					.set({ state: 'deleted', deletedAt })
					.where(eq(d1Schema.cacheLifecycle.cacheName, cacheName))
					.run();
				instance.context.db
					.delete(schema.reuseViews)
					.where(eq(schema.reuseViews.name, policy.reuseViewName))
					.run();
				await instance.alarm();

				return {
					family: await instance.context.d1
						.select({ id: d1Schema.managedPolicyFamily.id })
						.from(d1Schema.managedPolicyFamily)
						.where(eq(d1Schema.managedPolicyFamily.id, policy.id))
						.get(),
					group: await instance.context.d1
						.select({ id: d1Schema.managedCacheGroup.id })
						.from(d1Schema.managedCacheGroup)
						.where(
							eq(d1Schema.managedCacheGroup.id, policy.configuration.groupId)
						)
						.get(),
					view: instance.context.db
						.select({ name: schema.reuseViews.name })
						.from(schema.reuseViews)
						.where(eq(schema.reuseViews.name, policy.reuseViewName))
						.get()
				};
			}
		);
		const replacement = await putPolicy(admin.token);

		expect({ finalised, replacement: replacement.status }).toStrictEqual({
			finalised: {
				family: undefined,
				group: undefined,
				view: undefined
			},
			replacement: 'active'
		});
	});

	it('refuses retirement during an incomplete shared-group access update', async () => {
		await useTestServer('managed-cache-group-retirement-fence');
		const admin = await bootstrap();
		const firstPolicy = await putPolicy(admin.token);
		const secondPolicy = await putPolicy(admin.token, 100, '456');
		await runInDurableObject(currentServer(), async (instance) => {
			const timestamp = isoTimestamp(new Date());
			const targetGroupId = managedCacheGroupIdSchema.parse(
				crypto.randomUUID()
			);
			await instance.context.d1
				.insert(d1Schema.managedGroupAccessTransition)
				.values({
					tenant: instance.context.requireTenant(),
					id: crypto.randomUUID(),
					groupId: firstPolicy.configuration.groupId,
					targetGroupId,
					sourceAccess: 'private',
					targetAccess: 'public',
					status: 'failed',
					createdAt: timestamp,
					updatedAt: timestamp,
					lastFailureJson: JSON.stringify({ code: 'interrupted' })
				})
				.run();
			await instance.context.ctx.storage.deleteAlarm();
		});
		const retirement = await authorisedFetch(
			`/managed-cache-policies/${firstPolicy.id}/retire`,
			admin.token,
			{ method: 'POST' }
		);
		const stored = await runInDurableObject(
			currentServer(),
			async (instance) => ({
				transition: await instance.context.d1
					.select({ status: d1Schema.managedGroupAccessTransition.status })
					.from(d1Schema.managedGroupAccessTransition)
					.where(
						eq(
							d1Schema.managedGroupAccessTransition.groupId,
							firstPolicy.configuration.groupId
						)
					)
					.get(),
				families: await instance.context.d1
					.select({
						id: d1Schema.managedPolicyFamily.id,
						status: d1Schema.managedPolicyFamily.status
					})
					.from(d1Schema.managedPolicyFamily)
					.orderBy(d1Schema.managedPolicyFamily.id)
					.all()
			})
		);

		expect({ retirement: retirement.status, stored }).toStrictEqual({
			retirement: StatusCodes.CONFLICT,
			stored: {
				transition: { status: 'failed' },
				families: [firstPolicy.id, secondPolicy.id]
					.toSorted((left, right) => left.localeCompare(right))
					.map((id) => ({ id, status: 'active' }))
			}
		});
	});

	it('resumes a group update after an ambiguous transition result', async () => {
		await useTestServer('managed-cache-group-finalisation-repair');
		const admin = await bootstrap();
		const policy = await putPolicy(admin.token);
		const cacheNames = Array.from({ length: 5 }, (_value, index) =>
			cacheNameSchema.parse(`gh-123-pr-${(index + 1).toString()}`)
		);

		for (const cacheName of cacheNames) {
			const response = await provisionCache(
				await provisionToken(policy.id, cacheName),
				cacheName
			);

			expect(response.status).toBe(StatusCodes.OK);
		}

		const update = await authorisedFetch(
			`/managed-cache-groups/${policy.configuration.groupId}/access`,
			admin.token,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ access: 'public' })
			}
		);
		expect(update.status).toBe(StatusCodes.OK);
		await runInDurableObject(currentServer(), async (instance) => {
			await instance.context.ctx.storage.deleteAlarm();
			const result = await instance.context.d1
				.update(d1Schema.managedGroupAccessTransition)
				.set({
					status: 'failed',
					lastFailureJson: JSON.stringify({ code: 'ambiguous-result' })
				})
				.where(eq(d1Schema.managedGroupAccessTransition.status, 'running'))
				.run();

			if (result.meta.changes !== 1) {
				throw new Error('The ambiguous transition fixture was not applied');
			}

			await instance.context.ctx.storage.deleteAlarm();
		});

		const resumed = await authorisedFetch(
			`/managed-cache-groups/${policy.configuration.groupId}/access`,
			admin.token,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ access: 'public' })
			}
		);
		await finishGroupAccessTransition();
		const stored = await runInDurableObject(
			currentServer(),
			async (instance) => ({
				transition: await instance.context.d1
					.select({ status: d1Schema.managedGroupAccessTransition.status })
					.from(d1Schema.managedGroupAccessTransition)
					.where(
						eq(
							d1Schema.managedGroupAccessTransition.groupId,
							policy.configuration.groupId
						)
					)
					.get(),
				family: await instance.context.d1
					.select({ status: d1Schema.managedPolicyFamily.status })
					.from(d1Schema.managedPolicyFamily)
					.where(eq(d1Schema.managedPolicyFamily.id, policy.id))
					.get(),
				view: instance.context.db
					.select({ access: schema.reuseViews.access })
					.from(schema.reuseViews)
					.where(eq(schema.reuseViews.name, policy.reuseViewName))
					.get(),
				holds: instance.context.db
					.select({ updateHold: schema.caches.updateHold })
					.from(schema.caches)
					.where(eq(schema.caches.managedPolicyId, policy.id))
					.all()
			})
		);

		expect({ resumed: resumed.status, stored }).toStrictEqual({
			resumed: StatusCodes.OK,
			stored: {
				transition: { status: 'complete' },
				family: { status: 'active' },
				view: { access: 'public' },
				holds: cacheNames.map(() => ({ updateHold: false }))
			}
		});
	});

	it('resumes after the local cache moves before its D1 projection', async () => {
		await useTestServer('managed-cache-group-cache-projection-repair');
		const admin = await bootstrap();
		const policy = await putPolicy(admin.token);
		const cacheName = cacheNameSchema.parse('gh-123-pr-1');
		const provisioned = await provisionCache(
			await provisionToken(policy.id, cacheName),
			cacheName
		);
		expect(provisioned.status).toBe(StatusCodes.OK);

		const update = await authorisedFetch(
			`/managed-cache-groups/${policy.configuration.groupId}/access`,
			admin.token,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ access: 'public' })
			}
		);
		expect(update.status).toBe(StatusCodes.OK);

		await runInDurableObject(currentServer(), async (instance) => {
			await instance.context.ctx.storage.deleteAlarm();

			for (let attempt = 0; attempt < 8; attempt += 1) {
				const transition = await instance.context.d1
					.select({ phase: d1Schema.managedGroupAccessTransition.phase })
					.from(d1Schema.managedGroupAccessTransition)
					.where(
						eq(
							d1Schema.managedGroupAccessTransition.groupId,
							policy.configuration.groupId
						)
					)
					.get();

				if (transition?.phase === 'move-caches') {
					break;
				}

				await instance.alarm();
				await instance.context.ctx.storage.deleteAlarm();
			}

			const transition = await instance.context.d1
				.select({
					id: d1Schema.managedGroupAccessTransition.id,
					targetGroupId: d1Schema.managedGroupAccessTransition.targetGroupId,
					phase: d1Schema.managedGroupAccessTransition.phase
				})
				.from(d1Schema.managedGroupAccessTransition)
				.where(
					eq(
						d1Schema.managedGroupAccessTransition.groupId,
						policy.configuration.groupId
					)
				)
				.get();

			if (transition?.phase !== 'move-caches') {
				throw new Error('The group transition did not capture its cache');
			}

			const work = await instance.context.d1
				.select({
					targetReadRevision:
						d1Schema.managedGroupAccessTransitionCache.targetReadRevision
				})
				.from(d1Schema.managedGroupAccessTransitionCache)
				.where(
					and(
						eq(
							d1Schema.managedGroupAccessTransitionCache.transitionId,
							transition.id
						),
						eq(d1Schema.managedGroupAccessTransitionCache.cacheName, cacheName)
					)
				)
				.get();

			if (work === undefined) {
				throw new Error('The cache is missing from the transition worklist');
			}

			await instance.context.d1
				.update(d1Schema.cacheLifecycle)
				.set({ selectionState: 'detached' })
				.where(eq(d1Schema.cacheLifecycle.cacheName, cacheName))
				.run();
			instance.context.db
				.update(schema.caches)
				.set({
					access: 'public',
					readRevision: work.targetReadRevision,
					managedPolicyRevision: managedPolicyRevisionSchema.parse(2),
					managedGroupId: transition.targetGroupId,
					selectionState: 'target-active'
				})
				.where(eq(schema.caches.name, cacheName))
				.run();
		});

		await finishGroupAccessTransition();
		const state = await runInDurableObject(
			currentServer(),
			async (instance) => ({
				transition: await instance.context.d1
					.select({ status: d1Schema.managedGroupAccessTransition.status })
					.from(d1Schema.managedGroupAccessTransition)
					.where(
						eq(
							d1Schema.managedGroupAccessTransition.groupId,
							policy.configuration.groupId
						)
					)
					.get(),
				local: instance.context.db
					.select({
						access: schema.caches.access,
						readRevision: schema.caches.readRevision,
						selectionState: schema.caches.selectionState,
						updateHold: schema.caches.updateHold
					})
					.from(schema.caches)
					.where(eq(schema.caches.name, cacheName))
					.get(),
				catalogue: await instance.context.d1
					.select({
						access: d1Schema.cacheLifecycle.access,
						readRevision: d1Schema.cacheLifecycle.readRevision,
						selectionState: d1Schema.cacheLifecycle.selectionState,
						updateHold: d1Schema.cacheLifecycle.updateHold
					})
					.from(d1Schema.cacheLifecycle)
					.where(eq(d1Schema.cacheLifecycle.cacheName, cacheName))
					.get()
			})
		);

		expect(state).toStrictEqual({
			transition: { status: 'complete' },
			local: {
				access: 'public',
				readRevision: 2,
				selectionState: 'source-active',
				updateHold: false
			},
			catalogue: {
				access: 'public',
				readRevision: 2,
				selectionState: 'source-active',
				updateHold: false
			}
		});
	});

	it('fails a group update when a captured cache leaves its source group', async () => {
		await useTestServer('managed-cache-group-worklist-fence');
		const admin = await bootstrap();
		const policy = await putPolicy(admin.token);
		const cacheName = cacheNameSchema.parse('gh-123-pr-1');
		const provisioned = await provisionCache(
			await provisionToken(policy.id, cacheName),
			cacheName
		);
		expect(provisioned.status).toBe(StatusCodes.OK);

		const update = await authorisedFetch(
			`/managed-cache-groups/${policy.configuration.groupId}/access`,
			admin.token,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ access: 'public' })
			}
		);
		expect(update.status).toBe(StatusCodes.OK);

		const stored = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const transitionState = async () =>
					instance.context.d1
						.select({
							id: d1Schema.managedGroupAccessTransition.id,
							phase: d1Schema.managedGroupAccessTransition.phase,
							status: d1Schema.managedGroupAccessTransition.status
						})
						.from(d1Schema.managedGroupAccessTransition)
						.where(
							eq(
								d1Schema.managedGroupAccessTransition.groupId,
								policy.configuration.groupId
							)
						)
						.get();

				for (let attempt = 0; attempt < 8; attempt += 1) {
					const capturing = await transitionState();

					if (capturing?.phase === 'move-caches') {
						break;
					}

					await instance.alarm();
					await instance.context.ctx.storage.deleteAlarm();
				}

				const captured = await transitionState();

				if (captured?.phase !== 'move-caches') {
					throw new Error('The group transition did not capture its cache');
				}

				await instance.context.d1
					.delete(d1Schema.cacheLifecycle)
					.where(eq(d1Schema.cacheLifecycle.cacheName, cacheName))
					.run();

				for (let attempt = 0; attempt < 8; attempt += 1) {
					try {
						await instance.alarm();
					} catch {
						// The maintenance pass rethrows after it fails the transition.
					}

					await instance.context.ctx.storage.deleteAlarm();

					const failing = await transitionState();

					if (failing?.status === 'failed') {
						break;
					}
				}

				const settled = await transitionState();

				return {
					phase: settled?.phase,
					status: settled?.status,
					work: await instance.context.d1
						.select({
							state: d1Schema.managedGroupAccessTransitionCache.state
						})
						.from(d1Schema.managedGroupAccessTransitionCache)
						.where(
							eq(
								d1Schema.managedGroupAccessTransitionCache.transitionId,
								captured.id
							)
						)
						.all()
				};
			}
		);

		expect(stored).toStrictEqual({
			phase: 'move-caches',
			status: 'failed',
			work: [{ state: 'pending' }]
		});
	});

	it('does not renew an accepted publication after its policy starts retiring', async () => {
		await useTestServer('managed-cache-policy-no-late-renewal');
		const admin = await bootstrap();
		const policy = await putPolicy(admin.token);
		const cacheName = cacheNameSchema.parse('gh-123-pr-1');
		const token = await provisionToken(policy.id, cacheName);
		const provisioned = await provisionCache(token, cacheName);
		expect(provisioned.status).toBe(StatusCodes.OK);

		const leases = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const cache = instance.context.cacheRepository.require({
					kind: 'named',
					name: cacheName
				});
				const before = instance.context.db
					.select({ expiresAt: schema.caches.leaseExpiresAt })
					.from(schema.caches)
					.where(eq(schema.caches.id, cache.id))
					.get();
				await instance.context.d1
					.update(d1Schema.managedPolicyFamily)
					.set({ status: 'retiring' })
					.where(eq(d1Schema.managedPolicyFamily.id, policy.id))
					.run();
				await renewManagedCacheLease(instance.context, cache);
				const after = instance.context.db
					.select({ expiresAt: schema.caches.leaseExpiresAt })
					.from(schema.caches)
					.where(eq(schema.caches.id, cache.id))
					.get();

				return { before, after };
			}
		);

		const expectedLease = leases.before;
		expect(leases).toStrictEqual({
			before: expectedLease,
			after: expectedLease
		});
	});

	it.each([
		{
			name: 'activates the matching cache while its policy remains active',
			retirePolicy: false,
			expected: {
				local: { state: 'active', hasLease: true },
				catalogue: { state: 'active', hasLease: true }
			}
		},
		{
			name: 'cancels the cache after its policy starts retiring',
			retirePolicy: true,
			expected: {
				local: { state: 'retiring', hasLease: true },
				catalogue: { state: 'retiring', hasLease: true }
			}
		}
	])('recovers expired creation and $name', async (testCase) => {
		await useTestServer(
			`managed-cache-creation-${String(testCase.retirePolicy)}`
		);
		const admin = await bootstrap();
		const policy = await putPolicy(admin.token);
		const cacheName = cacheNameSchema.parse('gh-123-pr-1');
		const token = await provisionToken(policy.id, cacheName);
		const provisioned = await provisionCache(token, cacheName);
		expect(provisioned.status).toBe(StatusCodes.OK);

		const state = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const expiredAt = isoTimestamp(new Date(Date.now() - 1000));
				instance.context.db
					.update(schema.caches)
					.set({
						lifecycleState: 'creating',
						creationExpiresAt: expiredAt,
						leaseExpiresAt: sql`NULL`,
						selectionState: 'detached'
					})
					.where(eq(schema.caches.name, cacheName))
					.run();
				await instance.context.d1
					.update(d1Schema.cacheLifecycle)
					.set({
						state: 'creating',
						creationExpiresAt: expiredAt,
						leaseExpiresAt: sql`NULL`,
						selectionState: 'detached'
					})
					.where(eq(d1Schema.cacheLifecycle.cacheName, cacheName))
					.run();

				if (testCase.retirePolicy) {
					await instance.context.d1
						.update(d1Schema.managedPolicyFamily)
						.set({ status: 'retiring' })
						.where(eq(d1Schema.managedPolicyFamily.id, policy.id))
						.run();
				}

				await instance.alarm();

				const local = instance.context.db
					.select({
						state: schema.caches.lifecycleState,
						lease: schema.caches.leaseExpiresAt
					})
					.from(schema.caches)
					.where(eq(schema.caches.name, cacheName))
					.get();
				const catalogue = await instance.context.d1
					.select({
						state: d1Schema.cacheLifecycle.state,
						lease: d1Schema.cacheLifecycle.leaseExpiresAt
					})
					.from(d1Schema.cacheLifecycle)
					.where(eq(d1Schema.cacheLifecycle.cacheName, cacheName))
					.get();

				return {
					local:
						local === undefined
							? undefined
							: { state: local.state, hasLease: local.lease !== null },
					catalogue:
						catalogue === undefined
							? undefined
							: {
									state: catalogue.state,
									hasLease: catalogue.lease !== null
								}
				};
			}
		);

		expect(state).toStrictEqual(testCase.expected);
	});
});
