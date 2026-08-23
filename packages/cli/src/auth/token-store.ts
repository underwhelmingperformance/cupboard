import { createHash } from 'node:crypto';
import path from 'node:path';

import { canonicalHref } from '@cupboard/nix-store/url';
import type { ParsedTokenResponse } from '@cupboard/protocol/oidc';
import { z } from 'zod';

import { decodeJwtPayload } from './jwt.ts';
import {
	configDirectory,
	readSecretFile,
	writeSecretFile
} from './secret-file.ts';
import { withSecretFileLock } from './secret-lock.ts';

/**
 * Where cached sessions live, within the CLI's configuration directory.
 * Sessions are keyed per target, so logging in to one tenant does not make
 * its tokens usable against another tenant on the same host. Exposed so the
 * login command can disclose where it cached the session.
 */
export function tokensDirectory(): string {
	return path.join(configDirectory(), 'tokens');
}

const cachedSessionSchema = z.object({
	accessToken: z.string().min(1),
	refreshToken: z.string().min(1).optional()
});
export type CachedSession = z.output<typeof cachedSessionSchema>;

export function sessionFromTokenResponse(
	response: Pick<ParsedTokenResponse, 'access_token' | 'refresh_token'>
): CachedSession {
	return {
		accessToken: response.access_token,
		...(response.refresh_token !== undefined && {
			refreshToken: response.refresh_token
		})
	};
}

function tokenFilePath(normalisedTarget: string): string {
	const key = createHash('sha256').update(normalisedTarget).digest('hex');

	return path.join(tokensDirectory(), key);
}

/**
 * Serialises the session read, refresh-token rotation, and replacement for one
 * target across CLI processes. The lock directory is kept alive while the
 * operation runs, so a slow token endpoint does not make a live lock stale.
 */
export async function withCachedSessionLock<T>(
	target: URL,
	action: (signal?: AbortSignal) => Promise<T>,
	signal?: AbortSignal
): Promise<T> {
	const file = tokenFilePath(canonicalHref(target));

	return withSecretFileLock(file, action, signal);
}

export async function readCachedSession(
	target: URL
): Promise<CachedSession | undefined> {
	// The canonical rendering keys the cache entry and matches the issuer a
	// tenant writes into its tokens, however the URL was typed.
	const normalised = canonicalHref(target);
	const contents = await readSecretFile(tokenFilePath(normalised));

	if (contents === undefined) {
		return undefined;
	}

	const session = parseSession(contents);

	if (session === undefined) {
		return undefined;
	}

	// Use the decoded issuer and audience only to select a cached session. These
	// claims are not verified here; the server verifies the token when it is used.
	return isTokenBoundToTarget(session.accessToken, normalised)
		? session
		: undefined;
}

/**
 * Persists the session for a target in the CLI's owner-only configuration
 * directory. The file is replaced atomically so readers see the previous
 * session or the complete replacement.
 */
export async function writeCachedSession(
	session: CachedSession,
	target: URL,
	signal?: AbortSignal
): Promise<void> {
	await writeSecretFile(
		tokenFilePath(canonicalHref(target)),
		`${JSON.stringify(session)}\n`,
		signal
	);
}

function parseSession(contents: string): CachedSession | undefined {
	const trimmed = contents.trim();

	if (trimmed === '') {
		return undefined;
	}

	// Cache files written before refresh sessions contain only the access token.
	if (!trimmed.startsWith('{')) {
		return { accessToken: trimmed };
	}

	let payload: unknown;

	try {
		payload = JSON.parse(trimmed);
	} catch {
		return undefined;
	}

	const session = cachedSessionSchema.safeParse(payload);

	return session.success ? session.data : undefined;
}

const stringArraySchema = z.array(z.string());

const jwtClaimsSchema = z.object({
	iss: z.string().optional(),
	aud: z.union([z.string(), stringArraySchema]).optional()
});

// A tenant token uses its target URL as issuer and audience. A control token
// uses the bare deployment URL as issuer and a non-URL client id as audience,
// so admit non-URL audiences when selecting a cached control session.
function isTokenBoundToTarget(token: string, target: string): boolean {
	const claims = decodeJwtClaims(token);

	if (claims?.iss !== target) {
		return false;
	}

	return isAudienceAdmitted(claims.aud, target);
}

function isAudienceAdmitted(
	aud: string | readonly string[] | undefined,
	target: string
): boolean {
	if (aud === undefined) {
		return false;
	}

	const audiences: readonly string[] = typeof aud === 'string' ? [aud] : aud;

	return (
		audiences.includes(target) ||
		audiences.every((audience) => !isHttpUrl(audience))
	);
}

function decodeJwtClaims(
	token: string
): undefined | { iss?: string; aud?: string | string[] } {
	const result = jwtClaimsSchema.safeParse(decodeJwtPayload(token));

	return result.success ? result.data : undefined;
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);

		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}
