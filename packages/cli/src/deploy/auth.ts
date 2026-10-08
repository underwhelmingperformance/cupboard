import { randomBytes } from 'node:crypto';
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
	 * The ID token from the browser login that produced this credential.
	 * Absent for every other source.
	 */
	readonly loginIdToken?: string;
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
	 * grant is used as it stands.
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
				nonce: randomBytes(32).toString('base64url'),
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
		return { token: fromEnv, source: 'environment', subject: undefined };
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
		if (cached.subject !== undefined || !chain.upgradeLogin) {
			return {
				token: cached.accessToken,
				source: 'cached login',
				subject: cached.subject
			};
		}

		// A grant from before the openid scope cannot learn its identity from a
		// refresh; only a fresh login can supply it.
		const upgraded = await chain.login(signal);
		await chain.writeGrant(upgraded, signal);

		return browserLoginCredential(upgraded);
	}

	if (cached?.refreshToken !== undefined) {
		const renewed = await chain.refreshGrant(cached, signal);

		if (renewed !== undefined) {
			await chain.writeGrant(renewed, signal);

			return {
				token: renewed.accessToken,
				source: 'cached login',
				subject: renewed.subject
			};
		}
	}

	const wrangler = await chain.readWranglerToken?.();

	if (wrangler !== undefined) {
		return { token: wrangler, source: 'wrangler', subject: undefined };
	}

	const grant = await chain.login(signal);
	await chain.writeGrant(grant, signal);

	return browserLoginCredential(grant);
}

function browserLoginCredential(grant: CloudflareGrant): CloudflareCredential {
	return {
		token: grant.accessToken,
		source: 'browser login',
		subject: grant.subject,
		...(grant.idToken !== undefined && { loginIdToken: grant.idToken })
	};
}

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

export interface ResolvedAccount {
	readonly client: Cloudflare;
	/**
	 * Creates a client with the same credential and its own signal, for work
	 * that must finish after the run's signal aborts.
	 */
	readonly clientWithSignal: (signal: AbortSignal) => Cloudflare;
	readonly api: CloudflareApi;
	readonly accountId: CloudflareAccountId;
	readonly credentialSource: CredentialSource;
	/**
	The Cloudflare user for an OAuth grant; `undefined` for a raw token.
	*/
	readonly subject: string | undefined;
	/**
	 * The ID token from the browser login that produced the credential. Absent
	 * for every other source.
	 */
	readonly loginIdToken?: string;
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
	const identity = {
		subject: credential.subject,
		...(credential.loginIdToken !== undefined && {
			loginIdToken: credential.loginIdToken
		})
	};
	const clientWithSignal = (signal: AbortSignal): Cloudflare =>
		createCloudflareClient(
			credential.token,
			fetch,
			cloudflareResponseLimits,
			signal
		);
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
			clientWithSignal,
			api: createCloudflareApi(client, accountId),
			accountId,
			credentialSource: credential.source,
			...identity
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
		clientWithSignal,
		api: createCloudflareApi(client, accountId),
		accountId,
		credentialSource: credential.source,
		...identity
	};
}
