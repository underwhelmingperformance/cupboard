import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SubrequestTimeoutError } from '../errors.ts';
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

describe('bounded multipart uploads', () => {
	it.each(['create', 'resume'] as const)(
		'counts every request through a %s handle and preserves complete bytes',
		async (mode) => {
			const key = `bounded-multipart-${mode}`;
			const original =
				mode === 'resume'
					? await env.BLOBS.createMultipartUpload(key)
					: undefined;
			const first = new Uint8Array(5 * 1024 * 1024).fill(17);
			const last = new Uint8Array(3 * 1024 * 1024).fill(29);
			const expected = new Uint8Array(first.byteLength + last.byteLength);
			expected.set(first);
			expected.set(last, first.byteLength);
			const blobs = boundedBlobs(env.BLOBS);
			const result = await withSubrequestSlice(
				async () => {
					const upload =
						original === undefined
							? await blobs.createMultipartUpload(key)
							: blobs.resumeMultipartUpload(key, original.uploadId);
					const parts = [
						await upload.uploadPart(1, first),
						await upload.uploadPart(2, last)
					];
					const object = await upload.complete(parts);
					return {
						key: object.key,
						size: object.size,
						parts: parts.map((part) => part.partNumber),
						hasRemaining: hasSubrequestsFor(1)
					};
				},
				{ subrequests: mode === 'create' ? 4 : 3, reserve: 0 }
			);
			const stored = await env.BLOBS.get(key);
			if (stored === null) {
				throw new Error('The completed multipart object is missing');
			}
			const actualDigest = new Uint8Array(
				await crypto.subtle.digest('SHA-256', await stored.arrayBuffer())
			);
			const expectedDigest = new Uint8Array(
				await crypto.subtle.digest('SHA-256', expected)
			);
			expect({ result, digest: actualDigest }).toStrictEqual({
				result: {
					key,
					size: expected.byteLength,
					parts: [1, 2],
					hasRemaining: false
				},
				digest: expectedDigest
			});
			await env.BLOBS.delete(key);
		}
	);

	it.each(['uploadPart', 'complete', 'abort'] as const)(
		'times out a hung %s within the collective deadline and counts the call',
		async (member) => {
			const native = await env.BLOBS.createMultipartUpload(
				`hung-multipart-${member}`
			);
			const stalled = new Proxy(native, {
				get(target, property) {
					if (property === member) {
						return () => Promise.race([]);
					}
					const value: unknown = Reflect.get(target, property, target);
					return typeof value === 'function'
						? (...arguments_: unknown[]): unknown =>
								Reflect.apply(value, target, arguments_)
						: value;
				}
			});
			const resume = vi
				.spyOn(env.BLOBS, 'resumeMultipartUpload')
				.mockReturnValue(stalled);
			try {
				const upload = boundedBlobs(env.BLOBS).resumeMultipartUpload(
					native.key,
					native.uploadId
				);
				const operations: Record<typeof member, () => Promise<unknown>> = {
					uploadPart: () => upload.uploadPart(1, 'part'),
					complete: () => upload.complete([]),
					abort: () => upload.abort()
				};
				const result = await withSubrequestSlice(
					async () => {
						let rejection: unknown;
						try {
							await withDeadlineBudget(100, operations[member]);
						} catch (error: unknown) {
							rejection = error;
						}
						return {
							subrequest:
								rejection instanceof SubrequestTimeoutError
									? rejection.subrequest
									: undefined,
							hasRemaining: hasSubrequestsFor(1)
						};
					},
					{ subrequests: 1, reserve: 0 }
				);
				expect(result).toStrictEqual({
					subrequest: `r2.${member}`,
					hasRemaining: false
				});
			} finally {
				resume.mockRestore();
				await native.abort();
			}
		}
	);

	it('counts creation and abort without publishing an object', async () => {
		const blobs = boundedBlobs(env.BLOBS);
		const hasRemaining = await withSubrequestSlice(
			async () => {
				const upload = await blobs.createMultipartUpload('bounded-abort');
				await upload.abort();
				return hasSubrequestsFor(1);
			},
			{ subrequests: 2, reserve: 0 }
		);
		expect({
			hasRemaining,
			isPublished: (await env.BLOBS.head('bounded-abort')) !== null
		}).toStrictEqual({ hasRemaining: false, isPublished: false });
	});
});

describe('bounded D1 sessions', () => {
	it('bounds and counts a primary D1 session', async () => {
		const session = boundedD1(env.CUPBOARD_DB).withSession('first-primary');
		const result = await withSubrequestSlice(
			async () => {
				const row = await session.prepare('SELECT 1 AS value').first();
				return { row, remaining: hasSubrequestsFor(1) };
			},
			{ subrequests: 1, reserve: 0 }
		);

		expect(result).toStrictEqual({ row: { value: 1 }, remaining: false });
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
