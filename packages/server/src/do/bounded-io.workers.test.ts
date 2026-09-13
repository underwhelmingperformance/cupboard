import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SubrequestTimeoutError, UnboundableIoError } from '../errors.ts';
import { OidcDiscoveryStore } from '../oidc/oidc.ts';
import { currentServer, initialise, resetTestServer } from '../test-support.ts';

import { boundedBlobs, boundedD1, boundedWorkerEnv } from './bounded-io.ts';
import { withDeadlineBudget } from './deadline.ts';
import { hasSubrequestsFor, withSubrequestSlice } from './subrequest-slice.ts';

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

describe('bounded Worker environment', () => {
	it('counts Worker D1 and R2 calls in the same slice', async () => {
		const worker = boundedWorkerEnv(env);
		const isRemaining = await withSubrequestSlice(
			async () => {
				await worker.CUPBOARD_DB.prepare('SELECT 1').first();
				await worker.BLOBS.head('missing-key');

				return hasSubrequestsFor(1);
			},
			{ subrequests: 2, reserve: 0 }
		);

		expect(isRemaining).toBe(false);
	});

	// The deadline is the test's own. The 15-second figure a Worker applies is
	// not exercised here.
	it('times out a hung R2 head and serves the other bindings as they are', async () => {
		const hang = vi
			.spyOn(env.BLOBS, 'head')
			.mockImplementation(() => Promise.race([]));
		const worker = boundedWorkerEnv(env);

		let rejection: unknown;
		try {
			await withDeadlineBudget(100, () => worker.BLOBS.head('hung-key'));
		} catch (error) {
			rejection = error;
		} finally {
			hang.mockRestore();
		}

		expect({
			timedOut: rejection instanceof SubrequestTimeoutError,
			isSameCronState: worker.CRON_STATE === env.CRON_STATE
		}).toStrictEqual({ timedOut: true, isSameCronState: true });
	});
});

describe('subrequest accounting', () => {
	// One D1 batch is one call to the platform, however many statements it
	// carries, and the slice refuses nothing: the batch runs although it spends
	// the slice's only call.
	it('spends one subrequest for a D1 batch', async () => {
		const database = boundedD1(env.CUPBOARD_DB);
		const select = database.prepare('SELECT 1');

		const answers = await withSubrequestSlice(
			async () => {
				const isBefore = hasSubrequestsFor(1);
				const results = await database.batch([select, select]);

				return {
					before: isBefore,
					after: hasSubrequestsFor(1),
					statementsRun: results.length
				};
			},
			{ subrequests: 1, reserve: 0 }
		);

		expect(answers).toStrictEqual({
			before: true,
			after: false,
			statementsRun: 2
		});
	});
});
