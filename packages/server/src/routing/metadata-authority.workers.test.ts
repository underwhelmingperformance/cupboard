import {
	type AuthKeyId,
	type CacheAccessMode
} from '@cupboard/nix-store/scalars';
import { authKeyListResponseSchema } from '@cupboard/protocol/keys';
import {
	readTokenBasicUser,
	readTokenPasswordPrefix
} from '@cupboard/protocol/read-access';
import { reuseViewNameSchema } from '@cupboard/protocol/reuse-views';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import {
	createExecutionContext,
	runInDurableObject,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accessJwtClockToleranceSeconds } from '../auth/auth.ts';
import * as schema from '../db/schema.ts';
import { committedPath, setView } from '../do/reuse-view-read.test-support.ts';
import { type CupboardServer } from '../do/server.ts';
import {
	authorisedWorkerFetch,
	currentOrigin,
	defaultCache,
	fixtureReaderAuthorization,
	fixtureWorkerServer,
	initialiseViaWorker,
	issueWorkerSignedToken,
	namedCache,
	provisionFixtureReader,
	provisionFixtureTenant,
	readFetch,
	recordTransition,
	resetTestServer
} from '../test-support.ts';
import worker from '../worker.ts';

import { tenantReadFetch } from './tenant-read-handler.ts';
import { fixtureTenant } from './tenant-routing.test-support.ts';

type Source = 'default' | 'named' | 'reuse';
type Mutation = (instance?: CupboardServer) => Promise<void>;

const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
const sources: readonly Source[] = ['default', 'named', 'reuse'];

// `issueWorkerSignedToken` issues a token for ten minutes.
const tokenLifetimeMs = 600_000;
const expiredBeforeReadMs = 15_000;
const stringMatcher: unknown = expect.any(String);

async function retireSigningKey(
	server: CupboardServer,
	kid: AuthKeyId
): Promise<void> {
	server.context.db
		.update(schema.authKeys)
		.set({ scheduledRetireAt: now })
		.where(eq(schema.authKeys.kid, kid))
		.run();
	await server.runAuthKeyRetirement();
}

async function sourcePath(
	source: Source,
	seed: string,
	access: CacheAccessMode = 'private'
) {
	const cache = source === 'default' ? defaultCache() : namedCache('builds');
	const path = await committedPath(seed, cache, { access });
	if (source === 'reuse') {
		await setView([{ kind: 'named', name: 'builds' }], 'reuse', access);
	}
	return {
		cache,
		path,
		prefix:
			source === 'default'
				? ''
				: source === 'named'
					? '/cache/builds'
					: '/reuse/reuse'
	};
}

async function readDuringMutation(
	source: Source,
	prefix: string,
	storePath: string,
	authorization: string,
	mutate: Mutation
): Promise<{ response: Response; mutations: number }> {
	let mutations = 0;
	const change: Mutation = async (instance) => {
		mutations += 1;
		await mutate(instance);
	};
	const request = {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization
		},
		body: JSON.stringify({ storePaths: [storePath] })
	};
	if (source === 'reuse') {
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const head = instance.context.env.BLOBS.head.bind(
				instance.context.env.BLOBS
			);
			vi.spyOn(instance.context.env.BLOBS, 'head').mockImplementationOnce(
				async (...arguments_) => {
					const object = await head(...arguments_);
					await change(instance);
					return object;
				}
			);
		});
		try {
			return {
				response: await readFetch(`${prefix}/api/v1/path-info`, request),
				mutations
			};
		} finally {
			await runInDurableObject(fixtureWorkerServer(), () =>
				vi.restoreAllMocks()
			);
		}
	}
	const get = env.BLOBS.get.bind(env.BLOBS);
	const blobs = new Proxy(env.BLOBS, {
		get(target, key, receiver): unknown {
			if (key === 'get') {
				return async (...arguments_: Parameters<typeof get>) => {
					const object = await get(...arguments_);
					await change();
					return object;
				};
			}
			return Reflect.get(target, key, receiver);
		}
	});
	const context = createExecutionContext();
	const overridden = new Proxy(env, {
		get(target, key, receiver): unknown {
			if (key === 'BLOBS') {
				return blobs;
			}
			if (key === 'CUPBOARD_TENANT') {
				return {
					async fetch(request: Request): Promise<Response> {
						const response = await tenantReadFetch(request, env, context);
						await change();
						return response;
					}
				};
			}
			return Reflect.get(target, key, receiver);
		}
	});
	const response = await worker.fetch(
		new Request<unknown, IncomingRequestCfProperties>(
			`${currentOrigin()}/t/${fixtureTenant}${prefix}/api/v1/path-info`,
			request
		),
		overridden,
		context
	);
	await waitOnExecutionContext(context);
	return { response, mutations };
}

async function expectRefusal(result: {
	response: Response;
	mutations: number;
}): Promise<void> {
	expect({
		status: result.response.status,
		cacheControl: result.response.headers.get('cache-control'),
		body: await result.response.text(),
		mutations: result.mutations
	}).toStrictEqual({
		status: StatusCodes.UNAUTHORIZED,
		cacheControl: 'no-store',
		body: stringMatcher,
		mutations: 1
	});
}

describe('buffered metadata authority', () => {
	beforeEach(async () => {
		await resetTestServer();
		await recordTransition('cache-identity', 'complete');
	});
	afterEach(() => vi.useRealTimers());

	it.each(sources)(
		'returns public %s metadata after removing the supplied credential during storage reads',
		async (source) => {
			const { path, prefix } = await sourcePath(
				source,
				`authority-public-${source}`,
				'public'
			);
			await provisionFixtureTenant();
			await provisionFixtureReader();
			const original = await readFetch(
				`${prefix}/${path.storePathHash}.narinfo`
			);
			const narinfo = await original.text();
			const result = await readDuringMutation(
				source,
				prefix,
				path.storePath,
				fixtureReaderAuthorization,
				() =>
					runInDurableObject(fixtureWorkerServer(), (instance) => {
						instance.context.db.delete(schema.accessKeys).run();
					})
			);
			expect({
				status: result.response.status,
				cacheControl: result.response.headers.get('cache-control'),
				body: await result.response.json(),
				mutations: result.mutations
			}).toStrictEqual({
				status: StatusCodes.OK,
				cacheControl: 'no-store',
				body: {
					scopeVersion: stringMatcher,
					entries: [{ storePath: path.storePath, status: 'found', narinfo }]
				},
				mutations: 1
			});
		}
	);

	it.each(
		sources.flatMap((source) =>
			['expire', 'retire'].map((change) => [source, change] as const)
		)
	)(
		'refuses %s metadata after a change to read token authority (%s) during storage reads',
		async (source, change) => {
			const { cache, path, prefix } = await sourcePath(
				source,
				`authority-token-${source}-${change}`
			);
			// The read deadline ends a probe long before a fresh token expires. The
			// expiring token has therefore passed its expiry when the read starts,
			// but it is still inside the clock tolerance. Moving the clock past the
			// tolerance then takes less than the read's deadline.
			const issuedAt = new Date(
				change === 'expire'
					? Date.now() - tokenLifetimeMs - expiredBeforeReadMs
					: Date.now()
			);
			const token = await issueWorkerSignedToken(
				[
					source === 'reuse'
						? {
								type: 'cupboard_view',
								view: reuseViewNameSchema.parse('reuse'),
								actions: ['view:content-read']
							}
						: { type: 'cupboard_cache', cache, actions: ['cache:content-read'] }
				],
				undefined,
				issuedAt
			);
			const admin = await initialiseViaWorker();
			const keys = await authorisedWorkerFetch('/keys/auth', admin);
			const original = authKeyListResponseSchema
				.parse(await keys.json())
				.keys.find((key) => key.active);
			if (original === undefined) {
				throw new Error('The token must have an active signing key');
			}
			const rotated = await authorisedWorkerFetch('/keys/auth/rotate', admin, {
				method: 'POST'
			});
			expect(rotated.status).toBe(StatusCodes.OK);
			const expiresAfter = new Date(
				Date.now() +
					accessJwtClockToleranceSeconds * 1000 -
					expiredBeforeReadMs +
					1000
			);
			await expectRefusal(
				await readDuringMutation(
					source,
					prefix,
					path.storePath,
					`Basic ${btoa(`${readTokenBasicUser}:${readTokenPasswordPrefix}${token}`)}`,
					async (instance) => {
						if (change === 'expire') {
							vi.useFakeTimers({ toFake: ['Date'] });
							vi.setSystemTime(expiresAfter);
							return;
						}
						if (instance !== undefined) {
							await retireSigningKey(instance, original.kid);
							return;
						}
						await runInDurableObject(fixtureWorkerServer(), (server) =>
							retireSigningKey(server, original.kid)
						);
					}
				)
			);
		}
	);
});
