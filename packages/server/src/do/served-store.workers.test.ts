import { servedStoreDirectory } from '@cupboard/nix-store/cache-info';
import { graceSecondsSchema } from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { asc, eq } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	authorisedFetch,
	currentServer,
	defaultCache,
	initialise,
	narBytes,
	pushPath,
	resetTestServer,
	resolvedCache,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation
} from '../test-support.ts';

const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
const served = metadata.storePath;
const hash = metadata.storePathHash;

// A path this cache could never serve: the same basename, a different store.
const foreignStores = [
	{ name: 'a home directory store', directory: '/home/laney/nixstore' },
	{ name: 'a deeply nested store', directory: '/var/lib/cupboard/nix/store' }
];

function foreignPath(directory: string): string {
	return `${directory}/${hash}-first`;
}

function jsonPost(
	pathname: string,
	token: string,
	body: unknown
): Promise<Response> {
	return authorisedFetch(pathname, token, {
		body: JSON.stringify(body),
		headers: { 'content-type': 'application/json' },
		method: 'POST'
	});
}

function jsonPut(
	pathname: string,
	token: string,
	body: unknown
): Promise<Response> {
	return authorisedFetch(pathname, token, {
		body: JSON.stringify(body),
		headers: { 'content-type': 'application/json' },
		method: 'PUT'
	});
}

// A second path, so that one negotiate can include a served and a foreign
// path.
const foreign = uploadMetadata({
	fileSize: narBytes.byteLength,
	storePathHash: '22222222222222222222222222222222',
	name: 'foreign'
});

interface RetentionState {
	readonly roots: readonly {
		readonly name: string;
		readonly expiresAt: string | null;
		readonly updatedAt: string;
	}[];
	readonly targets: readonly {
		readonly rootName: string;
		readonly storePath: string;
	}[];
	readonly grace: readonly {
		readonly storePathHash: string;
		readonly retainUntil: string;
	}[];
	readonly pendingUploads: readonly { readonly id: string }[];
}

/**
 * Reads the rows that a negotiate or a root write can change: the retention
 * roots and their targets, the grace deadlines, and the pending uploads.
 */
function retentionState(): Promise<RetentionState> {
	return runInDurableObject(currentServer(), (instance) => {
		const { db } = instance.context;

		return {
			roots: db
				.select({
					name: schema.retentionRoots.name,
					expiresAt: schema.retentionRoots.expiresAt,
					updatedAt: schema.retentionRoots.updatedAt
				})
				.from(schema.retentionRoots)
				.orderBy(asc(schema.retentionRoots.name))
				.all(),
			targets: db
				.select({
					rootName: schema.retentionRootTargets.rootName,
					storePath: schema.retentionRootTargets.storePath
				})
				.from(schema.retentionRootTargets)
				.orderBy(
					asc(schema.retentionRootTargets.rootName),
					asc(schema.retentionRootTargets.storePath)
				)
				.all(),
			grace: db
				.select({
					storePathHash: schema.retentionGrace.storePathHash,
					retainUntil: schema.retentionGrace.retainUntil
				})
				.from(schema.retentionGrace)
				.orderBy(asc(schema.retentionGrace.storePathHash))
				.all(),
			pendingUploads: db
				.select({ id: schema.pendingUploads.id })
				.from(schema.pendingUploads)
				.orderBy(asc(schema.pendingUploads.id))
				.all()
		};
	});
}

async function setDefaultCacheGrace(graceSeconds: number): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		const cache = resolvedCache(instance.context, defaultCache());

		instance.context.db
			.update(schema.cacheIdentities)
			.set({ graceSeconds: graceSecondsSchema.parse(graceSeconds) })
			.where(eq(schema.cacheIdentities.id, cache.id))
			.run();
	});
}

function negotiateBody(storePath: string): unknown {
	return {
		pushId: testPushId,
		paths: [{ ...uploadPathNegotiation(metadata), storePath }]
	};
}

describe('paths from another store directory', () => {
	beforeEach(resetTestServer);

	it('accepts a negotiate and a preview naming a path in the served store', async () => {
		const token = await initialise();

		const negotiate = await jsonPost('/uploads', token, negotiateBody(served));
		const preview = await jsonPost('/uploads/preview', token, {
			paths: [uploadPathNegotiation(metadata)]
		});

		expect({
			servedStore: served.startsWith(`${servedStoreDirectory}/`),
			negotiate: negotiate.status,
			preview: preview.status
		}).toStrictEqual({
			servedStore: true,
			negotiate: StatusCodes.OK,
			preview: StatusCodes.OK
		});
	});

	it.each(foreignStores)(
		'refuses a negotiate and a preview naming a path in $name',
		async ({ directory }) => {
			const token = await initialise();
			const storePath = foreignPath(directory);

			const negotiate = await jsonPost(
				'/uploads',
				token,
				negotiateBody(storePath)
			);
			const preview = await jsonPost('/uploads/preview', token, {
				paths: [{ ...uploadPathNegotiation(metadata), storePath }]
			});

			expect({
				negotiate: negotiate.status,
				preview: preview.status
			}).toStrictEqual({
				negotiate: StatusCodes.BAD_REQUEST,
				preview: StatusCodes.BAD_REQUEST
			});
		}
	);

	it.each(foreignStores)(
		'refuses setting and ensuring a root over a target in $name',
		async ({ directory }) => {
			const token = await initialise();
			await pushPath(token, metadata);
			const targets = [foreignPath(directory)];

			const set = await jsonPut('/roots/ci', token, { targets });
			const ensure = await jsonPost('/roots/ci/ensure', token, {
				targets
			});

			expect({ set: set.status, ensure: ensure.status }).toStrictEqual({
				set: StatusCodes.BAD_REQUEST,
				ensure: StatusCodes.BAD_REQUEST
			});
		}
	);

	it.each(foreignStores)(
		'changes no retention state when a negotiate also includes a path in $name',
		async ({ directory }) => {
			const token = await initialise();
			await pushPath(token, metadata);
			await setDefaultCacheGrace(3600);
			const before = await retentionState();

			// The served path is already published, so an accepted negotiate would
			// extend its grace and attach it to the run root.
			const negotiate = await jsonPost('/uploads', token, {
				pushId: testPushId,
				paths: [
					uploadPathNegotiation(metadata),
					{
						...uploadPathNegotiation(foreign),
						storePath: `${directory}/${foreign.storePathHash}-foreign`
					}
				],
				attachRoot: { name: 'ci/run-1' }
			});
			await negotiate.text();

			expect({
				status: negotiate.status,
				state: await retentionState()
			}).toStrictEqual({ status: StatusCodes.BAD_REQUEST, state: before });
		}
	);

	it.each(
		foreignStores.flatMap((store) => [
			{ ...store, write: 'set', send: jsonPut, pathname: '/roots/ci' },
			{
				...store,
				write: 'ensure',
				send: jsonPost,
				pathname: '/roots/ci/ensure'
			}
		])
	)(
		'changes no retention state when a root $write includes a target in $name',
		async ({ directory, send, pathname }) => {
			const token = await initialise();
			await pushPath(token, metadata);
			await jsonPut('/roots/ci', token, { targets: [served] });
			const before = await retentionState();

			// The foreign target has the served path's hash, so an accepted write
			// would replace the root's target with the foreign path.
			const response = await send(pathname, token, {
				targets: [foreignPath(directory)]
			});
			await response.text();

			expect({
				status: response.status,
				state: await retentionState()
			}).toStrictEqual({ status: StatusCodes.BAD_REQUEST, state: before });
		}
	);

	it('still sets a root over a target in the served store', async () => {
		const token = await initialise();
		await pushPath(token, metadata);

		const set = await jsonPut('/roots/ci', token, {
			targets: [served]
		});

		expect(set.status).toBe(StatusCodes.OK);
	});
});
