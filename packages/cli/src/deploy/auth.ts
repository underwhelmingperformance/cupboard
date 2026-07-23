import path from 'node:path';

import type {
	AuthConfigStorage,
	UserAuthConfig
} from '@cloudflare/workers-auth';
import Cloudflare from 'cloudflare';

import { CliError } from '../errors.ts';

import type { AccountSummary, CloudflareApi } from './cloudflare-api.ts';
import { createCloudflareApi } from './cloudflare-api.ts';
import {
	type CloudflareGrant,
	cloudflareLogin,
	jwtExpiryMs,
	refreshCloudflareGrant
} from './cloudflare-oauth.ts';
import { readCachedGrant, writeCachedGrant } from './grant-store.ts';
import {
	type CloudflareAccountId,
	cloudflareAccountIdSchema
} from './identifiers.ts';

/** The resolved credential can see no Cloudflare accounts at all. */
export class NoCloudflareAccountsError extends CliError {
	constructor() {
		super('The credential has access to no accounts.');
		this.name = 'NoCloudflareAccountsError';
	}
}

export type CredentialSource =
	'environment' | 'cached login' | 'wrangler' | 'browser login';

export interface CloudflareCredential {
	readonly token: string;
	readonly source: CredentialSource;
	/** The Cloudflare user behind an OAuth grant; undefined for raw tokens. */
	readonly subject: string | undefined;
	/** The grant's raw id_token, presentable to a cupboard server's signup. */
	readonly idToken: string | undefined;
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
		previous: CloudflareGrant
	) => Promise<CloudflareGrant | undefined>;
	/** Absent when a logged-in wrangler's stored token must not be used. */
	readonly readWranglerToken?: () => Promise<string | undefined>;
	readonly login: () => Promise<CloudflareGrant>;
	/**
	 * Whether an incomplete cached grant may be replaced by a fresh browser
	 * login. A grant from before the `openid` scope carries no subject and its
	 * refresh token cannot grow one, so only a new login can say who the
	 * operator is; without a terminal the old grant is used as-is. (A grant
	 * missing only its id_token upgrades by refresh first, browser second.)
	 */
	readonly upgradeLogin: boolean;
	readonly now: () => number;
}

export interface CredentialChainOptions {
	readonly openBrowser: (url: string) => void | Promise<void>;
	/** Whether a logged-in wrangler's stored token may be used. */
	readonly wrangler: boolean;
	/** Whether a browser is available to upgrade an identity-less grant. */
	readonly interactive: boolean;
	readonly signal?: AbortSignal;
}

/** The production {@link CredentialChain}: real store, endpoints and browser. */
export function defaultCredentialChain(
	options: CredentialChainOptions
): CredentialChain {
	return {
		env: process.env,
		readGrant: readCachedGrant,
		writeGrant: writeCachedGrant,
		refreshGrant: (previous) =>
			refreshCloudflareGrant(previous, fetch, Date.now, options.signal),
		...(options.wrangler && { readWranglerToken }),
		login: () =>
			cloudflareLogin({
				openBrowser: options.openBrowser,
				signal: options.signal
			}),
		upgradeLogin: options.interactive,
		now: Date.now
	};
}

type WorkersUtilities = typeof import('@cloudflare/workers-utils');

// Locate and read wrangler's global auth config the same way wrangler does:
// `<global config dir>/config/<env>.toml`, parsed as the user auth config.
// `readStoredAuthState` only exercises `read`; the rest satisfy the storage
// interface but are never called, as cupboard never mutates wrangler's config.
function wranglerAuthStorage(utilities: WorkersUtilities): AuthConfigStorage {
	const environment = utilities.getCloudflareApiEnvironmentFromEnv();
	const file =
		environment === 'production' ? 'default.toml' : `${environment}.toml`;
	const configPath = path.join(utilities.getGlobalConfigPath(), 'config', file);

	return {
		read: () =>
			utilities.parseTOML(utilities.readFileSync(configPath)) as UserAuthConfig,
		write: () => {
			throw new Error('cupboard does not write wrangler auth config');
		},
		clear: () => false,
		path: () => configPath
	};
}

// Reuse wrangler's stored OAuth token when one is available. The packages are
// internal to workers-sdk, so failures here are non-fatal.
async function readWranglerToken(): Promise<string | undefined> {
	try {
		const [{ readStoredAuthState }, utilities] = await Promise.all([
			import('@cloudflare/workers-auth'),
			import('@cloudflare/workers-utils')
		]);

		const { accessToken } = readStoredAuthState({
			storage: wranglerAuthStorage(utilities)
		});

		return accessToken?.value;
	} catch {
		return undefined;
	}
}

// An access token within a minute of expiry is treated as expired: it must
// survive the whole deploy, not just the first request.
const expiryMarginMs = 60 * 1000;

function isUsable(grant: CloudflareGrant, now: number): boolean {
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
		return {
			token: fromEnv,
			source: 'environment',
			subject: undefined,
			idToken: undefined
		};
	}

	const cached = await chain.readGrant();

	if (cached !== undefined && isUsable(cached, chain.now())) {
		if (cached.subject !== undefined && cached.idToken !== undefined) {
			return {
				token: cached.accessToken,
				source: 'cached login',
				subject: cached.subject,
				idToken: cached.idToken
			};
		}

		// A grant with a subject but no stored id_token was issued with the
		// openid scope, so a refresh reissues the id_token without a browser.
		// The renewal is persisted even without one: the refresh token may have
		// rotated on use.
		if (cached.subject !== undefined) {
			const renewed = await chain.refreshGrant(cached);

			if (renewed !== undefined) {
				await chain.writeGrant(renewed);
			}

			const best = renewed ?? cached;

			if (best.idToken !== undefined || !chain.upgradeLogin) {
				return {
					token: best.accessToken,
					source: 'cached login',
					subject: best.subject,
					idToken: best.idToken
				};
			}
		}

		// Without a terminal the incomplete grant is used as-is; the deploy
		// proceeds, it just cannot present an identity.
		if (!chain.upgradeLogin) {
			return {
				token: cached.accessToken,
				source: 'cached login',
				subject: cached.subject,
				idToken: cached.idToken
			};
		}

		// A grant from before the openid scope cannot learn its identity from a
		// refresh, and a refresh that reissued nothing leaves the identity
		// unproven; only a fresh login can supply it.
		const upgraded = await chain.login();
		await chain.writeGrant(upgraded);

		return {
			token: upgraded.accessToken,
			source: 'browser login',
			subject: upgraded.subject,
			idToken: upgraded.idToken
		};
	}

	if (cached?.refreshToken !== undefined) {
		const renewed = await chain.refreshGrant(cached);

		if (renewed !== undefined) {
			await chain.writeGrant(renewed);

			return {
				token: renewed.accessToken,
				source: 'cached login',
				subject: renewed.subject,
				idToken: renewed.idToken
			};
		}
	}

	const wrangler = await chain.readWranglerToken?.();

	if (wrangler !== undefined) {
		return {
			token: wrangler,
			source: 'wrangler',
			subject: undefined,
			idToken: undefined
		};
	}

	const grant = await chain.login();
	await chain.writeGrant(grant);

	return {
		token: grant.accessToken,
		source: 'browser login',
		subject: grant.subject,
		idToken: grant.idToken
	};
}

// An id_token within a few minutes of expiry is not worth presenting: the
// request it authorises may land after the cut-off.
const idTokenFreshnessMarginMs = 5 * 60 * 1000;

/**
 * An id_token fit to present as a subject token right now: the cached one
 * while it has time left, otherwise one reissued by refreshing the grant. A
 * deploy can outlive the id_token it logged in with (the tokens live an hour
 * and the claim happens minutes in), so callers fetch one at the moment of
 * use, not from the login snapshot.
 */
export async function freshIdToken(
	chain: Pick<
		CredentialChain,
		'readGrant' | 'writeGrant' | 'refreshGrant' | 'now'
	>
): Promise<string | undefined> {
	const cached = await chain.readGrant();

	if (cached === undefined) {
		return undefined;
	}

	const expiry =
		cached.idToken === undefined ? undefined : jwtExpiryMs(cached.idToken);

	if (expiry !== undefined && expiry > chain.now() + idTokenFreshnessMarginMs) {
		return cached.idToken;
	}

	const renewed = await chain.refreshGrant(cached);

	if (renewed === undefined) {
		return cached.idToken;
	}

	await chain.writeGrant(renewed);

	return renewed.idToken;
}

export interface ResolvedAccount {
	readonly client: Cloudflare;
	readonly api: CloudflareApi;
	readonly accountId: CloudflareAccountId;
	readonly credentialSource: CredentialSource;
	/** The Cloudflare user behind an OAuth grant; undefined for raw tokens. */
	readonly subject: string | undefined;
	/** The grant's raw id_token, presentable to a cupboard server's signup. */
	readonly idToken: string | undefined;
}

/**
 * Build an authenticated client and settle on an account: explicit option, then
 * `CLOUDFLARE_ACCOUNT_ID`, then the sole account on the credential, otherwise
 * prompt.
 */
export async function resolveCloudflare(
	accountOption: string | undefined,
	chooseAccount: (
		accounts: readonly AccountSummary[]
	) => Promise<CloudflareAccountId>,
	chain: CredentialChain
): Promise<ResolvedAccount> {
	const credential = await resolveCredential(chain);
	const client = new Cloudflare({ apiToken: credential.token });

	const fromEnv = accountOption ?? chain.env.CLOUDFLARE_ACCOUNT_ID;

	if (fromEnv !== undefined && fromEnv !== '') {
		const accountId = cloudflareAccountIdSchema.parse(fromEnv);

		return {
			client,
			api: createCloudflareApi(client, accountId),
			accountId,
			credentialSource: credential.source,
			subject: credential.subject,
			idToken: credential.idToken
		};
	}

	const probe = createCloudflareApi(
		client,
		cloudflareAccountIdSchema.parse('')
	);
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
		credentialSource: credential.source,
		subject: credential.subject,
		idToken: credential.idToken
	};
}
