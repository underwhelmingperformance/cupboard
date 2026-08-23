import path from 'node:path';

import type {
	AuthConfigStorage,
	UserAuthConfig
} from '@cloudflare/workers-auth';
import { fetchWithBoundedResponseBodies } from '@cupboard/shared/response-body';
import Cloudflare from 'cloudflare';

import { throwIfAborted } from '../abort.ts';
import { CliError } from '../errors.ts';

import type { AccountSummary, CloudflareApi } from './cloudflare-api.ts';
import { createCloudflareApi } from './cloudflare-api.ts';
import {
	type CloudflareGrant,
	cloudflareLogin,
	jwtExpiryMs,
	refreshCloudflareGrant
} from './cloudflare-oauth.ts';
import {
	readCachedGrant,
	withCachedGrantLock,
	writeCachedGrant
} from './grant-store.ts';
import {
	type CloudflareAccountId,
	cloudflareAccountIdSchema
} from './identifiers.ts';

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
	/**
	The Cloudflare user for an OAuth grant; `undefined` for a raw token.
	*/
	readonly subject: string | undefined;
	/**
	The grant's raw ID token, which Cupboard can use for signup.
	*/
	readonly idToken: string | undefined;
}

/**
 * How the credential chain talks to the world; injectable so resolution order
 * is testable without real files, endpoints, or a browser.
 */
export interface CredentialChain {
	readonly signal?: AbortSignal;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly readGrant: () => Promise<CloudflareGrant | undefined>;
	readonly writeGrant: (
		grant: CloudflareGrant,
		signal?: AbortSignal
	) => Promise<void>;
	readonly withGrantLock: <T>(
		action: (signal?: AbortSignal) => Promise<T>,
		signal?: AbortSignal
	) => Promise<T>;
	readonly refreshGrant: (
		previous: CloudflareGrant,
		signal?: AbortSignal
	) => Promise<CloudflareGrant | undefined>;
	/**
	Omitted when the chain must not use Wrangler's stored token.
	*/
	readonly readWranglerToken?: () => Promise<string | undefined>;
	readonly login: (signal?: AbortSignal) => Promise<CloudflareGrant>;
	/**
	 * Whether an incomplete cached grant may be replaced by a fresh browser
	 * login. A grant issued before the `openid` scope was requested has no
	 * subject, and refreshing it cannot add one, so only a new login can
	 * establish who the operator is; with no terminal to log in on, the old
	 * grant is used as it stands. A grant missing only its id_token is upgraded
	 * by a refresh first and the browser second.
	 */
	readonly upgradeLogin: boolean;
	readonly now: () => number;
}

export interface CredentialChainOptions {
	readonly openBrowser: (url: string) => void | Promise<void>;
	readonly wrangler: boolean;
	readonly interactive: boolean;
	readonly signal?: AbortSignal;
}

export function defaultCredentialChain(
	options: CredentialChainOptions
): CredentialChain {
	return {
		signal: options.signal,
		env: process.env,
		readGrant: readCachedGrant,
		writeGrant: writeCachedGrant,
		withGrantLock: withCachedGrantLock,
		refreshGrant: (previous, signal = options.signal) =>
			refreshCloudflareGrant(previous, fetch, Date.now, signal),
		...(options.wrangler && { readWranglerToken }),
		login: (signal = options.signal) =>
			cloudflareLogin({
				openBrowser: options.openBrowser,
				signal
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

	return chain.withGrantLock(
		(signal) => resolveStoredCredential(chain, signal),
		chain.signal
	);
}

async function resolveStoredCredential(
	chain: CredentialChain,
	signal?: AbortSignal
): Promise<CloudflareCredential> {
	throwIfAborted(signal);

	const cached = await chain.readGrant();
	throwIfAborted(signal);

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
		// Persist the renewal even when it has no ID token. The refresh token can
		// rotate on use.
		if (cached.subject !== undefined) {
			const renewed = await chain.refreshGrant(cached, signal);

			if (renewed !== undefined) {
				await chain.writeGrant(renewed, signal);
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
		// refresh, and a refresh that did not issue an ID token leaves the identity
		// unproven; only a fresh login can supply it.
		const upgraded = await chain.login(signal);
		await chain.writeGrant(upgraded, signal);

		return {
			token: upgraded.accessToken,
			source: 'browser login',
			subject: upgraded.subject,
			idToken: upgraded.idToken
		};
	}

	if (cached?.refreshToken !== undefined) {
		const renewed = await chain.refreshGrant(cached, signal);

		if (renewed !== undefined) {
			await chain.writeGrant(renewed, signal);

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

	const grant = await chain.login(signal);
	await chain.writeGrant(grant, signal);

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

const maximumCloudflareErrorBytes = 64 * 1024;
const maximumCloudflareResponseBytes = 16 * 1024 * 1024;

interface CloudflareResponseLimits {
	readonly errorMaximumBytes: number;
	readonly successMaximumBytes: number;
}

const cloudflareResponseLimits: CloudflareResponseLimits = {
	errorMaximumBytes: maximumCloudflareErrorBytes,
	successMaximumBytes: maximumCloudflareResponseBytes
};

/**
Creates the Cloudflare SDK client with retries disabled and bounded responses.
*/
export function createCloudflareClient(
	apiToken: string,
	fetcher: typeof fetch = fetch,
	limits: CloudflareResponseLimits = cloudflareResponseLimits,
	signal?: AbortSignal
): Cloudflare {
	return new Cloudflare({
		apiToken,
		fetch: fetchWithBoundedResponseBodies(fetcher, {
			description: 'Cloudflare API response',
			...limits,
			signal
		}),
		maxRetries: 0
	});
}

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
		| 'signal'
		| 'readGrant'
		| 'writeGrant'
		| 'withGrantLock'
		| 'refreshGrant'
		| 'now'
	>,
	signal?: AbortSignal
): Promise<string | undefined> {
	const callerSignal = signal ?? chain.signal;

	return chain.withGrantLock(
		(lockSignal) => freshIdTokenUnderLock(chain, lockSignal),
		callerSignal
	);
}

async function freshIdTokenUnderLock(
	chain: Pick<
		CredentialChain,
		'readGrant' | 'writeGrant' | 'refreshGrant' | 'now'
	>,
	signal?: AbortSignal
): Promise<string | undefined> {
	throwIfAborted(signal);
	const cached = await chain.readGrant();
	throwIfAborted(signal);

	if (cached === undefined) {
		return undefined;
	}

	const cachedToken = freshIdTokenFromGrant(cached, chain.now());

	if (cachedToken !== undefined) {
		return cachedToken;
	}

	const renewed = await chain.refreshGrant(cached, signal);
	throwIfAborted(signal);

	if (renewed === undefined) {
		return undefined;
	}

	await chain.writeGrant(renewed, signal);
	throwIfAborted(signal);

	return freshIdTokenFromGrant(renewed, chain.now());
}

/**
 * Returns a grant's ID token when it remains valid beyond the presentation
 * margin.
 */
export function freshIdTokenFromGrant(
	grant: CloudflareGrant,
	now: number
): string | undefined {
	if (grant.idToken === undefined) {
		return undefined;
	}

	const expiry = jwtExpiryMs(grant.idToken);

	return expiry !== undefined && expiry > now + idTokenFreshnessMarginMs
		? grant.idToken
		: undefined;
}

export interface ResolvedAccount {
	readonly client: Cloudflare;
	readonly api: CloudflareApi;
	readonly accountId: CloudflareAccountId;
	readonly credentialSource: CredentialSource;
	/**
	The Cloudflare user for an OAuth grant; `undefined` for a raw token.
	*/
	readonly subject: string | undefined;
	/**
	The grant's raw ID token, which Cupboard can use for signup.
	*/
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
	const client = createCloudflareClient(
		credential.token,
		fetch,
		cloudflareResponseLimits,
		chain.signal
	);

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
