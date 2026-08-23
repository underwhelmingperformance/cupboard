import path from 'node:path';

import { bestEffort, withCleanup } from '@cupboard/shared/cleanup';
import lockfile from 'proper-lockfile';

import { abortable, delayMs, throwIfAborted } from '../abort.ts';

import { ensureSecretDirectory } from './secret-file.ts';

const lockRetryDelayMs = 250;
const lockMaxWaitMs = 120_000;

function isLockHeldError(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ELOCKED';
}

async function acquireSecretFileLock(
	file: string,
	signal: AbortSignal | undefined,
	onCompromised: (error: Error) => void
): Promise<() => Promise<void>> {
	const deadline = Date.now() + lockMaxWaitMs;

	for (;;) {
		throwIfAborted(signal);

		const pending = lockfile.lock(file, {
			realpath: false,
			stale: 60_000,
			update: 20_000,
			retries: 0,
			onCompromised
		});

		try {
			return await abortable(pending, signal);
		} catch (error) {
			if (signal?.aborted === true) {
				void bestEffort(async () => {
					const release = await pending;

					await release();
				});
				throwIfAborted(signal);
			}

			if (!isLockHeldError(error) || Date.now() >= deadline) {
				throw error;
			}
		}

		await abortable(delayMs(lockRetryDelayMs), signal);
	}
}

async function runUntilSettled<T>(
	action: (signal?: AbortSignal) => Promise<T>,
	actionSignal: AbortSignal,
	compromise: Promise<never>,
	compromiseError: () => Error | undefined
): Promise<T> {
	throwIfAborted(actionSignal);
	const pending = action(actionSignal);

	try {
		return await Promise.race([pending, compromise]);
	} catch (error) {
		const lockFailure = compromiseError();

		if (lockFailure === undefined) {
			throw error;
		}

		await bestEffort(async () => pending);

		throw lockFailure;
	}
}

/**
 * Serialises a read-modify-write operation on one secret file across CLI
 * processes. A compromised lock aborts the operation, but the lock is not
 * released until the operation has stopped.
 */
export async function withSecretFileLock<T>(
	file: string,
	action: (signal?: AbortSignal) => Promise<T>,
	signal?: AbortSignal
): Promise<T> {
	await ensureSecretDirectory(path.dirname(file));
	throwIfAborted(signal);

	const compromise = Promise.withResolvers<never>();
	const compromiseController = new AbortController();
	let compromiseError: Error | undefined;
	const onCompromised = (error: Error): void => {
		if (compromiseError !== undefined) {
			return;
		}

		compromiseError = error;
		compromiseController.abort(error);
		compromise.reject(error);
	};
	const release = await acquireSecretFileLock(file, signal, onCompromised);
	const actionSignal =
		signal === undefined
			? compromiseController.signal
			: AbortSignal.any([signal, compromiseController.signal]);

	return withCleanup(
		() =>
			runUntilSettled(
				action,
				actionSignal,
				compromise.promise,
				() => compromiseError
			),
		async () => {
			try {
				await release();
			} catch (error) {
				throw compromiseError ?? error;
			}

			if (compromiseError !== undefined) {
				throw compromiseError;
			}
		}
	);
}
