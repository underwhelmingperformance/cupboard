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

/**
 * Where cached sessions live, within the CLI's configuration directory.
 * Sessions are keyed per target, so logging in to one tenant does not make
 * its tokens usable against another tenant on the same host. Exposed so the
 * login command can disclose where it cached the session.
 */
export function tokensDirectory(): string {
	return path.join(configDirectory(), 'tokens');
}

// A target's session: the access token every request carries and, when the
// server granted one, the rotating refresh token that renews it silently.
const cachedSessionSchema = z.object({
	accessToken: z.string().min(1),
	refreshToken: z.string().min(1).optional()
});
export type CachedSession = z.output<typeof cachedSessionSchema>;

/** Maps a token endpoint's response to the session shape the cache holds. */
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

	// A cached session is reused only against the target it was issued for: the
	// access token's issuer must be that target, and its audience must admit
	// it. This stops a session cached for one tenant being sent to another on
	// the same host.
	return isTokenBoundToTarget(session.accessToken, normalised)
		? session
		: undefined;
}

/**
 * Persists the session for a target, readable only by the current user. It is
 * written to a fresh `0600` temporary file (exclusive create, so a pre-planted
 * symlink is not followed) and renamed over the target atomically; the directory
 * is created and its mode reasserted to `0700`. The file is therefore never
 * readable by anyone else, not even for the moment between its creation and
 * its mode being set.
 */
export async function writeCachedSession(
	session: CachedSession,
	target: URL
): Promise<void> {
	await writeSecretFile(
		tokenFilePath(canonicalHref(target)),
		`${JSON.stringify(session)}\n`
	);
}

function parseSession(contents: string): CachedSession | undefined {
	const trimmed = contents.trim();

	if (trimmed === '') {
		return undefined;
	}

	// A cache file from before sessions holds the bare access token.
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

// Whether a token's signed claims bind it to this target. The issuer is the
// per-target binding: a tenant issues `iss` equal to its base URL, the control
// plane issues `iss` equal to the bare host, so an issuer match alone rules out
// cross-target reuse. The audience must also admit the target: a tenant token's
// audience is the target URL, while a control token's audience is a configured
// client id (non-URL), so a non-URL audience is accepted too.
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
