import { randomBytes } from 'node:crypto';

import { ORPCError } from '@orpc/client';
import { StatusCodes } from 'http-status-codes';

import { abortable, type Delay, delayMs, throwIfAborted } from '../abort.ts';

import type { CloudflareApi } from './cloudflare-api.ts';
import type { ScriptName } from './identifiers.ts';

const unauthorisedStatus: number = StatusCodes.UNAUTHORIZED;

export const controlDatabaseValidationSecretName =
	'CONTROL_DATABASE_VALIDATION_SECRET';

interface ValidationOptions {
	readonly api: Pick<CloudflareApi, 'putSecret'>;
	readonly cleanupApi: Pick<CloudflareApi, 'deleteSecret'>;
	readonly scriptName: ScriptName;
	readonly signal?: AbortSignal;
	readonly sleep?: Delay;
	readonly validate: (secret: string, signal: AbortSignal) => Promise<unknown>;
}

/**
Validates copied keys with a temporary control-only deployment secret.
*/
export async function validateTransferredControlDatabase(
	options: ValidationOptions
): Promise<void> {
	throwIfAborted(options.signal);
	const secret = randomBytes(32).toString('base64url');
	await options.api.putSecret(options.scriptName, {
		name: controlDatabaseValidationSecretName,
		text: secret
	});
	const deadline = new AbortController();
	const timer = setTimeout(() => {
		deadline.abort(
			new DOMException(
				'Control database validation did not complete within 60 seconds',
				'TimeoutError'
			)
		);
	}, 60_000);
	const signal =
		options.signal === undefined
			? deadline.signal
			: AbortSignal.any([options.signal, deadline.signal]);

	try {
		for (;;) {
			throwIfAborted(signal);
			try {
				await abortable(options.validate(secret, signal), signal);
				throwIfAborted(signal);
				return;
			} catch (error) {
				throwIfAborted(signal);
				if (
					!(error instanceof ORPCError) ||
					error.code !== 'UNAUTHORIZED' ||
					error.status !== unauthorisedStatus
				) {
					throw error;
				}
			}
			await delayMs(5000, { signal, delay: options.sleep });
		}
	} catch (error) {
		throwIfAborted(signal);
		throw error;
	} finally {
		clearTimeout(timer);
		await options.cleanupApi.deleteSecret(
			options.scriptName,
			controlDatabaseValidationSecretName
		);
	}
}
