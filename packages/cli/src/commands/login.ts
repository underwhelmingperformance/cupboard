import { openBrowser } from '@cupboard/cli-ui';
import { canonicalHref } from '@cupboard/nix-store/url';
import { subjectTokenTypeIdToken } from '@cupboard/protocol/oidc';
import type { Command } from 'commander';

import {
	DeviceAuthorizationRequestError,
	deviceLogin,
	discoverOidcLogin,
	loopbackLogin
} from '../auth/oidc-login.ts';
import {
	sessionFromTokenResponse,
	tokensDirectory,
	writeCachedSession
} from '../auth/token-store.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { CupboardClient } from '../client/client.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { type CredentialChain, freshIdToken } from '../deploy/auth.ts';
import {
	type CloudflareGrant,
	cloudflareLogin,
	cloudflareLoopback,
	cloudflareOauthClientId,
	deployScopes,
	jwtExpiryMs,
	refreshCloudflareGrant
} from '../deploy/cloudflare-oauth.ts';
import { readCachedGrant, writeCachedGrant } from '../deploy/grant-store.ts';
import { cloudflareDashIssuer } from '../deploy/owner.ts';
import { CliError } from '../errors.ts';

interface LoginOptions {
	readonly oidcIssuer: string;
	readonly clientId: string;
	readonly headless?: boolean;
}

/**
The issuer refused the device grant for cupboard's own OAuth client.
*/
export class DeviceGrantNotEnabledError extends CliError {
	constructor(options: { readonly cause: unknown }) {
		super(
			'Cloudflare refused to start a device login for cupboard. Enable the ' +
				'device code grant type on the cupboard OAuth client, or log in ' +
				'from a machine with a browser.',
			options
		);
		this.name = 'DeviceGrantNotEnabledError';
	}
}

/**
 * Translate a refused device authorization into actionable guidance when the
 * built-in Cloudflare client is in use; other clients and errors pass through.
 */
export function mapDeviceLoginError(error: unknown, clientId: string): unknown {
	if (
		clientId === cloudflareOauthClientId &&
		error instanceof DeviceAuthorizationRequestError &&
		[400, 401, 403].includes(error.status)
	) {
		return new DeviceGrantNotEnabledError({ cause: error });
	}

	return error;
}

export function loginScopeForClient(clientId: string): string | undefined {
	return clientId === cloudflareOauthClientId
		? deployScopes.join(' ')
		: undefined;
}

/**
 * What to tell the user to do for the device flow, preferring the complete
 * verification URL (the code filled in) when the issuer provides one.
 */
function deviceLoginInstruction(verification: {
	readonly userCode: string;
	readonly verificationUri: string;
	readonly verificationUriComplete?: string;
}): string {
	if (verification.verificationUriComplete !== undefined) {
		return (
			`To authorise, open ${verification.verificationUriComplete} ` +
			`(the code ${verification.userCode} is filled in), then return here. ` +
			'Waiting for authorisation…'
		);
	}

	return (
		`To authorise, open ${verification.verificationUri} and enter the code ` +
		`${verification.userCode}, then return here. Waiting for authorisation…`
	);
}

/**
A fresh Cloudflare login answered without an id_token to present.
*/
export class LoginIdTokenMissingError extends CliError {
	constructor() {
		super(
			'The Cloudflare login returned no id token. Check that ID token ' +
				'support is enabled on the cupboard OAuth client.'
		);
		this.name = 'LoginIdTokenMissingError';
	}
}

/**
 * The id_token a cupboard-client login presents. The built-in client shares
 * the deploy's grant, so a cached or refreshable login answers without a
 * browser; only a missing, unrefreshable or expired one logs in afresh, with
 * the client's full registered scope set (the dashboard errors on a bare
 * `openid` authorize, and a narrower grant would desynchronise the cache the
 * deploy reuses). A fresh login is persisted for both flows to share.
 */
export async function cupboardIdToken(dependencies: {
	readonly chain: Pick<
		CredentialChain,
		'readGrant' | 'writeGrant' | 'refreshGrant' | 'now'
	>;
	readonly login: () => Promise<CloudflareGrant>;
}): Promise<string> {
	const cached = await freshIdToken(dependencies.chain);
	const expiry = cached === undefined ? undefined : jwtExpiryMs(cached);

	// `freshIdToken` falls back to a stale token when the refresh declines;
	// that is fine for a claim that may still land, but a login presenting a
	// token known to be expired would only bounce, so it goes to the browser.
	if (
		cached !== undefined &&
		(expiry === undefined || expiry > dependencies.chain.now())
	) {
		return cached;
	}

	const grant = await dependencies.login();
	await dependencies.chain.writeGrant(grant);

	if (grant.idToken === undefined) {
		throw new LoginIdTokenMissingError();
	}

	return grant.idToken;
}

export function registerLoginCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('login')
		.description(
			'Authenticate as the owner via OIDC and cache an admin access token.'
		)
		.argument(
			'<url>',
			'deployment or tenant URL to sign in to ' +
				'(e.g. https://cupboard.example.workers.dev or .../t/<slug>)',
			parseWorkerUrl
		)
		.option('--oidc-issuer <issuer>', 'OIDC issuer URL', cloudflareDashIssuer)
		.option(
			'--client-id <id>',
			'registered public OAuth client id (PKCE, no client secret)',
			cloudflareOauthClientId
		)
		.option(
			'--headless',
			'use the device flow instead of opening a browser (for SSH/containers)'
		)
		.action(async (url: URL, options: LoginOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const client = CupboardClient.fromUrl(url, {
				signal: programOptions.signal
			});
			// cupboard's own client has exact-match registered redirect URLs, so
			// the loopback server must bind one of them; any other client keeps
			// the ephemeral-port default.
			const isCupboardClient = options.clientId === cloudflareOauthClientId;
			const scope = loginScopeForClient(options.clientId);

			const browserPrompt = (target: string): void => {
				openBrowser(target, reporter);
				reporter.info('Waiting for you to authorise in your browser…');
			};

			// Login is interactive, so its prompts are shown the moment they happen,
			// not held behind a spinner the user is meant to act on.
			const idToken = await (async (): Promise<string> => {
				// The built-in client against its own issuer uses the deploy's
				// cached grant: silent while a cached login can be renewed, the
				// browser only as a last resort.
				if (
					isCupboardClient &&
					options.oidcIssuer === cloudflareDashIssuer &&
					options.headless !== true
				) {
					return cupboardIdToken({
						chain: {
							readGrant: readCachedGrant,
							writeGrant: writeCachedGrant,
							refreshGrant: (previous) => refreshCloudflareGrant(previous),
							now: Date.now
						},
						login: () =>
							cloudflareLogin({
								openBrowser: browserPrompt,
								signal: programOptions.signal
							})
					});
				}

				const endpoints = await discoverOidcLogin(
					options.oidcIssuer,
					fetch,
					programOptions.signal
				);

				if (options.headless === true) {
					try {
						return await deviceLogin({
							endpoints,
							clientId: options.clientId,
							scope,
							prompt: (verification) => {
								reporter.info(deviceLoginInstruction(verification));
							},
							signal: programOptions.signal
						});
					} catch (error) {
						throw mapDeviceLoginError(error, options.clientId);
					}
				}

				return loopbackLogin({
					endpoints,
					clientId: options.clientId,
					scope,
					openBrowser: browserPrompt,
					loopback: isCupboardClient ? cloudflareLoopback : undefined,
					signal: programOptions.signal
				});
			})();

			const exchanged = await client.tokenExchange(
				idToken,
				subjectTokenTypeIdToken
			);
			await writeCachedSession(sessionFromTokenResponse(exchanged), url);

			const target = canonicalHref(url);

			const storedIn = tokensDirectory();

			reporter.result({
				kind: 'login',
				data: { url: target, scope, storedIn },
				rows: [
					{ label: 'Cache URL', value: target },
					{ label: 'Session', value: 'admin token cached' },
					{ label: 'Stored', value: storedIn }
				]
			});
		});
}
