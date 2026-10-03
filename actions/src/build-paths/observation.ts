import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Nix, NixStoreConfig } from '@cupboard/nix';
import {
	BuildEventListener,
	type BuildEventRejectedError,
	createRuntimeDirectory,
	environmentWithPostBuildHook,
	preflightBuildObservation,
	removeInvocationRuntimeDirectory,
	renderHookScript
} from '@cupboard/nix/build-observation';
import { type BuildEvent, invocationIdSchema } from '@cupboard/protocol/build';
import { withCleanups } from '@cupboard/shared/cleanup';
import { CodedError } from '@cupboard/shared/errors';

import { type Environment, requireEnvironment } from '../inputs.ts';

import type { JobOutputProtection } from './job-roots.ts';

export interface BuildObservation {
	readonly environment: Environment;
	readonly events: readonly BuildEvent[];
	flush(): Promise<void>;
	close(): Promise<void>;
}

export interface BuildObservationOptions {
	readonly environment: Environment;
	readonly config: NixStoreConfig;
	readonly nix: Pick<Nix, 'storeKind' | 'daemonTrust'>;
	readonly invocationId: string;
	readonly protection: JobOutputProtection;
	readonly cupboardPath?: string;
}

export class BuildObservationIncompleteError extends CodedError {
	constructor(options?: ErrorOptions) {
		super(
			'The build hook could not report and protect every completed output. Repair the hook or GC-root failure before publishing this build.',
			options
		);
		this.name = 'BuildObservationIncompleteError';
	}
}

export async function observeBuild(
	options: BuildObservationOptions
): Promise<BuildObservation> {
	const invocationId = invocationIdSchema.parse(options.invocationId);
	const executablePath =
		options.cupboardPath ??
		requireEnvironment(options.environment, 'CUPBOARD_PATH');
	const preflight = await preflightBuildObservation({
		config: options.config,
		storeKind: options.nix.storeKind,
		stateDirectory: options.config.stateDirectory,
		daemonTrust: () => options.nix.daemonTrust(),
		invocationId,
		helper: { executablePath },
		runtime: { environment: options.environment }
	});
	const { directory, socketPath } = preflight.runtimePlan;
	const hookScriptPath = path.join(directory, 'post-build-hook.sh');
	const deliveryErrorFile = path.join(directory, 'hook-delivery-errors.txt');
	let listener: BuildEventListener | undefined;
	const rejections: BuildEventRejectedError[] = [];

	try {
		await createRuntimeDirectory(directory);
		await writeFile(deliveryErrorFile, '', { mode: 0o600 });
		await writeFile(
			hookScriptPath,
			renderHookScript({
				invocationId,
				helperPath: preflight.helperPath,
				socketPath,
				deliveryErrorFile,
				...(preflight.outputProtection.kind === 'daemonless-gc-roots' && {
					rootLinkDirectory: options.protection.directory,
					indirectRootLinks: true
				})
			}),
			{ mode: 0o700 }
		);
		listener = await BuildEventListener.listen({
			socketPath,
			storeDirectory: options.config.storeDirectory,
			onEvent: async (event, signal) => {
				if (
					event.invocationId !== invocationId ||
					event.outputProtection === 'failed'
				) {
					throw new BuildObservationIncompleteError();
				}
				await options.protection.protect(event.outputPaths, signal);
			},
			onRejected(error) {
				rejections.push(error);
			}
		});
	} catch (error) {
		return withCleanups(() => {
			throw error;
		}, [
			() => listener?.close() ?? Promise.resolve(),
			() => removeInvocationRuntimeDirectory(directory)
		]);
	}

	const checkComplete = async (): Promise<void> => {
		const errors = await readFile(deliveryErrorFile, 'utf8');
		if (errors === '' && rejections.length === 0) {
			return;
		}
		const causes: Error[] = [...rejections];
		if (errors !== '') {
			causes.push(new Error(errors.trim()));
		}
		throw new BuildObservationIncompleteError({
			cause: new AggregateError(
				causes,
				'Build hook delivery or output protection failed'
			)
		});
	};
	const opened = listener;
	let isClosed = false;
	return {
		environment: environmentWithPostBuildHook(
			options.environment,
			hookScriptPath
		),
		get events() {
			return opened.accepted;
		},
		async flush() {
			await opened.flush();
			await checkComplete();
		},
		async close() {
			if (isClosed) {
				return;
			}
			isClosed = true;
			await withCleanups(async () => {
				await opened.drain();
				await checkComplete();
			}, [
				() => opened.close(),
				() => removeInvocationRuntimeDirectory(directory)
			]);
		}
	};
}
