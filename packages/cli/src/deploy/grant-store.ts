import path from 'node:path';

import { z } from 'zod';

import type { RevocationOutcome } from '../auth/revocation.ts';
import {
	configDirectory,
	readSecretFile,
	type Removal,
	removeSecretFile,
	writeSecretFile
} from '../auth/secret-file.ts';
import { withSecretFileLock } from '../auth/secret-lock.ts';

import type { CloudflareGrant } from './cloudflare-oauth.ts';

function grantFilePath(): string {
	return path.join(configDirectory(), 'cloudflare-grant.json');
}

/**
 * Serialises Cloudflare grant renewal and replacement across CLI processes.
 */
export function withCachedGrantLock<T>(
	action: (signal?: AbortSignal) => Promise<T>,
	signal?: AbortSignal
): Promise<T> {
	return withSecretFileLock(grantFilePath(), action, signal);
}

const storedGrantSchema = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().min(1).optional(),
	expires_at: z.number().int(),
	subject: z.string().min(1).optional()
});

/**
 * Reads the cached Cloudflare grant, or undefined when none is stored or the
 * file does not parse (a corrupt cache reads as absent, so the caller logs in
 * again on parse failure). The grant has no ID token: the store never keeps
 * one, and it drops the `id_token` of a file written by an earlier release.
 */
export async function readCachedGrant(): Promise<CloudflareGrant | undefined> {
	const contents = await readSecretFile(grantFilePath());

	if (contents === undefined) {
		return undefined;
	}

	let payload: unknown;

	try {
		payload = JSON.parse(contents);
	} catch {
		return undefined;
	}

	const parsed = storedGrantSchema.safeParse(payload);

	if (!parsed.success) {
		return undefined;
	}

	return {
		accessToken: parsed.data.access_token,
		refreshToken: parsed.data.refresh_token,
		expiresAt: parsed.data.expires_at,
		subject: parsed.data.subject,
		idToken: undefined
	};
}

/**
 * Writes the cached grant to an owner-only `0600` file.
 */
export async function writeCachedGrant(
	grant: CloudflareGrant,
	signal?: AbortSignal
): Promise<void> {
	const stored: z.infer<typeof storedGrantSchema> = {
		access_token: grant.accessToken,
		...(grant.refreshToken !== undefined && {
			refresh_token: grant.refreshToken
		}),
		expires_at: grant.expiresAt,
		...(grant.subject !== undefined && { subject: grant.subject })
	};

	await writeSecretFile(grantFilePath(), `${JSON.stringify(stored)}\n`, signal);
}

/**
 * The result of deleting the cached grant. `revocation` is present when the
 * file contained a grant, and is `failed` when the file could not be read.
 */
export interface GrantRemoval {
	readonly removal: Removal;
	readonly revocation?: RevocationOutcome;
}

/**
 * Revokes and deletes the cached Cloudflare grant under its renewal lock, so a
 * concurrent refresh cannot write it back or rotate the token that `revoke`
 * receives. The file is deleted whatever the revocation's outcome.
 */
export async function removeCachedGrant(
	revoke: (grant: CloudflareGrant) => Promise<RevocationOutcome>,
	signal?: AbortSignal
): Promise<GrantRemoval> {
	const file = grantFilePath();

	return withCachedGrantLock(async () => {
		const revocation = await revokeReadableGrant(revoke);
		const removal = await removeSecretFile(file);

		return removal === 'removed' && revocation !== undefined
			? { removal, revocation }
			: { removal };
	}, signal);
}

async function revokeReadableGrant(
	revoke: (grant: CloudflareGrant) => Promise<RevocationOutcome>
): Promise<RevocationOutcome | undefined> {
	let grant: CloudflareGrant | undefined;

	try {
		grant = await readCachedGrant();
	} catch {
		return 'failed';
	}

	return grant === undefined ? undefined : revoke(grant);
}
