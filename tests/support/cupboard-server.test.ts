import childProcess, { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { Miniflare } from 'miniflare';
import { expect, it, onTestFinished, vi } from 'vitest';

import {
	CupboardTestServer,
	CupboardTestServerStartError,
	TenantProvisionFailedError
} from './cupboard-server.ts';
import { withTemporaryDirectory } from './filesystem.ts';
import { StubOidcIssuer } from './oidc-issuer.ts';
import { TestD1Database } from './worker-bindings.ts';

const failureCases = (
	['runtime-start', 'database-migrations', 'tenant-provisioning'] as const
).flatMap((stage) => [
	{ stage, cleanupFails: false },
	{ stage, cleanupFails: true }
]);

it.each(failureCases)(
	'cleans up failed $stage and preserves its cause when cleanup fails: $cleanupFails',
	async ({ stage, cleanupFails }) => {
		const cause = new TypeError('fetch failed', {
			cause: new Error('other side closed')
		});
		const cleanupError = new Error('issuer cleanup failed');
		const workerCleanupError = new Error('worker cleanup failed');
		const issuer = await StubOidcIssuer.start();
		vi.spyOn(StubOidcIssuer, 'start').mockResolvedValueOnce(issuer);
		const dispose = vi.spyOn(Miniflare.prototype, 'dispose');
		const stop = vi.spyOn(issuer, 'stop');
		const ready = vi.spyOn(Miniflare.prototype, 'ready', 'get');
		const migrations = vi.spyOn(TestD1Database.prototype, 'run');
		let disposals = 0;
		let issuerStops = 0;

		dispose.mockImplementation(async () => {
			const receiver: unknown = dispose.mock.contexts.at(-1);
			if (!(receiver instanceof Miniflare)) {
				throw new TypeError('Expected a Miniflare disposal receiver');
			}
			disposals += 1;
			dispose.mockRestore();
			await receiver.dispose();

			if (cleanupFails) {
				throw workerCleanupError;
			}
		});
		stop.mockImplementation(async () => {
			issuerStops += 1;
			stop.mockRestore();
			await issuer.stop();

			if (cleanupFails) {
				throw cleanupError;
			}
		});
		if (stage === 'runtime-start') {
			ready.mockRejectedValueOnce(cause);
		} else if (stage === 'database-migrations') {
			migrations.mockRejectedValueOnce(cause);
		}
		const provision = vi.spyOn(
			CupboardTestServer.prototype,
			'provisionFixtureTenant'
		);

		if (stage === 'tenant-provisioning') {
			provision.mockRejectedValueOnce(cause);
		}

		try {
			await withTemporaryDirectory(
				'cupboard-fixture-bootstrap-',
				async (directory) => {
					let error: unknown;
					try {
						await CupboardTestServer.start(directory);
					} catch (error_) {
						error = error_;
					}
					expect({
						disposals,
						issuerStops,
						provisionRequests: provision.mock.calls.length
					}).toStrictEqual({
						disposals: 1,
						issuerStops: 1,
						provisionRequests: stage === 'tenant-provisioning' ? 1 : 0
					});
					const observation =
						error instanceof CupboardTestServerStartError
							? {
									instance: true,
									stage: error.stage,
									cause: error.cause,
									cleanupErrors: error.cleanupErrors,
									message: error.message
								}
							: { instance: false, error };
					expect(observation).toStrictEqual({
						instance: true,
						stage,
						cause,
						cleanupErrors: cleanupFails
							? [cleanupError, workerCleanupError]
							: [],
						message: `Test server startup failed during ${stage}`
					});

					const server: unknown = provision.mock.contexts[0];
					if (server instanceof CupboardTestServer) {
						await expect(fetch(server.url)).rejects.toThrow('fetch failed');
					}
				}
			);
		} finally {
			const worker: unknown = ready.mock.contexts[0];
			vi.restoreAllMocks();
			await Promise.all([
				disposals === 0 && worker instanceof Miniflare
					? worker.dispose()
					: undefined,
				issuerStops === 0 ? issuer.stop() : undefined
			]);
		}
	}
);

// workerd closes a keep-alive connection after 5 s without a request. When
// workerd is stopped for longer than that, its idle timer has already expired
// when workerd runs again.
const workerdStallMs = 6000;

// Indexes into the state that the test shares with the resume thread.
const requestedIndex = 0;
const resumedIndex = 1;
const finishedIndex = 2;

// The resume thread keeps workerd stopped until the harness has sent a request
// and `stallMs` has passed since the thread started, or until the test
// finishes. It runs on its own thread because a synchronous binding proxy call
// blocks the test's thread until workerd answers.
const resumeScript = `
const { workerData } = require('node:worker_threads');
const { pid, state, stallMs, requested, resumed, finished } = workerData;
const startedAt = Date.now();

while (Atomics.load(state, requested) === 0 && Atomics.load(state, finished) === 0) {
	Atomics.wait(state, requested, 0);
}

const remaining = stallMs - (Date.now() - startedAt);
if (remaining > 0) {
	Atomics.wait(state, finished, 0, remaining);
}

Atomics.store(state, resumed, 1);
try {
	process.kill(pid, 'SIGCONT');
} catch {}
`;

it('starts when workerd stalls past its idle connection timeout', async () => {
	const spawn = vi.spyOn(childProcess, 'spawn');
	const ready = vi.spyOn(Miniflare.prototype, 'ready', 'get');
	const state = new Int32Array(new SharedArrayBuffer(12));
	let runtime: ChildProcess | undefined;
	let resumerExit: Promise<unknown[]> | undefined;
	let wasFirstRequestWhileStopped: boolean | undefined;

	const markRequest = (): void => {
		if (Atomics.load(state, requestedIndex) === 1) {
			return;
		}

		wasFirstRequestWhileStopped = Atomics.load(state, resumedIndex) === 0;
		Atomics.store(state, requestedIndex, 1);
		Atomics.notify(state, requestedIndex);
	};

	const resumeWorkerd = async (): Promise<void> => {
		Atomics.store(state, finishedIndex, 1);
		Atomics.notify(state, requestedIndex);
		Atomics.notify(state, finishedIndex);
		await resumerExit;

		if (
			runtime?.pid !== undefined &&
			runtime.exitCode === null &&
			runtime.signalCode === null
		) {
			process.kill(runtime.pid, 'SIGCONT');
		}
	};
	// A test that reaches its time limit never reaches the `finally` below, so
	// workerd is also resumed when the test finishes.
	onTestFinished(resumeWorkerd);

	// Makes one request on each of Miniflare's two routes to workerd: a binding
	// proxy call and `dispatchFetch`. A route that keeps its connection alive
	// then has an idle connection, and workerd is stopped while it is idle. The
	// next request on either route is the harness's first request.
	const stallAfterExchanges = async (worker: Miniflare): Promise<URL> => {
		const url = await worker.ready;
		await worker.getD1Database('CUPBOARD_DB', 'cupboard');
		const health = await worker.dispatchFetch(new URL('/healthz', url).href);
		await health.arrayBuffer();

		const getD1Database = worker.getD1Database.bind(worker);
		const dispatchFetch = worker.dispatchFetch;
		vi.spyOn(worker, 'getD1Database').mockImplementation(
			(bindingName, workerName) => {
				markRequest();

				return getD1Database(bindingName, workerName);
			}
		);
		vi.spyOn(worker, 'dispatchFetch').mockImplementation((input, init) => {
			markRequest();

			return dispatchFetch(input, init);
		});

		const runtimes = spawn.mock.results.filter(
			(_, index) =>
				path.basename(String(spawn.mock.calls[index]?.[0])) === 'workerd'
		);
		const spawned: unknown = runtimes[0]?.value;
		if (
			runtimes.length !== 1 ||
			!(spawned instanceof ChildProcess) ||
			spawned.pid === undefined
		) {
			throw new Error('Expected exactly one running workerd process');
		}

		runtime = spawned;
		process.kill(spawned.pid, 'SIGSTOP');
		const resumer = new Worker(resumeScript, {
			eval: true,
			workerData: {
				pid: spawned.pid,
				state,
				stallMs: workerdStallMs,
				requested: requestedIndex,
				resumed: resumedIndex,
				finished: finishedIndex
			}
		});
		resumerExit = once(resumer, 'exit');

		return url;
	};

	ready.mockImplementationOnce(() => {
		const receiver: unknown = ready.mock.contexts.at(-1);
		if (!(receiver instanceof Miniflare)) {
			throw new TypeError('Expected a Miniflare receiver');
		}
		ready.mockRestore();

		return stallAfterExchanges(receiver);
	});

	try {
		await withTemporaryDirectory(
			'cupboard-fixture-stalled-runtime-',
			async (directory) => {
				let observation: unknown;
				try {
					const server = await CupboardTestServer.start(directory);
					const wasResumed = Atomics.load(state, resumedIndex) === 1;
					await server.stop();
					observation = {
						started: true,
						wasFirstRequestWhileStopped,
						wasResumed
					};
				} catch (error) {
					observation = { started: false, error };
				}

				expect(observation).toStrictEqual({
					started: true,
					wasFirstRequestWhileStopped: true,
					wasResumed: true
				});
			}
		);
	} finally {
		vi.restoreAllMocks();
		await resumeWorkerd();
	}
});

it('completes the fresh deployment before provisioning a tenant', async () => {
	await withTemporaryDirectory(
		'cupboard-fixture-deployment-',
		async (directory) => {
			const server = await CupboardTestServer.start(directory, {
				provision: false
			});

			try {
				await expect(
					server.provisionFixtureTenant({ defaultCacheAccess: 'public' })
				).resolves.toBeUndefined();
			} finally {
				await server.stop();
			}
		}
	);
});

it('preserves an explicitly incomplete deployment', async () => {
	await withTemporaryDirectory(
		'cupboard-fixture-deployment-',
		async (directory) => {
			const server = await CupboardTestServer.start(directory, {
				provision: false,
				completedTransitions: []
			});

			try {
				await expect(
					server.provisionFixtureTenant({ defaultCacheAccess: 'public' })
				).rejects.toStrictEqual(
					new TenantProvisionFailedError(
						503,
						JSON.stringify({
							defined: false,
							code: 'SERVICE_UNAVAILABLE',
							status: 503,
							message:
								'Reference changes are unavailable until both Workers use path read revocation. Complete cupboard deploy, then retry the request.'
						})
					)
				);
			} finally {
				await server.stop();
			}
		}
	);
});
