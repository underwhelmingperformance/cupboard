import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { observeChildProcess } from '@cupboard/shared/child-process';
import { expect, it, onTestFinished, vi } from 'vitest';

import {
	type CapturedCommand,
	type CapturedEvaluationProcess,
	captureEvaluationProcess,
	evaluateTargetManifest
} from './manifest-evaluator.ts';
import { evaluationInputs, nativeEvaluationMain } from './native.ts';

async function resultOrError(operation: Promise<unknown>): Promise<unknown> {
	try {
		return await operation;
	} catch (error) {
		return error;
	}
}

const raw = [
	{
		attr: '.#package',
		system: 'x86_64-linux',
		os: 'ubuntu-latest',
		rootSuffix: '/package/'
	}
];

it('reads manifest inputs without changing the publication mode', () => {
	expect(
		evaluationInputs({ INPUT_TARGETS: '.#targets', INPUT_PUBLISH: 'none' })
	).toStrictEqual({ targets: '.#targets', publish: 'none' });
});

it.each(['', '  audience  '])(
	'runs one credential wrapper and publishes only after it completes: %j',
	async (audience) => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-evaluation-output-')
		);
		onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const output = path.join(directory, 'output');
		const calls: CapturedCommand[] = [];
		const signal = new AbortController().signal;
		const environment = {
			INPUT_TARGETS: '.#targets',
			INPUT_PUBLISH: 'outputs',
			'INPUT_CUPBOARD-PATH': '/opt/cupboard',
			'INPUT_READ-SESSION-TARGET':
				'https://cupboard.example.workers.dev/t/acme/cache/pr-1',
			INPUT_AUDIENCE: audience,
			'INPUT_READ-SESSION-CACHES':
				'["https://cupboard.example.workers.dev/t/acme/cache/extra"]',
			'INPUT_READ-SESSION-VIEW': 'prior',
			GITHUB_OUTPUT: output
		};
		await nativeEvaluationMain(environment, signal, {
			workerPath: '/opt/action/dist/worker.cjs',
			capture: (command) => {
				calls.push(command);
				return Promise.resolve(JSON.stringify(raw));
			}
		});
		expect({ calls, output: await readFile(output, 'utf8') }).toStrictEqual({
			calls: [
				{
					executable: '/opt/cupboard',
					arguments: [
						'run',
						'https://cupboard.example.workers.dev/t/acme/cache/pr-1',
						'--github-oidc',
						...(audience.trim() === '' ? [] : ['--audience', audience.trim()]),
						'--read-cache',
						'https://cupboard.example.workers.dev/t/acme/cache/extra',
						'--reuse-view',
						'prior',
						'--',
						process.execPath,
						'/opt/action/dist/worker.cjs'
					],
					environment,
					signal
				}
			],
			output: `manifest=${JSON.stringify(raw)}\n`
		});
	}
);

it('does not publish worker output when the outer credential wrapper fails', async () => {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-evaluation-transaction-')
	);
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const output = path.join(directory, 'output');
	const failure = new Error('Read credential renewal refused');
	await expect(
		nativeEvaluationMain(
			{
				INPUT_TARGETS: '.#targets',
				INPUT_PUBLISH: 'outputs',
				GITHUB_OUTPUT: output
			},
			undefined,
			{
				capture: () => {
					return Promise.reject(failure);
				}
			}
		)
	).rejects.toBe(failure);
	await expect(readFile(output, 'utf8')).rejects.toMatchObject({
		code: 'ENOENT'
	});
});

class ControlledProcess implements CapturedEvaluationProcess {
	private errorListener: ((error: Error) => void) | undefined;
	private closeListener:
		| ((status: number | null, signal: NodeJS.Signals | undefined) => void)
		| undefined;
	private stdoutListener: ((chunk: Buffer) => void) | undefined;
	readonly events: string[] = [];
	kill(signal: NodeJS.Signals): boolean {
		this.events.push(signal);
		return true;
	}
	onceError(listener: (error: Error) => void): void {
		this.errorListener = listener;
	}
	onceClose(
		listener: (
			status: number | null,
			signal: NodeJS.Signals | undefined
		) => void
	): void {
		this.closeListener = listener;
	}
	onStdout(listener: (chunk: Buffer) => void): void {
		this.stdoutListener = listener;
	}
	write(value: string): void {
		this.stdoutListener?.(Buffer.from(value));
	}
	writeBytes(value: Buffer): void {
		this.stdoutListener?.(value);
	}
	close(status: number | null, signal?: NodeJS.Signals): void {
		this.events.push('close');
		this.closeListener?.(status, signal);
	}
	error(value: Error): void {
		this.errorListener?.(value);
	}
}

it.each([1, 3])(
	'upgrades all %i active children after external cancellation during internal grace',
	async (count) => {
		const internal = new AbortController();
		const external = new AbortController();
		const failure = new Error('First target failure');
		const children = Array.from(
			{ length: count },
			() => new ControlledProcess()
		);
		const schedules: { run: () => void; delay: number; cancelled: boolean }[] =
			[];
		const results = children.map((child) =>
			resultOrError(
				captureEvaluationProcess(
					{
						executable: 'nix',
						arguments: [],
						environment: {},
						signal: internal.signal,
						externalSignal: external.signal
					},
					{
						spawn: () => child,
						escalationScheduler: {
							schedule(run, delay) {
								const value = { run, delay, cancelled: false };
								schedules.push(value);
								return {
									cancel() {
										value.cancelled = true;
									}
								};
							}
						}
					}
				)
			)
		);
		internal.abort(failure);
		external.abort(new Error('External SIGTERM'));
		for (const scheduled of schedules) {
			scheduled.run();
		}
		for (const child of children) {
			child.close(1);
		}
		expect({
			errors: await Promise.all(results),
			events: children.map((child) => child.events),
			schedules: schedules.map(({ delay, cancelled }) => ({ delay, cancelled }))
		}).toStrictEqual({
			errors: Array.from({ length: count }, () => failure),
			events: Array.from({ length: count }, () => [
				'SIGTERM',
				'SIGKILL',
				'close'
			]),
			schedules: Array.from({ length: count }, () => ({
				delay: 10_000,
				cancelled: true
			}))
		});
	}
);

it('waits for closure after output capture exceeds its bound', async () => {
	const child = new ControlledProcess();
	const result = resultOrError(
		captureEvaluationProcess(
			{
				executable: 'nix',
				arguments: [],
				environment: {},
				maximumOutputBytes: 3
			},
			{ spawn: () => child }
		)
	);
	child.write('four');
	expect(child.events).toStrictEqual(['SIGTERM']);
	child.close(1);
	const error = await result;
	expect({
		name: error instanceof Error ? error.name : undefined,
		events: child.events
	}).toStrictEqual({
		name: 'ManifestOutputLimitError',
		events: ['SIGTERM', 'close']
	});
});

it('preserves a spawn failure after all stdio closes', async () => {
	const child = new ControlledProcess();
	const failure = new Error('Executable missing');
	const result = resultOrError(
		captureEvaluationProcess(
			{ executable: 'missing', arguments: [], environment: {} },
			{ spawn: () => child }
		)
	);
	child.error(failure);
	child.close(-1);
	expect({ error: await result, events: child.events }).toStrictEqual({
		error: failure,
		events: ['close']
	});
});

const stubbornEvaluation = `process.on('message', () => {}); process.on('SIGTERM', () => process.send('ignored')); process.send('ready');`;

it.each([1, 3])(
	'joins %i real stubborn evaluation processes after an external upgrade during grace',
	async (count) => {
		const internal = new AbortController();
		const external = new AbortController();
		const failure = new Error('First target failure');
		const trace: string[] = [];
		const ready = Array.from({ length: count }, () =>
			Promise.withResolvers<undefined>()
		);
		const ignored = Array.from({ length: count }, () =>
			Promise.withResolvers<undefined>()
		);
		const results = ready.map((started, index) =>
			resultOrError(
				captureEvaluationProcess(
					{
						executable: process.execPath,
						arguments: ['-e', stubbornEvaluation],
						environment: process.env,
						signal: internal.signal,
						externalSignal: external.signal
					},
					{
						escalationScheduler: {
							schedule: () => ({ cancel: vi.fn() })
						},
						spawn(command) {
							const child = spawn(command.executable, [...command.arguments], {
								env: command.environment,
								stdio: ['ignore', 'pipe', 'pipe', 'ipc']
							});
							onTestFinished(() => {
								child.kill('SIGKILL');
							});
							child.on('message', (message) => {
								if (message === 'ready') {
									trace.push(`ready ${String(index)}`);
									started.resolve(undefined);
								} else if (message === 'ignored') {
									trace.push(`ignored ${String(index)}`);
									ignored[index]?.resolve(undefined);
								}
							});
							const stdout = child.stdout;
							if (stdout === null) {
								throw new Error('The test child requires piped stdout.');
							}
							const lifecycle = observeChildProcess(child);
							return {
								kill(signal) {
									trace.push(`${signal} ${String(index)}`);
									return lifecycle.kill(signal);
								},
								onceError(listener) {
									lifecycle.onceError(listener);
								},
								onceClose(listener) {
									lifecycle.onceClose((status, signal) => {
										trace.push(`close ${String(index)}`);
										listener(status, signal);
									});
								},
								onStdout(listener) {
									stdout.on('data', listener);
								}
							};
						}
					}
				)
			)
		);
		await Promise.all(ready.map((started) => started.promise));
		internal.abort(failure);
		await Promise.all(ignored.map((notice) => notice.promise));
		expect(
			trace
				.filter((event) => event.startsWith('ignored'))
				.toSorted((left, right) => left.localeCompare(right))
		).toStrictEqual(
			Array.from(
				{ length: count },
				(_, index) => `ignored ${String(index)}`
			).toSorted((left, right) => left.localeCompare(right))
		);
		external.abort(new Error('External interrupt'));
		const errors = await Promise.all(results);
		expect({
			errors,
			signals: trace.filter((event) => event.startsWith('SIG')),
			closed: trace
				.filter((event) => event.startsWith('close'))
				.toSorted((left, right) => left.localeCompare(right))
		}).toStrictEqual({
			errors: Array.from({ length: count }, () => failure),
			signals: [
				...Array.from(
					{ length: count },
					(_, index) => `SIGTERM ${String(index)}`
				),
				...Array.from(
					{ length: count },
					(_, index) => `SIGKILL ${String(index)}`
				)
			],
			closed: Array.from(
				{ length: count },
				(_, index) => `close ${String(index)}`
			)
		});
	}
);

it('schedules ten-second escalation and joins a real stubborn child on internal failure', async () => {
	const internal = new AbortController();
	const failure = new Error('Internal evaluation failure');
	const started = Promise.withResolvers<undefined>();
	const trace: string[] = [];

	const ignored = Promise.withResolvers<undefined>();
	const escalation = Promise.withResolvers<{
		run: () => void;
		delayMs: number;
	}>();
	const cancel = vi.fn();
	const result = resultOrError(
		captureEvaluationProcess(
			{
				executable: process.execPath,
				arguments: ['-e', stubbornEvaluation],
				environment: process.env,
				signal: internal.signal
			},
			{
				escalationScheduler: {
					schedule(run, delayMs) {
						escalation.resolve({ run, delayMs });
						return { cancel };
					}
				},
				spawn(command) {
					const child = spawn(command.executable, [...command.arguments], {
						env: command.environment,
						stdio: ['ignore', 'pipe', 'pipe', 'ipc']
					});
					onTestFinished(() => {
						child.kill('SIGKILL');
					});
					child.on('message', (message) => {
						if (message === 'ready') {
							started.resolve(undefined);
						} else if (message === 'ignored') {
							ignored.resolve(undefined);
						}
					});
					const stdout = child.stdout;
					if (stdout === null) {
						throw new Error('The test child requires piped stdout.');
					}
					const lifecycle = observeChildProcess(child);
					return {
						kill(signal) {
							trace.push(signal);
							return lifecycle.kill(signal);
						},
						onceError(listener) {
							lifecycle.onceError(listener);
						},
						onceClose(listener) {
							lifecycle.onceClose((status, signal) => {
								trace.push('close');
								listener(status, signal);
							});
						},
						onStdout(listener) {
							stdout.on('data', listener);
						}
					};
				}
			}
		)
	);
	await started.promise;
	internal.abort(failure);
	await ignored.promise;
	const scheduled = await escalation.promise;
	expect({
		trace,
		delayMs: scheduled.delayMs,
		cancellations: cancel.mock.calls
	}).toStrictEqual({
		trace: ['SIGTERM'],
		delayMs: 10_000,
		cancellations: []
	});
	scheduled.run();
	expect({
		error: await result,
		trace,
		cancellations: cancel.mock.calls
	}).toStrictEqual({
		error: failure,
		trace: ['SIGTERM', 'SIGKILL', 'close'],
		cancellations: [[]]
	});
});

it('preserves UTF-8 characters split across captured byte chunks', async () => {
	const child = new ControlledProcess();
	const result = captureEvaluationProcess(
		{ executable: 'nix', arguments: [], environment: {} },
		{ spawn: () => child }
	);
	const bytes = Buffer.from('{"label":"λ"}');
	for (const byte of bytes) {
		child.writeBytes(Buffer.from([byte]));
	}
	child.close(0);
	expect({ stdout: await result, events: child.events }).toStrictEqual({
		stdout: '{"label":"λ"}',
		events: ['close']
	});
});

it('prevents output if cancellation arrives after the wrapper closes successfully', async () => {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-evaluation-late-abort-')
	);
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const output = path.join(directory, 'output');
	const controller = new AbortController();
	const failure = new Error('Late external interruption');
	const result = resultOrError(
		nativeEvaluationMain(
			{ INPUT_TARGETS: '.#targets', GITHUB_OUTPUT: output },
			controller.signal,
			{
				capture: () => {
					controller.abort(failure);
					return Promise.resolve(JSON.stringify(raw));
				}
			}
		)
	);
	expect(await result).toBe(failure);
	await expect(readFile(output, 'utf8')).rejects.toMatchObject({
		code: 'ENOENT'
	});
});

it('stops all peers on a captured-byte overflow before the overflowing child closes', async () => {
	const children = Array.from({ length: 4 }, () => new ControlledProcess());
	const calls: number[] = [];
	const started = Promise.withResolvers<undefined>();
	onTestFinished(() => {
		for (const child of children) {
			child.close(1);
		}
	});
	const result = resultOrError(
		evaluateTargetManifest(
			{ targets: '.#targets', publish: 'outputs' },
			(arguments_, signal, onFailure: (error: unknown) => void) => {
				if (arguments_.at(-1) === 'builtins.length') {
					return Promise.resolve('6');
				}
				const index = Number(arguments_.at(-1)?.match(/ (\d+)$/u)?.[1]);
				calls.push(index);
				const child = children[index];
				if (child === undefined) {
					return Promise.reject(new Error('A target launched after failure'));
				}
				const captured = captureEvaluationProcess(
					{
						executable: 'nix',
						arguments: arguments_,
						environment: {},
						signal,
						maximumOutputBytes: 3,
						onFailure
					},
					{ spawn: () => child }
				);
				if (calls.length === children.length) {
					started.resolve(undefined);
				}
				return captured;
			}
		)
	);
	await started.promise;
	expect(calls).toStrictEqual([0, 1, 2, 3]);
	children[0]?.write('four');
	expect(children.map((child) => child.events)).toStrictEqual(
		Array.from({ length: 4 }, () => ['SIGTERM'])
	);
	for (const child of children) {
		child.close(1);
	}
	const error = await result;
	expect({
		name: error instanceof Error ? error.name : undefined,
		calls,
		events: children.map((child) => child.events)
	}).toStrictEqual({
		name: 'ManifestOutputLimitError',
		calls: [0, 1, 2, 3],
		events: Array.from({ length: 4 }, () => ['SIGTERM', 'close'])
	});
});
