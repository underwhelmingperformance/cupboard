import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { env } from 'node:process';

import { z } from 'zod';

/**
 * Where cached access tokens live: under `$XDG_CONFIG_HOME` when set, otherwise
 * `~/.config`. Tokens are keyed per target, so logging in to one tenant does not
 * make its token usable against another tenant on the same host.
 */
function tokensDirectory(): string {
	const base =
		env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== ''
			? env.XDG_CONFIG_HOME
			: path.join(homedir(), '.config');

	return path.join(base, 'cupboard', 'tokens');
}

/**
 * The canonical form of a target URL: a parsed URL with any trailing slash
 * removed, so the same target keys the same cache entry and matches the issuer a
 * tenant mints regardless of how the URL was typed.
 */
export function normaliseTarget(target: string): string {
	return new URL(target).href.replace(/\/+$/, '');
}

function tokenFilePath(normalisedTarget: string): string {
	const key = createHash('sha256').update(normalisedTarget).digest('hex');

	return path.join(tokensDirectory(), key);
}

export async function readCachedToken(
	target: string
): Promise<string | undefined> {
	const normalised = normaliseTarget(target);
	const token = await readTokenFile(tokenFilePath(normalised));

	if (token === undefined) {
		return undefined;
	}

	// A cached token is reused only against the target it was minted for: its
	// issuer must be that target, and its audience must admit it. This stops a
	// token cached for one tenant being sent to another on the same host.
	return tokenBoundToTarget(token, normalised) ? token : undefined;
}

/**
 * Persists the token for a target, readable only by the current user. It is
 * written to a fresh `0600` temporary file (exclusive create, so a pre-planted
 * symlink is not followed) and renamed over the target atomically; the directory
 * is created and its mode reasserted to `0700`. This avoids the window an
 * in-place write leaves between creating the file and tightening its mode.
 */
export async function writeCachedToken(
	token: string,
	target: string
): Promise<void> {
	await writeTokenFile(tokenFilePath(normaliseTarget(target)), token);
}

async function readTokenFile(file: string): Promise<string | undefined> {
	let contents: string;

	try {
		contents = await readFile(file, 'utf8');
	} catch (error) {
		if (isNotFound(error)) {
			return undefined;
		}

		throw error;
	}

	const token = contents.trim();

	return token === '' ? undefined : token;
}

async function writeTokenFile(file: string, token: string): Promise<void> {
	const directory = path.dirname(file);

	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);

	const temporary = path.join(
		directory,
		`.token.${randomBytes(8).toString('hex')}`
	);
	await writeFile(temporary, `${token}\n`, { mode: 0o600, flag: 'wx' });
	await rename(temporary, file);
}

const jwtClaimsSchema = z.object({
	iss: z.string().optional(),
	aud: z.union([z.string(), z.array(z.string())]).optional()
});

// Whether a token's signed claims bind it to this target. The issuer is the
// per-target binding: a tenant mints `iss` equal to its base URL, the control
// plane mints `iss` equal to the bare host, so an issuer match alone rules out
// cross-target reuse. The audience must also admit the target: a tenant token's
// audience is the target URL, while a control token's audience is a configured
// client id rather than a URL, so a non-URL audience is accepted too.
function tokenBoundToTarget(token: string, target: string): boolean {
	const claims = decodeJwtClaims(token);

	if (claims?.iss !== target) {
		return false;
	}

	return audienceAdmits(claims.aud, target);
}

function audienceAdmits(
	aud: string | readonly string[] | undefined,
	target: string
): boolean {
	if (aud === undefined) {
		return false;
	}

	const audiences: readonly string[] = typeof aud === 'string' ? [aud] : aud;

	return (
		audiences.includes(target) ||
		!audiences.some((audience) => isHttpUrl(audience))
	);
}

function decodeJwtClaims(
	token: string
): { iss?: string; aud?: string | string[] } | undefined {
	const segment = token.split('.').at(1);

	if (segment === undefined) {
		return undefined;
	}

	let payload: unknown;

	try {
		payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
	} catch {
		return undefined;
	}

	const result = jwtClaimsSchema.safeParse(payload);

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

function isNotFound(error: unknown): boolean {
	return (
		error instanceof Error && (error as { code?: string }).code === 'ENOENT'
	);
}
