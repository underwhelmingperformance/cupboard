import { startCapture } from '@cupboard/logger/testing';
import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { committedPath } from '../do/reuse-view-read.test-support.ts';
import { attestationListObjectKey, narInfoObjectKey } from '../http/http.ts';
import {
	passThrough,
	stalledBody,
	streamRecords
} from '../http/stalled-body.test-support.ts';
import { readRequestBudgetMs } from '../policy/streaming.ts';
import {
	defaultCache,
	initialiseViaWorker,
	provisionFixtureTenant,
	readFetch,
	recordTransition,
	resetTestServer
} from '../test-support.ts';

import { fixtureTenant } from './tenant-routing.test-support.ts';

const reader = { user: 'alice', password: 'secret' };
const credentials = `Basic ${btoa(`${reader.user}:${reader.password}`)}`;
const sentBytes = 4;

// The control Worker gives each request an ID, which differs on every request.
const variableFields = ['requestId'];

/**
A bucket whose read of `key` returns a body that delivers `sentBytes` bytes
and then stalls. `stalled` resolves when the read has returned that body.
*/
function stallingReadOf(
	bucket: R2Bucket,
	key: string
): { readonly blobs: R2Bucket; readonly stalled: Promise<undefined> } {
	const stalled = Promise.withResolvers<undefined>();
	const blobs = new Proxy(bucket, {
		get(target, property) {
			if (property !== 'get') {
				return passThrough(target, property);
			}

			return async (read: string, options?: R2GetOptions) => {
				const object = await target.get(read, options);

				if (read !== key || object === null || !('body' in object)) {
					return object;
				}

				await object.body.cancel();
				const body = await stalledBody(sentBytes);
				stalled.resolve(undefined);

				return new Proxy(object, {
					get(stored, member) {
						return member === 'body' ? body : passThrough(stored, member);
					}
				});
			};
		}
	});

	return { blobs, stalled: stalled.promise };
}

interface StoredProbe {
	readonly key: string;
	readonly init: RequestInit;
}

interface ProbeRoute {
	readonly name: string;
	readonly path: string;
	readonly operation: string;
	readonly store: () => Promise<StoredProbe>;
}

const probes: readonly ProbeRoute[] = [
	{
		name: 'the path-info probe of a private cache',
		path: '/api/v1/path-info',
		operation: 'path-info.body',
		store: async () => {
			await initialiseViaWorker();
			await provisionFixtureTenant({ read: reader });
			const path = await committedPath('stalled-path-info', defaultCache(), {
				access: 'private'
			});

			return {
				key: narInfoObjectKey(
					fixtureTenant,
					storePathHashSchema.parse(path.storePathHash),
					defaultCache()
				),
				init: {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						authorization: credentials
					},
					body: JSON.stringify({ storePaths: [path.storePath] })
				}
			};
		}
	},
	{
		name: 'the attestation-info probe',
		path: '/api/v1/attestation-info',
		operation: 'attestation-info.body',
		store: async () => {
			const path = await committedPath(
				'stalled-attestation-info',
				defaultCache()
			);
			const key = attestationListObjectKey(
				fixtureTenant,
				storePathHashSchema.parse(path.storePathHash),
				defaultCache()
			);
			await env.BLOBS.put(key, JSON.stringify({ attestations: [] }));

			return {
				key,
				init: {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ storePathHashes: [path.storePathHash] })
				}
			};
		}
	}
];

async function storedSize(key: string): Promise<number> {
	const object = await env.BLOBS.head(key);

	if (object === null) {
		throw new TypeError(`${key} is not stored`);
	}

	return object.size;
}

describe('a read probe whose R2 body stalls', () => {
	beforeEach(async () => {
		await resetTestServer();
		await recordTransition('cache-identity', 'complete');
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it.each(probes)(
		'refuses $name retryably at the read deadline',
		async (probe) => {
			const { key, init } = await probe.store();
			const size = await storedSize(key);
			const { blobs, stalled } = stallingReadOf(env.BLOBS, key);
			const capture = startCapture();
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

			try {
				const responding = readFetch(probe.path, init, { BLOBS: blobs });
				await stalled;
				await vi.advanceTimersByTimeAsync(readRequestBudgetMs);
				const response = await responding;

				expect({
					status: response.status,
					retryAfter: response.headers.get('retry-after'),
					cacheControl: response.headers.get('cache-control'),
					records: streamRecords(capture.logs, variableFields)
				}).toStrictEqual({
					status: StatusCodes.SERVICE_UNAVAILABLE,
					retryAfter: '5',
					cacheControl: 'no-store',
					records: [
						{
							level: 'warning',
							category: ['cupboard', 'storage', 'stream'],
							message: 'response body deadline passed',
							properties: {
								requestId: 'string',
								operation: probe.operation,
								objectKey: key,
								length: size,
								deadlineMs: readRequestBudgetMs
							}
						}
					]
				});
			} finally {
				capture.stop();
			}
		}
	);
});
