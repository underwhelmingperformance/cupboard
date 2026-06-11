import Cloudflare from 'cloudflare';

import { CliError } from '../errors.ts';

import type { CloudflareApi } from './cloudflare-api.ts';
import { createCloudflareApi } from './cloudflare-api.ts';
import {
	type CloudflareGrant,
	cloudflareLogin,
	refreshCloudflareGrant
} from './cloudflare-oauth.ts';
import { readCachedGrant, writeCachedGrant } from './grant-store.ts';

/** The resolved credential can see no Cloudflare accounts at all. */
export class NoCloudflareAccountsError extends CliError {
	constructor() {
		super('The credential has access to no accounts.');
		this.name = 'NoCloudflareAccountsError';
	}
}

export type CredentialSource =
	| 'environment'
	| 'cached login'
	| 'wrangler'
	| 'browser login';

export interface CloudflareCredential {
	readonly token: string;
	readonly source: CredentialSource;
}

/**
 * How the credential chain talks to the world; injectable so resolution order
 * is testable without real files, endpoints, or a browser.
 */
export interface CredentialChain {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly readGrant: () => Promise<CloudflareGrant | undefined>;
	readonly writeGrant: (grant: CloudflareGrant) => Promise<void>;
	readonly refreshGrant: (
		refreshToken: string
	) => Promise<CloudflareGrant | undefined>;
	/** Absent when a logged-in wrangler's stored token must not be used. */
	readonly readWranglerToken?: () => Promise<string | undefined>;
	readonly login: () => Promise<CloudflareGrant>;
	readonly now: () => number;
}

export interface CredentialChainOptions {
	readonly openBrowser: (url: string) => void | Promise<void>;
	/** Whether a logged-in wrangler's stored token may be used. */
	readonly wrangler: boolean;
}

/** The production {@link CredentialChain}: real store, endpoints and browser. */
export function defaultCredentialChain(
	options: CredentialChainOptions
): CredentialChain {
	return {
		env: process.env,
		readGrant: readCachedGrant,
		writeGrant: writeCachedGrant,
		refreshGrant: (refreshToken) => refreshCloudflareGrant(refreshToken),
		...(options.wrangler ? { readWranglerToken } : {}),
		login: () => cloudflareLogin({ openBrowser: options.openBrowser }),
		now: Date.now
	};
}

// Reuse wrangler's stored OAuth token when one is available. The package is
// internal to workers-sdk, so failures here are non-fatal.
async function readWranglerToken(): Promise<string | undefined> {
	try {
		const { readAuthConfigFile } = await import('@cloudflare/workers-auth');
		const config = readAuthConfigFile();

		return config.oauth_token === '' ? undefined : config.oauth_token;
	} catch {
		return undefined;
	}
}

// An access token within a minute of expiry is treated as expired: it must
// survive the whole deploy, not just the first request.
const expiryMarginMs = 60 * 1000;

function usable(grant: CloudflareGrant, now: number): boolean {
	return now < grant.expiresAt - expiryMarginMs;
}

/**
 * Resolve a Cloudflare credential, in order: the environment
 * (`CLOUDFLARE_API_TOKEN`/`CF_API_TOKEN`), the cached cupboard login (renewed
 * from its refresh token when expired), a logged-in wrangler's stored token,
 * and finally an interactive browser login, which is cached for next time.
 */
export async function resolveCredential(
	chain: CredentialChain
): Promise<CloudflareCredential> {
	const fromEnv = chain.env.CLOUDFLARE_API_TOKEN ?? chain.env.CF_API_TOKEN;

	if (fromEnv !== undefined && fromEnv !== '') {
		return { token: fromEnv, source: 'environment' };
	}

	const cached = await chain.readGrant();

	if (cached !== undefined && usable(cached, chain.now())) {
		return { token: cached.accessToken, source: 'cached login' };
	}

	if (cached?.refreshToken !== undefined) {
		const renewed = await chain.refreshGrant(cached.refreshToken);

		if (renewed !== undefined) {
			await chain.writeGrant(renewed);

			return { token: renewed.accessToken, source: 'cached login' };
		}
	}

	const wrangler = await chain.readWranglerToken?.();

	if (wrangler !== undefined) {
		return { token: wrangler, source: 'wrangler' };
	}

	const grant = await chain.login();
	await chain.writeGrant(grant);

	return { token: grant.accessToken, source: 'browser login' };
}

export interface ResolvedAccount {
	readonly client: Cloudflare;
	readonly api: CloudflareApi;
	readonly accountId: string;
	readonly credentialSource: CredentialSource;
}

/**
 * Build an authenticated client and settle on an account: explicit option, then
 * `CLOUDFLARE_ACCOUNT_ID`, then the sole account on the credential, otherwise
 * prompt.
 */
export async function resolveCloudflare(
	accountOption: string | undefined,
	chooseAccount: (
		accounts: readonly { id: string; name: string }[]
	) => Promise<string>,
	chain: CredentialChain
): Promise<ResolvedAccount> {
	const credential = await resolveCredential(chain);
	const client = new Cloudflare({ apiToken: credential.token });

	const fromEnv = accountOption ?? chain.env.CLOUDFLARE_ACCOUNT_ID;

	if (fromEnv !== undefined && fromEnv !== '') {
		return {
			client,
			api: createCloudflareApi(client, fromEnv),
			accountId: fromEnv,
			credentialSource: credential.source
		};
	}

	const probe = createCloudflareApi(client, '');
	const accounts = await probe.listAccounts();

	if (accounts.length === 0) {
		throw new NoCloudflareAccountsError();
	}

	const accountId =
		accounts.length === 1 && accounts[0] !== undefined
			? accounts[0].id
			: await chooseAccount(accounts);

	return {
		client,
		api: createCloudflareApi(client, accountId),
		accountId,
		credentialSource: credential.source
	};
}
