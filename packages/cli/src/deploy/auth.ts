import Cloudflare from 'cloudflare';

import type { CloudflareApi } from './cloudflare-api.ts';
import { createCloudflareApi } from './cloudflare-api.ts';

export class CloudflareAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CloudflareAuthError';
	}
}

/**
 * Resolve a Cloudflare API token, preferring the environment and falling back to
 * the token a logged-in wrangler already stored. Returns undefined when neither
 * is available so the caller can give actionable guidance.
 */
export async function resolveApiToken(): Promise<string | undefined> {
	const fromEnv = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;

	if (fromEnv !== undefined && fromEnv !== '') {
		return fromEnv;
	}

	// Reuse wrangler's stored OAuth token rather than build our own login flow.
	// The package is internal to workers-sdk, so failures here are non-fatal.
	try {
		const { readAuthConfigFile } = await import('@cloudflare/workers-auth');
		const config = readAuthConfigFile();

		return config.oauth_token === '' ? undefined : config.oauth_token;
	} catch {
		return undefined;
	}
}

export interface ResolvedAccount {
	readonly client: Cloudflare;
	readonly api: CloudflareApi;
	readonly accountId: string;
}

/**
 * Build an authenticated client and settle on an account: explicit option, then
 * `CLOUDFLARE_ACCOUNT_ID`, then the sole account on the token, otherwise prompt.
 */
export async function resolveCloudflare(
	accountOption: string | undefined,
	chooseAccount: (
		accounts: readonly { id: string; name: string }[]
	) => Promise<string>
): Promise<ResolvedAccount> {
	const apiToken = await resolveApiToken();

	if (apiToken === undefined) {
		throw new CloudflareAuthError(
			'No Cloudflare credentials found. Set CLOUDFLARE_API_TOKEN or run `wrangler login`.'
		);
	}

	const client = new Cloudflare({ apiToken });

	const fromEnv = accountOption ?? process.env.CLOUDFLARE_ACCOUNT_ID;
	const probe = createCloudflareApi(client, fromEnv ?? '');

	if (fromEnv !== undefined && fromEnv !== '') {
		return { client, api: probe, accountId: fromEnv };
	}

	const accounts = await probe.listAccounts();

	if (accounts.length === 0) {
		throw new CloudflareAuthError('The token has access to no accounts.');
	}

	const accountId =
		accounts.length === 1 && accounts[0] !== undefined
			? accounts[0].id
			: await chooseAccount(accounts);

	return { client, api: createCloudflareApi(client, accountId), accountId };
}
