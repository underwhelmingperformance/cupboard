import { spawn } from 'node:child_process';

import {
	type AbortableChildProcessLifecycle,
	type ChildProcessEscalationScheduler,
	observeChildProcess,
	waitForAbortableChildProcess
} from '@cupboard/shared/child-process';
import { drainWithConcurrency } from '@cupboard/shared/concurrency';
import { CodedError } from '@cupboard/shared/errors';

import type { Environment } from '../inputs.ts';
import { publishTargetsSchema } from '../publish-plan.ts';

const maximumCapturedOutputBytes = 256 * 1024 * 1024;

export interface ManifestEvaluationOptions {
	readonly targets: string;
	readonly publish: string;
	readonly maximumOutputBytes?: number;
}

export type ManifestRunner = (
	arguments_: readonly string[],
	signal: AbortSignal,
	onFailure: (error: unknown) => void
) => Promise<string>;

export interface CapturedEvaluationProcess extends AbortableChildProcessLifecycle {
	onStdout(listener: (chunk: Buffer) => void): void;
}

export interface CapturedCommand {
	readonly executable: string;
	readonly arguments: readonly string[];
	readonly environment: Environment;
	readonly signal?: AbortSignal;
	readonly externalSignal?: AbortSignal;
	readonly maximumOutputBytes?: number;
	readonly onFailure?: (error: unknown) => void;
}

export interface CaptureDependencies {
	readonly spawn?: (command: CapturedCommand) => CapturedEvaluationProcess;
	readonly escalationScheduler?: ChildProcessEscalationScheduler;
}

class ManifestCountInvalidError extends CodedError {
	constructor(options?: ErrorOptions) {
		super(
			'The target manifest length must be a positive safe integer.',
			options
		);
		this.name = 'ManifestCountInvalidError';
	}
}

class ManifestJsonInvalidError extends CodedError {
	constructor(index: number, options: ErrorOptions) {
		super(`Target ${String(index)} returned invalid JSON.`, options);
		this.name = 'ManifestJsonInvalidError';
	}
}

class ManifestSchemaInvalidError extends CodedError {
	constructor(options: ErrorOptions) {
		super('The evaluated target manifest is invalid.', options);
		this.name = 'ManifestSchemaInvalidError';
	}
}

class ManifestOutputLimitError extends CodedError {
	constructor(limit: number) {
		super(
			`Target manifest evaluation exceeded ${String(limit)} captured bytes.`
		);
		this.name = 'ManifestOutputLimitError';
	}
}

class EvaluationCommandFailedError extends CodedError {
	constructor(
		executable: string,
		readonly status: number | null
	) {
		super(`${executable} exited with status ${String(status)}.`);
		this.name = 'EvaluationCommandFailedError';
	}
	override get exitCode(): number {
		return this.status ?? 1;
	}
}

function spawnCapturedProcess(
	command: CapturedCommand
): CapturedEvaluationProcess {
	const child = spawn(command.executable, [...command.arguments], {
		env: command.environment,
		stdio: ['ignore', 'pipe', 'inherit']
	});
	return {
		...observeChildProcess(child),
		onStdout(listener) {
			child.stdout.on('data', listener);
		}
	};
}

/**
 * Captures stdout only after complete process closure. External cancellation
 * force-terminates an evaluation even during internal graceful shutdown.
 */
export async function captureEvaluationProcess(
	command: CapturedCommand,
	dependencies: CaptureDependencies = {}
): Promise<string> {
	command.signal?.throwIfAborted();
	command.externalSignal?.throwIfAborted();
	const limit = command.maximumOutputBytes ?? maximumCapturedOutputBytes;
	const outputLimit = new AbortController();
	const signals = [
		outputLimit.signal,
		...(command.signal === undefined ? [] : [command.signal]),
		...(command.externalSignal === undefined ? [] : [command.externalSignal])
	];
	const signal = AbortSignal.any(signals);
	const child = (dependencies.spawn ?? spawnCapturedProcess)(command);
	let termination: 'none' | 'graceful' | 'forced' = 'none';
	let isClosed = false;
	const owner: AbortableChildProcessLifecycle = {
		kill(requested) {
			if (isClosed) {
				return false;
			}
			const isForce =
				requested === 'SIGKILL' || command.externalSignal?.aborted === true;
			if (
				termination === 'forced' ||
				(!isForce && termination === 'graceful')
			) {
				return false;
			}
			termination = isForce ? 'forced' : 'graceful';
			return child.kill(isForce ? 'SIGKILL' : requested);
		},
		onceError(listener) {
			child.onceError((error) => {
				command.onFailure?.(error);
				listener(error);
			});
		},
		onceClose(listener) {
			child.onceClose((status, terminationSignal) => {
				isClosed = true;
				listener(status, terminationSignal);
			});
		}
	};
	const force = (): void => {
		owner.kill('SIGKILL');
	};
	command.externalSignal?.addEventListener('abort', force, { once: true });
	const chunks: Buffer[] = [];
	let bytes = 0;
	child.onStdout((chunk) => {
		if (outputLimit.signal.aborted) {
			return;
		}
		bytes += chunk.length;
		if (bytes > limit) {
			const error = new ManifestOutputLimitError(limit);
			outputLimit.abort(error);
			command.onFailure?.(error);
			return;
		}
		chunks.push(chunk);
	});
	try {
		const result = await waitForAbortableChildProcess(
			owner,
			signal,
			dependencies.escalationScheduler
		);
		if (result.error !== undefined) {
			throw result.error;
		}
		if (result.status !== 0) {
			throw new EvaluationCommandFailedError(command.executable, result.status);
		}
		return Buffer.concat(chunks).toString('utf8');
	} finally {
		command.externalSignal?.removeEventListener('abort', force);
	}
}

/**
 * Evaluates a complete manifest with bounded concurrency while preserving the
 * original JSON objects and their order.
 */
export async function evaluateTargetManifest(
	options: ManifestEvaluationOptions,
	runner: ManifestRunner,
	externalSignal?: AbortSignal
): Promise<string> {
	const controller = new AbortController();
	const fail = (error: unknown): void => {
		controller.abort(error);
	};
	const abort = (): void => {
		fail(externalSignal?.reason);
	};
	externalSignal?.addEventListener('abort', abort, { once: true });
	if (externalSignal?.aborted === true) {
		abort();
	}
	const limit = options.maximumOutputBytes ?? maximumCapturedOutputBytes;
	try {
		controller.signal.throwIfAborted();
		const countOutput = await runner(
			['eval', '--json', options.targets, '--apply', 'builtins.length'],
			controller.signal,
			fail
		);
		let count: unknown;
		try {
			count = JSON.parse(countOutput);
		} catch (error) {
			throw new ManifestCountInvalidError({ cause: error });
		}
		if (
			typeof count !== 'number' ||
			!Number.isSafeInteger(count) ||
			count <= 0
		) {
			throw new ManifestCountInvalidError();
		}
		const targetCount = count;
		const values: unknown[] = [];
		let bytes = 2;
		let nextIndex = 0;
		const indices: AsyncIterator<number> = {
			next() {
				if (nextIndex === targetCount) {
					return Promise.resolve({ done: true, value: undefined });
				}
				const index = nextIndex;
				nextIndex += 1;
				return Promise.resolve({ done: false, value: index });
			}
		};
		await drainWithConcurrency(indices, 4, async (index) => {
			try {
				controller.signal.throwIfAborted();
				const expression =
					options.publish === 'none'
						? `targets: builtins.removeAttrs (builtins.elemAt targets ${String(index)}) [ "rootDrvPath" ]`
						: `targets: builtins.elemAt targets ${String(index)}`;
				const output = await runner(
					['eval', '--json', options.targets, '--apply', expression],
					controller.signal,
					fail
				);
				let value: unknown;
				try {
					value = JSON.parse(output);
				} catch (error) {
					throw new ManifestJsonInvalidError(index, { cause: error });
				}
				const addition =
					Buffer.byteLength(JSON.stringify(value)) + (index === 0 ? 0 : 1);
				if (bytes + addition > limit) {
					throw new ManifestOutputLimitError(limit);
				}
				bytes += addition;
				values[index] = value;
			} catch (error) {
				controller.abort(error);
				throw controller.signal.reason;
			}
		});
		controller.signal.throwIfAborted();
		const validation = publishTargetsSchema.safeParse(values);
		if (!validation.success) {
			throw new ManifestSchemaInvalidError({ cause: validation.error });
		}
		return JSON.stringify(values);
	} finally {
		externalSignal?.removeEventListener('abort', abort);
	}
}
