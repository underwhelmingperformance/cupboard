import path from 'node:path';

import { z } from 'zod';

import {
	configDirectory,
	readSecretFile,
	writeSecretFile
} from '../auth/secret-file.ts';

import type { CloudflareGrant } from './cloudflare-oauth.ts';

function grantFilePath(): string {
	return path.join(configDirectory(), 'cloudflare-grant.json');
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
 * again rather than failing).
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
		subject: parsed.data.subject
	};
}

/** Persists a Cloudflare grant, readable only by the current user. */
export async function writeCachedGrant(grant: CloudflareGrant): Promise<void> {
	const stored: z.infer<typeof storedGrantSchema> = {
		access_token: grant.accessToken,
		...(grant.refreshToken === undefined
			? {}
			: { refresh_token: grant.refreshToken }),
		expires_at: grant.expiresAt,
		...(grant.subject === undefined ? {} : { subject: grant.subject })
	};

	await writeSecretFile(grantFilePath(), `${JSON.stringify(stored)}\n`);
}
