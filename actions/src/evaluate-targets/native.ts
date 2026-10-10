import path from 'node:path';
import process from 'node:process';

import { CodedError, formatErrorWithCauses } from '@cupboard/shared/errors';
import { z } from 'zod';

import { type Environment, requireEnvironment, setOutput } from '../inputs.ts';
import { publishTargetsSchema } from '../publish-plan.ts';

import {
	type CapturedCommand,
	captureEvaluationProcess,
	evaluateTargetManifest,
	type ManifestEvaluationOptions
} from './manifest-evaluator.ts';

export interface NativeEvaluationDependencies {
	readonly workerPath?: string;
	readonly capture?: (command: CapturedCommand) => Promise<string>;
}

class EvaluationSignalError extends CodedError {
	constructor(readonly signal: 'SIGINT' | 'SIGTERM') {
		super(`Target manifest evaluation cancelled by ${signal}.`);
		this.name = 'EvaluationSignalError';
	}
	override get exitCode(): number {
		return this.signal === 'SIGINT' ? 130 : 143;
	}
}

/**
 * Reads the target expression and publication scope from action inputs.
 */
export function evaluationInputs(
	environment: Environment
): ManifestEvaluationOptions {
	return {
		targets: requireEnvironment(environment, 'INPUT_TARGETS'),
		publish: z
			.enum(['none', 'outputs', 'built', 'closure'])
			.parse(environment.INPUT_PUBLISH ?? 'outputs')
	};
}

/**
 * Publishes the complete worker result after the optional read wrapper closes.
 */
export async function nativeEvaluationMain(
	environment: Environment,
	signal?: AbortSignal,
	dependencies: NativeEvaluationDependencies = {}
): Promise<void> {
	evaluationInputs(environment);
	const worker: readonly [string, string] = [
		process.execPath,
		dependencies.workerPath ??
			path.join(path.dirname(process.argv[1] ?? process.execPath), 'worker.cjs')
	];
	const target = environment['INPUT_READ-SESSION-TARGET'] ?? '';
	let command: readonly [string, ...string[]] = worker;
	if (target !== '') {
		const cupboard = requireEnvironment(environment, 'INPUT_CUPBOARD-PATH');
		const audience = environment.INPUT_AUDIENCE?.trim() ?? '';
		const cacheValue = environment['INPUT_READ-SESSION-CACHES'];
		const cacheInput: unknown = JSON.parse(
			cacheValue === '' ? '[]' : (cacheValue ?? '[]')
		);
		const caches = z.array(z.string().regex(/^[^\r\n]*$/u)).parse(cacheInput);
		const view = environment['INPUT_READ-SESSION-VIEW'] ?? '';
		command = [
			cupboard,
			'run',
			target,
			'--github-oidc',
			...(audience === '' ? [] : ['--audience', audience]),
			...caches.flatMap((cache) =>
				cache === '' ? [] : ['--read-cache', cache]
			),
			...(view === '' ? [] : ['--reuse-view', view]),
			'--',
			...worker
		];
	}
	const [executable, ...arguments_] = command;
	const stdout = await (dependencies.capture ?? captureEvaluationProcess)({
		executable,
		arguments: arguments_,
		environment,
		...(signal !== undefined && { signal })
	});
	signal?.throwIfAborted();
	const manifest: unknown = JSON.parse(stdout);
	publishTargetsSchema.parse(manifest);
	await setOutput(environment, 'manifest', JSON.stringify(manifest));
}

/**
 * Evaluates every target within the worker's inherited read credential session.
 */
export async function nativeEvaluationWorker(
	environment: Environment,
	signal: AbortSignal
): Promise<void> {
	const manifest = await evaluateTargetManifest(
		evaluationInputs(environment),
		(arguments_, internalSignal, onFailure) =>
			captureEvaluationProcess({
				executable: 'nix',
				arguments: arguments_,
				environment,
				signal: internalSignal,
				externalSignal: signal,
				onFailure
			}),
		signal
	);
	signal.throwIfAborted();
	process.stdout.write(`${manifest}\n`);
}

/**
 * Joins the operation before reporting a failure or external interruption.
 */
export async function runNativeEvaluation(
	operation: (environment: Environment, signal: AbortSignal) => Promise<void>
): Promise<void> {
	const controller = new AbortController();
	const interrupt = (): void => {
		controller.abort(new EvaluationSignalError('SIGINT'));
	};
	const terminate = (): void => {
		controller.abort(new EvaluationSignalError('SIGTERM'));
	};
	process.once('SIGINT', interrupt);
	process.once('SIGTERM', terminate);
	try {
		await operation(process.env, controller.signal);
	} catch (error) {
		process.stderr.write(`${formatErrorWithCauses(error)}\n`);
		process.exitCode = error instanceof CodedError ? error.exitCode : 1;
	} finally {
		process.removeListener('SIGINT', interrupt);
		process.removeListener('SIGTERM', terminate);
	}
}
