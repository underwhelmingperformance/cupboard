import { createWriteStream, openAsBlob } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { getIDToken, setSecret } from '@actions/core';
import { cacheUrl, parseTenantCacheUrl } from '@cupboard/nix-store/cache-url';
import {
	type CacheScope,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import { subjectTokenTypeIdToken } from '@cupboard/protocol/oidc';
import {
	invalidPlanArchiveTicketProblem,
	planArchiveErrorResponseSchema,
	planArchiveGrantType,
	planArchiveIdentitySchema,
	planArchiveRecipientSchema,
	planArchiveTicketSchema
} from '@cupboard/protocol/plan-archive';
import { CodedError } from '@cupboard/shared/errors';
import { readResponseJson } from '@cupboard/shared/response-body';
import {
	abortableSleep,
	isFetchNetworkError,
	isTransientResponse,
	maxTransientRetries,
	responseBodyFailureCode,
	retryAfterDelayMs,
	transientRetryBackoff
} from '@cupboard/shared/retry';
import { Decrypter, Encrypter } from 'age-encryption';

import {
	derivationArchiveName,
	type DerivationClosureExport,
	type DerivationClosureImport,
	exportDerivationClosure,
	importDerivationClosure
} from './derivation-closure.ts';
import {
	DerivationClosureImportError,
	MissingDerivationTicketError,
	PlanArchiveConnectionError
} from './errors.ts';

/**
The flake publish workflow downloads this filename into the cohort's temporary directory.
*/
export const encryptedDerivationArchiveName = derivationArchiveName + '.age';

/**
Reports the token endpoint's refusal and the delay before a retry.
*/
export class PlanArchiveExchangeError extends CodedError {
	readonly isTransient: boolean;

	constructor(
		public readonly status: number,
		public readonly problem?: string,
		public readonly retryAfterMs?: number
	) {
		const isTransient = isTransientResponse({ status });
		let recovery = 'Check the server version and tenant OIDC trust policy.';
		if (isTransient) {
			recovery =
				retryAfterMs === undefined || retryAfterMs === 0
					? 'Retry the job when the token endpoint is available.'
					: `Retry the job after ${String(Math.ceil(retryAfterMs / 1000))} seconds.`;
		} else if (status >= 500) {
			recovery = 'Check the token endpoint diagnostics.';
		} else if (problem === invalidPlanArchiveTicketProblem) {
			recovery =
				'Rerun all jobs in the workflow to create a fresh plan archive and ticket.';
		}
		super(
			`Cupboard refused the plan archive key exchange (HTTP ${String(status)}${problem === undefined ? '' : ', ' + problem}). ${recovery}`
		);
		this.name = 'PlanArchiveExchangeError';
		this.isTransient = isTransient;
	}
}

interface ArchiveDependencies {
	readonly signal?: AbortSignal | undefined;
	readonly getToken?: typeof getIDToken;
	readonly mask?: typeof setSecret;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly sleep?: typeof abortableSleep;
	readonly random?: () => number;
	readonly exportClosure?: typeof exportDerivationClosure;
	readonly importClosure?: typeof importDerivationClosure;
}

const maxArchiveRetryDelayMs = 60_000;

interface ArchiveAccess {
	readonly url: URL;
	readonly cache: CacheScope;
}

async function exchange(
	access: ArchiveAccess,
	dependencies: ArchiveDependencies,
	ticket?: string
): Promise<unknown> {
	const { signal } = dependencies;
	const { tenantUrl, cache } = parseTenantCacheUrl(
		cacheUrl(access.url, access.cache)
	);
	const target = canonicalHref(tenantUrl);
	const getToken = dependencies.getToken ?? getIDToken;
	const fields = {
		grant_type: planArchiveGrantType,
		subject_token_type: subjectTokenTypeIdToken,
		...(cache.kind === 'named' && { cache: cache.name }),
		...(ticket !== undefined && { ticket })
	};
	const backoff = transientRetryBackoff(dependencies.random);
	for (let attempt = 1; ; attempt++) {
		signal?.throwIfAborted();
		const body = new URLSearchParams({
			...fields,
			subject_token: await getToken(target)
		});
		let retryAfterMs: number | undefined;
		try {
			return await exchangeOnce(target, body, dependencies);
		} catch (error) {
			signal?.throwIfAborted();
			if (error instanceof PlanArchiveExchangeError) {
				retryAfterMs = error.retryAfterMs;
				if (
					!error.isTransient ||
					attempt > maxTransientRetries ||
					(retryAfterMs ?? 0) > maxArchiveRetryDelayMs
				) {
					throw error;
				}
			} else {
				if (
					!isFetchNetworkError(error) &&
					responseBodyFailureCode(error) === undefined
				) {
					throw error;
				}
				if (attempt > maxTransientRetries) {
					throw new PlanArchiveConnectionError(error);
				}
			}
		}
		await (dependencies.sleep ?? abortableSleep)(
			retryAfterMs !== undefined && retryAfterMs > 0
				? retryAfterMs
				: backoff.delayMs(attempt),
			signal
		);
	}
}

async function exchangeOnce(
	target: string,
	body: URLSearchParams,
	dependencies: ArchiveDependencies
): Promise<unknown> {
	const { signal } = dependencies;
	const response = await (dependencies.fetch ?? fetch)(`${target}/token`, {
		method: 'POST',
		body,
		redirect: 'error',
		...(signal !== undefined && { signal })
	});
	const options = {
		description: 'plan archive grant',
		maximumBytes: 4096,
		...(signal !== undefined && { signal })
	};
	if (!response.ok) {
		let details: unknown;
		try {
			details = await readResponseJson(response, options);
		} catch {
			signal?.throwIfAborted();
		}
		const parsed = planArchiveErrorResponseSchema.safeParse(details);
		throw new PlanArchiveExchangeError(
			response.status,
			parsed.data?.problem,
			retryAfterDelayMs(
				response.headers.get('retry-after'),
				dependencies.now?.()
			)
		);
	}
	return readResponseJson(response, options);
}

async function transformArchive(
	input: string,
	output: string,
	cipher: Encrypter | Decrypter,
	signal?: AbortSignal
): Promise<void> {
	const file = await openAsBlob(input);
	const bytes = file.stream();
	const transformed =
		cipher instanceof Encrypter
			? await cipher.encrypt(bytes)
			: await cipher.decrypt(bytes);
	await pipeline(
		transformed,
		createWriteStream(output, { flags: 'wx', mode: 0o600 }),
		{ signal }
	);
}

/**
Encrypts the verified closure for the public recipient issued to the plan job.
*/
export async function exportEncryptedDerivations(
	derivations: readonly StorePathString[],
	directory: string,
	access: ArchiveAccess,
	dependencies: ArchiveDependencies = {}
): Promise<
	DerivationClosureExport & {
		readonly ticket: string;
		readonly encryptMs: number;
	}
> {
	const { signal } = dependencies;
	const now = dependencies.now ?? Date.now;
	const grant = planArchiveRecipientSchema.parse(
		await exchange(access, dependencies)
	);
	const cipher = new Encrypter();
	cipher.addRecipient(grant.recipient);
	await mkdir(directory, { recursive: true });
	const staging = await mkdtemp(path.join(directory, 'export-'));
	const archive = path.join(staging, encryptedDerivationArchiveName);
	const plaintext = path.join(staging, 'plain');
	try {
		const result = await (
			dependencies.exportClosure ?? exportDerivationClosure
		)(derivations, plaintext, signal);
		const start = now();
		await transformArchive(result.archive, archive, cipher, signal);
		const encryptMs = now() - start;
		const archiveStatus = await stat(archive);
		return {
			...result,
			encryptMs,
			archive,
			archiveBytes: archiveStatus.size,
			ticket: grant.ticket
		};
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	} finally {
		await rm(plaintext, { recursive: true, force: true });
	}
}

/**
Authenticates each age chunk and checks for truncation before unpacking and verifying the store paths.
*/
export async function importEncryptedDerivations(
	archive: string,
	derivations: readonly StorePathString[],
	directory: string,
	access: ArchiveAccess,
	ticket: string | undefined,
	dependencies: ArchiveDependencies = {}
): Promise<DerivationClosureImport & { readonly decryptMs: number }> {
	const { signal } = dependencies;
	const now = dependencies.now ?? Date.now;
	await mkdir(directory, { recursive: true });
	const staging = await mkdtemp(path.join(directory, 'import-'));
	const plaintext = path.join(staging, derivationArchiveName);
	try {
		if (ticket === undefined || ticket === '') {
			throw new MissingDerivationTicketError();
		}
		const validated = planArchiveTicketSchema.parse(ticket);
		const { identity } = planArchiveIdentitySchema.parse(
			await exchange(access, dependencies, validated)
		);
		(dependencies.mask ?? setSecret)(identity);
		const cipher = new Decrypter();
		cipher.addIdentity(identity);
		const start = now();
		try {
			await transformArchive(archive, plaintext, cipher, signal);
		} catch (error) {
			signal?.throwIfAborted();
			throw new DerivationClosureImportError(archive, { cause: error });
		}
		const decryptMs = now() - start;
		await rm(archive);
		const result = await (
			dependencies.importClosure ?? importDerivationClosure
		)(plaintext, derivations, path.join(staging, 'unpacked'), signal);
		return { ...result, decryptMs };
	} finally {
		await rm(staging, { recursive: true, force: true });
		await rm(archive, { force: true });
	}
}
