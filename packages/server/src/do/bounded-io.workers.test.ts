import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SubrequestTimeoutError, UnboundableIoError } from '../errors.ts';
import { OidcDiscoveryStore } from '../oidc/oidc.ts';
import { currentServer, initialise, resetTestServer } from '../test-support.ts';

import { boundedBlobs, boundedD1 } from './bounded-io.ts';

describe('bounded gated subrequest', () => {
	beforeEach(resetTestServer);

	it('times out a hung gated R2 call and keeps the object alive', async () => {
		await initialise();
		const server = currentServer();

		// An in-memory marker whose survival proves the instance was not reset: the
		// runtime replaces a broken object, and a fresh instance builds a fresh
		// discovery store.
		const marker = new OidcDiscoveryStore();
		await runInDurableObject(server, (instance) => {
			instance.context.discovery = marker;
			instance.context.gateBudgetMs = 100;
		});

		const hang = vi
			.spyOn(env.BLOBS, 'delete')
			.mockImplementation(() => Promise.race([]));

		let rejection: unknown;
		try {
			await runInDurableObject(server, (instance) =>
				instance.context.criticalSection(() =>
					instance.context.env.BLOBS.delete('gated-key')
				)
			);
		} catch (error) {
			rejection = error;
		} finally {
			hang.mockRestore();
		}

		const afterTimeout = await runInDurableObject(server, (instance) =>
			instance.context.criticalSection(() => Promise.resolve('ok'))
		);
		const isSameInstance = await runInDurableObject(
			server,
			(instance) => instance.context.discovery === marker
		);

		expect({
			timedOut: rejection instanceof SubrequestTimeoutError,
			isSameInstance,
			afterTimeout
		}).toStrictEqual({
			timedOut: true,
			isSameInstance: true,
			afterTimeout: 'ok'
		});
	});
});

describe('unboundable members', () => {
	it('refuses an R2 multipart handle through the bounded bucket', () => {
		const blobs = boundedBlobs(env.BLOBS);

		expect(() => blobs.createMultipartUpload('unbounded-key')).toThrow(
			UnboundableIoError
		);
		expect(() =>
			blobs.resumeMultipartUpload('unbounded-key', 'upload-id')
		).toThrow(UnboundableIoError);
	});

	it('refuses a D1 session through the bounded database', () => {
		const database = boundedD1(env.CUPBOARD_DB);

		expect(() => database.withSession()).toThrow(UnboundableIoError);
	});
});
