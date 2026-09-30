import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { renderNetrc } from '@cupboard/nix-store/nix-config';
import { type AuthorizationDetails } from '@cupboard/protocol/grants';
import { type ReadResourceState } from '@cupboard/protocol/read-access';
import { bestEffort, withCleanup } from '@cupboard/shared/cleanup';

import { abortable, abortReason, delayMs, throwIfAborted } from '../abort.ts';
import { CliError } from '../errors.ts';

import { writeSecretFile } from './secret-file.ts';

const defaultRenewalMarginMs = 5 * 60 * 1000;
const defaultSafetyMarginMs = 30 * 1000;
const defaultRetryDelayMs = 30 * 1000;

export interface ReadCredentialLease {
	readonly user: string;
	readonly password: string;
	readonly expiresAtMs: number;
	readonly resources?: readonly ReadResourceState[];
	readonly authorizationDetails?: AuthorizationDetails;
}

export interface ReadCredentialFile {
	readonly path: string;
	readonly factsPath?: string;
	replace(credential: ReadCredentialLease, signal: AbortSignal): Promise<void>;
	remove(): Promise<void>;
}

export interface ReadCredentialSessionOptions {
	readonly url: URL;
	readonly existingNetrc?: string;
	readonly issue: (signal: AbortSignal) => Promise<ReadCredentialLease>;
	readonly createFile?: () => Promise<ReadCredentialFile>;
	readonly now?: () => number;
	readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	readonly signal?: AbortSignal;
	readonly renewalMarginMs?: number;
	readonly safetyMarginMs?: number;
	readonly retryDelayMs?: number;
}

export class ReadCredentialRenewalError extends CliError {
	constructor() {
		super(
			'Could not renew cache read access before its credential expires. Check the workflow OIDC permission and the cache read trust rule.'
		);
		this.name = 'ReadCredentialRenewalError';
	}
}

export class ReadCredentialPublicationError extends CliError {
	constructor() {
		super(
			'Could not update the temporary cache read credential file before the current credential expires. Check that the runtime directory is writable.'
		);
		this.name = 'ReadCredentialPublicationError';
	}
}

/**
 * Installs a temporary netrc for one owned Nix operation and renews its read
 * credential while the operation runs. The callback must stop when its signal
 * aborts, so cleanup can wait for it before removing the file.
 */
export async function withRenewingReadCredential<T>(
	options: ReadCredentialSessionOptions,
	operation: (context: {
		readonly netrcFile: string;
		readonly factsFile?: string;
		readonly signal: AbortSignal;
	}) => Promise<T>
): Promise<T> {
	const controller = new AbortController();
	const abort = (): void => {
		controller.abort(
			options.signal === undefined ? undefined : abortReason(options.signal)
		);
	};
	options.signal?.addEventListener('abort', abort, { once: true });

	try {
		if (options.signal?.aborted === true) {
			abort();
		}
		throwIfAborted(controller.signal);

		const now = options.now ?? Date.now;
		const safetyMarginMs = options.safetyMarginMs ?? defaultSafetyMarginMs;
		const first = await abortable(
			options.issue(controller.signal),
			controller.signal
		);
		if (first.expiresAtMs - now() <= safetyMarginMs) {
			throw new ReadCredentialRenewalError();
		}

		const file = await (options.createFile?.() ??
			createTemporaryReadCredentialFile(options.url, options.existingNetrc));

		return await withCleanup(
			async () => {
				await file.replace(first, controller.signal);
				if (first.expiresAtMs - now() <= safetyMarginMs) {
					throw new ReadCredentialRenewalError();
				}
				const renewal = renewWhileRunning(first, file, options, controller);

				try {
					const result = await operation({
						netrcFile: file.path,
						...(file.factsPath !== undefined && { factsFile: file.factsPath }),
						signal: controller.signal
					});
					throwIfAborted(controller.signal);

					return result;
				} catch (error) {
					if (
						controller.signal.reason instanceof ReadCredentialRenewalError ||
						controller.signal.reason instanceof ReadCredentialPublicationError
					) {
						throw controller.signal.reason;
					}

					throw error;
				} finally {
					controller.abort();
					await renewal;
				}
			},
			() => file.remove()
		);
	} finally {
		options.signal?.removeEventListener('abort', abort);
	}
}

async function renewWhileRunning(
	initial: ReadCredentialLease,
	file: ReadCredentialFile,
	options: ReadCredentialSessionOptions,
	controller: AbortController
): Promise<void> {
	const now = options.now ?? Date.now;
	const wait = options.wait ?? ((ms, signal) => delayMs(ms, { signal }));
	const renewalMarginMs = options.renewalMarginMs ?? defaultRenewalMarginMs;
	const safetyMarginMs = options.safetyMarginMs ?? defaultSafetyMarginMs;
	const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
	let current = initial;

	try {
		for (;;) {
			throwIfAborted(controller.signal);
			const untilRenewal = current.expiresAtMs - renewalMarginMs - now();
			await wait(Math.max(0, untilRenewal), controller.signal);
			current = await renewBeforeExpiry(
				current,
				file,
				options.issue,
				controller,
				now,
				wait,
				safetyMarginMs,
				retryDelayMs
			);
		}
	} catch (error) {
		if (!controller.signal.aborted) {
			controller.abort(
				error instanceof ReadCredentialPublicationError
					? error
					: new ReadCredentialRenewalError()
			);
		}
	}
}

async function renewBeforeExpiry(
	current: ReadCredentialLease,
	file: ReadCredentialFile,
	issue: (signal: AbortSignal) => Promise<ReadCredentialLease>,
	controller: AbortController,
	now: () => number,
	wait: (milliseconds: number, signal: AbortSignal) => Promise<void>,
	safetyMarginMs: number,
	retryDelayMs: number
): Promise<ReadCredentialLease> {
	let lastFailure: ReadCredentialRenewalError | ReadCredentialPublicationError =
		new ReadCredentialRenewalError();

	for (;;) {
		throwIfAborted(controller.signal);
		const remaining = current.expiresAtMs - safetyMarginMs - now();
		if (remaining <= 0) {
			throw lastFailure;
		}

		const attempt = new AbortController();
		const stopAttempt = (): void => {
			attempt.abort(abortReason(controller.signal));
		};
		controller.signal.addEventListener('abort', stopAttempt, { once: true });
		let publication: Promise<void> | undefined;

		try {
			const deadline = async (): Promise<never> => {
				await wait(remaining, attempt.signal);
				controller.abort(lastFailure);

				throw lastFailure;
			};
			const due = deadline();
			lastFailure = new ReadCredentialRenewalError();
			const next = await Promise.race([issue(attempt.signal), due]);
			throwIfAborted(controller.signal);
			if (next.expiresAtMs - now() <= safetyMarginMs) {
				throw new ReadCredentialRenewalError();
			}

			lastFailure = new ReadCredentialPublicationError();
			publication = file.replace(next, attempt.signal);
			await Promise.race([publication, due]);
			throwIfAborted(controller.signal);

			return next;
		} catch {
			const pendingPublication = publication;
			if (pendingPublication !== undefined && controller.signal.aborted) {
				await bestEffort(() => pendingPublication);
			}

			if (controller.signal.aborted) {
				throw lastFailure;
			}

			const beforeDeadline = current.expiresAtMs - safetyMarginMs - now();
			if (beforeDeadline <= 0) {
				throw lastFailure;
			}

			await wait(Math.min(retryDelayMs, beforeDeadline), controller.signal);
		} finally {
			attempt.abort();
			controller.signal.removeEventListener('abort', stopAttempt);
		}
	}
}

async function createTemporaryReadCredentialFile(
	url: URL,
	existingNetrc: string | undefined
): Promise<ReadCredentialFile> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-read-'));
	const file = path.join(directory, 'netrc');
	const factsPath = path.join(directory, 'read-access.json');

	return {
		path: file,
		factsPath,
		replace: async (credential, signal) => {
			await writeSecretFile(
				file,
				`${renderNetrc(url, credential.user, credential.password)}${existingNetrc ?? ''}`,
				signal
			);

			if (credential.resources !== undefined) {
				await writeSecretFile(
					factsPath,
					JSON.stringify({
						read_resources: credential.resources,
						authorization_details: credential.authorizationDetails ?? []
					}),
					signal
				);
			}
		},
		remove: () => rm(directory, { recursive: true, force: true })
	};
}
