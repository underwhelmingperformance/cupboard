import { cacheGenerationSchema } from '@cupboard/nix-store/scalars';
import { attestationBundleNegotiateResponseSchema } from '@cupboard/protocol/attestations';
import { publicationIdentity } from '@cupboard/protocol/publication';
import {
	acceptCapabilitiesHeader,
	cacheRemovedVerdictCapability,
	type CommitSessionFrame,
	publicationCapability,
	type PublicationEntry,
	publicationRefusalReasonsCapability,
	pushCredentialSchema,
	type PushId,
	pushRootWritesCapability,
	uploadCapabilitiesHeader,
	type UploadPathNegotiation,
	uploadPlanResponseSchema
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { isNotNull } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';

import {
	deliverAlarms,
	ignoreAlarmDeliveries
} from '../alarm-fence.test-support.ts';
import * as schema from '../db/schema.ts';
import { requestOriginSchema } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	cacheScopedPath,
	closeSessionAndWait,
	currentServer,
	framesThroughProbe,
	initialise,
	namedCache,
	openCommitSession,
	probeAnswer,
	putTestCache,
	resetTestServer,
	testPushIdExpiringAt,
	testPushIdFor,
	testV2PushIdFor,
	uploadMetadata,
	uploadPathNegotiation
} from '../test-support.ts';

import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { PathReadAuthorityService } from './path-read-authority-service.ts';

const builds = namedCache('builds');
const origin = requestOriginSchema.parse('https://cache.example');
const releasedPublicationSession = `${publicationCapability},${publicationRefusalReasonsCapability}`;
const capablePublicationSession = `${releasedPublicationSession},${cacheRemovedVerdictCapability}`;
const pushIdLifetimeSeconds = 24 * 60 * 60;
const rpcErrorBodySchema = z.object({
	defined: z.boolean(),
	code: z.string(),
	status: z.number(),
	message: z.string(),
	data: z.unknown()
});

// The test runtime's clock does not advance, so the removal happens in the
// millisecond in which the test starts. A push that started before it has a
// push ID issued a second earlier. Push IDs expire a fixed time after they are
// issued.
function pushIdIssuedBeforeNow(nonceFill: number) {
	return testPushIdFor(
		fixtureTenant,
		nonceFill,
		Math.floor(Date.now() / 1000) - 1 + pushIdLifetimeSeconds
	);
}

function pathFor(character: string): UploadPathNegotiation {
	return uploadPathNegotiation(
		uploadMetadata({ fileSize: 1, storePathHash: character.repeat(32) })
	);
}

function postJson(token: string, suffix: string, body: unknown) {
	return authorisedFetch(cacheScopedPath(builds, suffix), token, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

function planRequest(
	token: string,
	pushId: PushId,
	path: UploadPathNegotiation
) {
	return postJson(token, '/uploads/plan', { pushId, paths: [path] });
}

async function plannedEntry(
	token: string,
	pushId: PushId,
	path: UploadPathNegotiation
): Promise<PublicationEntry> {
	const response = await planRequest(token, pushId, path);
	const plan = uploadPlanResponseSchema.parse(await response.json());
	const [planned] = plan.uploads;
	if (planned === undefined) {
		throw new Error('expected a planned entry');
	}

	return {
		operationId: planned.operationId,
		cacheGeneration: plan.cacheGeneration,
		metadata: path
	};
}

// The entry that a plan made after the removal would return: the generation
// that the removal reached, which no cache has yet.
async function entryAfterRemoval(
	planned: PublicationEntry,
	pushId: PushId
): Promise<PublicationEntry> {
	const cacheGeneration = cacheGenerationSchema.parse(
		planned.cacheGeneration + 1
	);
	const identity = await publicationIdentity({
		tenant: fixtureTenant,
		cache: builds,
		cacheGeneration,
		pushId,
		metadata: planned.metadata
	});

	return { ...planned, operationId: identity.id, cacheGeneration };
}

function hasBuildsCache(): Promise<boolean> {
	return runInDurableObject(
		currentServer(),
		(instance) => instance.context.cacheRepository.resolve(builds) !== undefined
	);
}

function removeBuilds(token: string) {
	return authorisedFetch('/caches/builds?force=true', token, {
		method: 'DELETE'
	});
}

// When the server recorded the removal of `builds`, in milliseconds.
function buildsRemovedAt(): Promise<number> {
	return runInDurableObject(currentServer(), (instance) => {
		const removed = instance.context.db
			.select({ deletedAt: schema.cacheIdentities.deletedAt })
			.from(schema.cacheIdentities)
			.where(isNotNull(schema.cacheIdentities.deletedAt))
			.get();
		if (removed?.deletedAt == undefined) {
			throw new Error('expected a removed cache');
		}

		return Date.parse(removed.deletedAt);
	});
}

// Publication refusals are compared without their message.
function withoutMessage(frame: CommitSessionFrame) {
	if (frame.ev !== 'publication-refused') {
		return frame;
	}
	const { message: _message, ...facts } = frame;
	return facts;
}

const refusedRequests = [
	{
		route: 'uploads.plan',
		method: 'POST',
		suffix: '/uploads/plan',
		body: (pushId: PushId) => ({ pushId, paths: [pathFor('b')] })
	},
	{
		route: 'uploads.negotiate',
		method: 'POST',
		suffix: '/uploads',
		body: (pushId: PushId) => ({ pushId, paths: [pathFor('b')] })
	},
	{
		route: 'attestations.negotiate',
		method: 'POST',
		suffix: '/attestations',
		body: (pushId: PushId) => ({
			pushId,
			bundles: [{ storePathHash: 'b'.repeat(32), digest: 'f'.repeat(64) }]
		})
	},
	{
		route: 'attestations.negotiateBundles',
		method: 'POST',
		suffix: '/attestations/bundles',
		body: (pushId: PushId) => ({
			pushId,
			bundles: [{ digest: 'f'.repeat(64) }]
		})
	},
	{
		route: 'roots.set',
		method: 'PUT',
		suffix: '/roots/release',
		body: (pushId: PushId) => ({ pushId, targets: [] })
	},
	{
		route: 'roots.ensure',
		method: 'POST',
		suffix: '/roots/release/ensure',
		body: (pushId: PushId) => ({ pushId, targets: [pathFor('b').storePath] })
	},
	{
		route: 'roots.batch',
		method: 'POST',
		suffix: '/roots/batch',
		body: (pushId: PushId) => ({
			pushId,
			roots: [{ action: 'set', name: 'release', targets: [] }]
		})
	}
] as const;

describe('a push that started before its cache was removed', () => {
	beforeEach(async () => {
		await resetTestServer();
		const id = currentServer().id;
		ignoreAlarmDeliveries(id);
		onTestFinished(() => {
			deliverAlarms(id);
			vi.restoreAllMocks();
		});
	});

	it.each(refusedRequests)(
		'is refused by $route and does not create the cache again',
		async ({ method, suffix, body }) => {
			const token = await initialise();
			await putTestCache(token, builds);
			const pushId = await pushIdIssuedBeforeNow(1);
			await plannedEntry(token, pushId, pathFor('a'));
			await removeBuilds(token);

			const response = await authorisedFetch(
				cacheScopedPath(builds, suffix),
				token,
				{
					method,
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body(pushId))
				}
			);
			// The body is compared without its message.
			const { message: _message, ...refusal } = rpcErrorBodySchema.parse(
				await response.json()
			);

			expect({
				status: response.status,
				refusal,
				hasCache: await hasBuildsCache()
			}).toStrictEqual({
				status: StatusCodes.GONE,
				refusal: {
					defined: true,
					code: 'CACHE_REMOVED',
					status: StatusCodes.GONE,
					data: { cache: builds }
				},
				hasCache: false
			});
		}
	);

	it('refuses the confirmation of a plan made before the removal', async () => {
		const token = await initialise();
		await putTestCache(token, builds);
		const pushId = await pushIdIssuedBeforeNow(8);
		const path = pathFor('j');
		const planned = await plannedEntry(token, pushId, path);
		await removeBuilds(token);

		const response = await postJson(token, '/uploads/confirm-present', {
			cacheGeneration: planned.cacheGeneration,
			paths: [
				{
					storePathHash: path.storePathHash,
					storePath: path.storePath,
					narHash: path.narHash
				}
			]
		});
		const { message: _message, ...refusal } = rpcErrorBodySchema.parse(
			await response.json()
		);

		expect({
			status: response.status,
			refusal,
			hasCache: await hasBuildsCache()
		}).toStrictEqual({
			status: StatusCodes.GONE,
			refusal: {
				defined: true,
				code: 'CACHE_REMOVED',
				status: StatusCodes.GONE,
				data: { cache: builds }
			},
			hasCache: false
		});
	});

	it('refuses to attach an attestation bundle negotiated before the removal', async () => {
		const token = await initialise();
		await putTestCache(token, builds);
		const pushId = await pushIdIssuedBeforeNow(9);
		const negotiated = await postJson(token, '/attestations/bundles', {
			pushId,
			bundles: [{ digest: 'e'.repeat(64) }]
		});
		const { bundles } = attestationBundleNegotiateResponseSchema.parse(
			await negotiated.json()
		);
		const [bundle] = bundles;
		if (bundle === undefined) {
			throw new Error('expected a negotiated bundle');
		}
		await removeBuilds(token);

		const response = await postJson(
			token,
			`/attestations/bundles/${bundle.uploadId}/attach`,
			{ storePathHashes: ['k'.repeat(32)] }
		);
		const { message: _message, ...refusal } = rpcErrorBodySchema.parse(
			await response.json()
		);

		expect({
			status: response.status,
			refusal,
			hasCache: await hasBuildsCache()
		}).toStrictEqual({
			status: StatusCodes.GONE,
			refusal: {
				defined: true,
				code: 'CACHE_REMOVED',
				status: StatusCodes.GONE,
				data: { cache: builds }
			},
			hasCache: false
		});
	});

	it('reads one row to decide whether a name that was removed many times was removed after a push started', async () => {
		const token = await initialise();
		for (let removal = 0; removal < 5; removal += 1) {
			await putTestCache(token, builds);
			await removeBuilds(token);
		}

		const decided = await runInDurableObject(currentServer(), (instance) => {
			instance.context.dbCost.recordOutstanding();
			const before = instance.context.dbCost.rowsRead;
			const wasRemoved = instance.context.cacheRepository.wasDeletedSince(
				builds,
				new Date(Date.now() + 1)
			);
			instance.context.dbCost.recordOutstanding();

			return {
				wasRemoved,
				rowsRead: instance.context.dbCost.rowsRead - before
			};
		});

		expect(decided).toStrictEqual({ wasRemoved: false, rowsRead: 1 });
	});

	it.each([
		{
			pushId: 'a push ID issued to another tenant',
			issue: () => testPushIdFor('other-tenant', 10),
			expected: { status: StatusCodes.FORBIDDEN, hasCache: false }
		},
		{
			pushId: 'a push ID issued after the removal',
			issue: async () =>
				testPushIdExpiringAt(
					fixtureTenant,
					11,
					(await buildsRemovedAt()) + 1 + pushIdLifetimeSeconds * 1000
				),
			expected: { status: StatusCodes.OK, hasCache: true }
		}
	])('answers a root write with $pushId', async ({ issue, expected }) => {
		const token = await initialise();
		await putTestCache(token, builds);
		await removeBuilds(token);

		const response = await authorisedFetch(
			cacheScopedPath(builds, '/roots/release'),
			token,
			{
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ pushId: await issue(), targets: [] })
			}
		);

		expect({
			status: response.status,
			hasCache: await hasBuildsCache()
		}).toStrictEqual(expected);
	});

	it('lets a root write without a push ID create the cache again', async () => {
		const token = await initialise();
		await putTestCache(token, builds);
		await removeBuilds(token);

		const response = await authorisedFetch(
			cacheScopedPath(builds, '/roots/release'),
			token,
			{
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ targets: [] })
			}
		);

		expect({
			status: response.status,
			hasCache: await hasBuildsCache()
		}).toStrictEqual({ status: StatusCodes.OK, hasCache: true });
	});

	it('echoes push-root-writes to a credential request that accepts it', async () => {
		const token = await initialise();

		const response = await authorisedFetch(
			cacheScopedPath(builds, '/uploads/credential'),
			token,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					[acceptCapabilitiesHeader]: pushRootWritesCapability
				},
				body: '{}'
			}
		);

		expect({
			status: response.status,
			echoed: response.headers.get(uploadCapabilitiesHeader)
		}).toStrictEqual({
			status: StatusCodes.OK,
			echoed: pushRootWritesCapability
		});
	});

	it.each([
		{
			entry: 'an entry planned before the removal',
			isPlannedAfter: false,
			session: 'a session that accepts the reason',
			accepted: capablePublicationSession
		},
		{
			entry: 'an entry planned after the removal',
			isPlannedAfter: true,
			session: 'a session that accepts the reason',
			accepted: capablePublicationSession
		},
		{
			entry: 'an entry planned before the removal',
			isPlannedAfter: false,
			session: 'a session that does not accept the reason',
			accepted: releasedPublicationSession
		},
		{
			entry: 'an entry planned after the removal',
			isPlannedAfter: true,
			session: 'a session that does not accept the reason',
			accepted: releasedPublicationSession
		}
	])(
		'refuses $entry for $session and does not create the cache again',
		async ({ isPlannedAfter, accepted }) => {
			const token = await initialise();
			await putTestCache(token, builds);
			const pushId = await pushIdIssuedBeforeNow(2);
			const planned = await plannedEntry(token, pushId, pathFor('c'));
			await removeBuilds(token);
			const entry = isPlannedAfter
				? await entryAfterRemoval(planned, pushId)
				: planned;
			const session = await openCommitSession(token, builds, accepted);

			try {
				session.send({ op: 'publish-batch', pushId, entries: [entry] });
				const answer = await session.nextFrame();

				expect({
					answered: [answer, ...(await framesThroughProbe(session))].map(
						(frame) => withoutMessage(frame)
					),
					hasCache: await hasBuildsCache()
				}).toStrictEqual({
					answered: [
						accepted === capablePublicationSession
							? {
									ev: 'verdict',
									uploadId: entry.operationId,
									status: 'absent',
									reason: 'cache-removed'
								}
							: {
									ev: 'publication-refused',
									uploadId: entry.operationId,
									reason: 'generation-conflict',
									status: StatusCodes.CONFLICT
								},
						probeAnswer
					],
					hasCache: false
				});
			} finally {
				await closeSessionAndWait(session.socket);
			}
		}
	);

	it.each([
		{
			// The tenant's reference storage is writable, so the replaced check
			// would pass.
			point: 'after admission reads the generation',
			removeDuring: (remove: () => Promise<void>) =>
				vi
					.spyOn(PathReadAuthorityService.prototype, 'requireWritable')
					.mockImplementationOnce(remove)
		},
		{
			// The cache does not serve the path, so the probe would find nothing.
			point: 'during the servability probe',
			removeDuring: (remove: () => Promise<void>) =>
				vi
					.spyOn(NarInfoObjectsService.prototype, 'servableStorePathHashes')
					.mockImplementationOnce(async () => {
						await remove();

						return new Set();
					})
		}
	])(
		'refuses an entry with the removal when the cache is removed $point',
		async ({ removeDuring }) => {
			const token = await initialise();
			await putTestCache(token, builds);
			const pushId = await pushIdIssuedBeforeNow(4);
			const entry = await plannedEntry(token, pushId, pathFor('g'));
			await runInDurableObject(currentServer(), (instance) => {
				removeDuring(() => instance.runCacheTeardown(builds, origin));
			});
			const session = await openCommitSession(
				token,
				builds,
				capablePublicationSession
			);

			try {
				session.send({ op: 'publish-batch', pushId, entries: [entry] });
				const answer = await session.nextFrame();

				expect({
					answered: [answer, ...(await framesThroughProbe(session))],
					hasCache: await hasBuildsCache()
				}).toStrictEqual({
					answered: [
						{
							ev: 'verdict',
							uploadId: entry.operationId,
							status: 'absent',
							reason: 'cache-removed'
						},
						probeAnswer
					],
					hasCache: false
				});
			} finally {
				await closeSessionAndWait(session.socket);
			}
		}
	);

	it('refuses the confirmation of a plan made before an earlier removal of the name', async () => {
		const token = await initialise();
		await putTestCache(token, builds);
		const pushId = await pushIdIssuedBeforeNow(12);
		const path = pathFor('m');
		const planned = await plannedEntry(token, pushId, path);
		await removeBuilds(token);
		await putTestCache(token, builds);
		await removeBuilds(token);

		const response = await postJson(token, '/uploads/confirm-present', {
			cacheGeneration: planned.cacheGeneration,
			paths: [
				{
					storePathHash: path.storePathHash,
					storePath: path.storePath,
					narHash: path.narHash
				}
			]
		});
		const { message: _message, ...refusal } = rpcErrorBodySchema.parse(
			await response.json()
		);

		expect({ status: response.status, refusal }).toStrictEqual({
			status: StatusCodes.GONE,
			refusal: {
				defined: true,
				code: 'CACHE_REMOVED',
				status: StatusCodes.GONE,
				data: { cache: builds }
			}
		});
	});

	it.each([
		{
			pushId: 'a v3 push ID issued in the millisecond before the removal',
			isRefused: true,
			issue: (removedAt: number) =>
				testPushIdExpiringAt(
					fixtureTenant,
					5,
					removedAt - 1 + pushIdLifetimeSeconds * 1000
				)
		},
		{
			pushId: 'a v3 push ID issued in the millisecond of the removal',
			isRefused: false,
			issue: (removedAt: number) =>
				testPushIdExpiringAt(
					fixtureTenant,
					6,
					removedAt + pushIdLifetimeSeconds * 1000
				)
		},
		{
			pushId: 'a v2 push ID issued in the second of the removal',
			isRefused: true,
			issue: (removedAt: number) =>
				testV2PushIdFor(
					fixtureTenant,
					7,
					Math.floor(removedAt / 1000) + pushIdLifetimeSeconds
				)
		}
	])(
		'decides whether $pushId started before the removal',
		async ({ isRefused, issue }) => {
			const token = await initialise();
			await putTestCache(token, builds);
			await removeBuilds(token);
			const pushId = await issue(await buildsRemovedAt());

			const response = await planRequest(token, pushId, pathFor('h'));

			// A plan does not create the cache, whether or not it is refused.
			expect({
				status: response.status,
				hasCache: await hasBuildsCache()
			}).toStrictEqual({
				status: isRefused ? StatusCodes.GONE : StatusCodes.OK,
				hasCache: false
			});
		}
	);

	it('lets a push whose credential was issued right after the removal create the cache again', async () => {
		const token = await initialise();
		await putTestCache(token, builds);
		await removeBuilds(token);
		const credential = await postJson(token, '/uploads/credential', {});
		const { pushId } = pushCredentialSchema.parse(await credential.json());
		const entry = await plannedEntry(token, pushId, pathFor('d'));
		const session = await openCommitSession(
			token,
			builds,
			capablePublicationSession
		);

		try {
			session.send({ op: 'publish-batch', pushId, entries: [entry] });
			const accepted = await session.nextFrame();
			const required = await session.nextFrame();

			expect({
				answered: [accepted, required],
				hasCache: await hasBuildsCache()
			}).toStrictEqual({
				answered: [
					{ ev: 'publication-accepted', uploadId: entry.operationId },
					{ ev: 'upload-required', uploadId: entry.operationId }
				],
				hasCache: true
			});
		} finally {
			await closeSessionAndWait(session.socket);
		}
	});
});
