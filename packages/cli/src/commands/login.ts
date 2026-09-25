import { openBrowser } from '@cupboard/cli-ui';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	subjectTokenTypeIdToken,
	type TokenResponse
} from '@cupboard/protocol/oidc';
import type { Reporter } from '@cupboard/reporter';
import { type Command, Option } from 'commander';

import {
	DeviceAuthorizationRequestError,
	deviceLogin,
	discoverOidcLogin,
	loopbackLogin
} from '../auth/oidc-login.ts';
import {
	sessionFromTokenResponse,
	tokensDirectory,
	withCachedSessionLock,
	writeCachedSession
} from '../auth/token-store.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { CupboardClient } from '../client/client.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import {
	type CredentialChain,
	freshIdToken,
	freshIdTokenFromGrant
} from '../deploy/auth.ts';
import {
	type CloudflareGrant,
	cloudflareLogin,
	cloudflareLoopback,
	cloudflareOauthClientId,
	deployScopes,
	refreshCloudflareGrant
} from '../deploy/cloudflare-oauth.ts';
import {
	readCachedGrant,
	withCachedGrantLock,
	writeCachedGrant
} from '../deploy/grant-store.ts';
import { cloudflareDashIssuer } from '../deploy/owner.ts';
import { CliError } from '../errors.ts';

/**
 * How to sign in with an identity provider. `login` and `whoami --provider`
 * both take these options.
 */
export interface ProviderSignInOptions {
	readonly oidcIssuer: string;
	readonly clientId: string;
	readonly headless?: boolean;
}

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
 * The ID token presented by a Cupboard-client login. The built-in client shares
 * the deploy grant, so it can use or refresh a cached login without opening a
 * browser. A missing, unrefreshable or expired token starts a fresh login with
 * the client's full registered scope set (the dashboard errors on a bare
 * `openid` authorize, and a narrower grant would desynchronise the cache the
 * deploy reuses). A fresh login is persisted for both flows to share.
 */
export async function cupboardIdToken(dependencies: {
	readonly chain: Pick<
		CredentialChain,
		| 'signal'
		| 'readGrant'
		| 'writeGrant'
		| 'withGrantLock'
		| 'refreshGrant'
		| 'now'
	>;
	readonly login: (signal?: AbortSignal) => Promise<CloudflareGrant>;
}): Promise<string> {
	const cached = await freshIdToken(dependencies.chain);

	if (cached !== undefined) {
		return cached;
	}

	return dependencies.chain.withGrantLock(async (signal) => {
		const successor = await dependencies.chain.readGrant();
		const successorToken =
			successor === undefined
				? undefined
				: freshIdTokenFromGrant(successor, dependencies.chain.now());

		if (successorToken !== undefined) {
			return successorToken;
		}

		const grant = await dependencies.login(signal);
		await dependencies.chain.writeGrant(grant, signal);

		if (grant.idToken === undefined) {
			throw new LoginIdTokenMissingError();
		}

		return grant.idToken;
	}, dependencies.chain.signal);
}

interface LoginSessionDependencies {
	readonly writeSession: typeof writeCachedSession;
	readonly withSessionLock: typeof withCachedSessionLock;
}

const defaultLoginSessionDependencies: LoginSessionDependencies = {
	writeSession: writeCachedSession,
	withSessionLock: withCachedSessionLock
};

export async function cacheLoginSession(
	response: TokenResponse,
	target: URL,
	signal?: AbortSignal,
	dependencies: LoginSessionDependencies = defaultLoginSessionDependencies
): Promise<void> {
	await dependencies.withSessionLock(
		target,
		(lockSignal) =>
			dependencies.writeSession(
				sessionFromTokenResponse(response),
				target,
				lockSignal ?? signal
			),
		signal
	);
}

/**
 * Signs in with the identity provider and returns its OIDC ID token. It doesn't
 * contact cupboard.
 *
 * When you sign in with Cloudflare using cupboard's own client, this reuses the
 * saved Cloudflare sign-in, which `init` also uses. If that sign-in can be
 * renewed, no browser is needed. The browser opens only when there is no
 * saved sign-in or the saved sign-in can't be renewed.
 * Other providers open a browser and wait for the redirect back to this
 * machine, or use the device flow with `headless`.
 *
 * Sign-in needs the user to act, so its prompts are printed straight away
 * rather than hidden behind a spinner.
 */
export async function providerIdToken(
	options: ProviderSignInOptions,
	reporter: Pick<Reporter, 'info' | 'warn'>,
	signal?: AbortSignal
): Promise<string> {
	// cupboard's own OAuth client accepts only its registered redirect URLs, and
	// they must match exactly, so the local server must listen on one of them.
	// Other clients use any free port.
	const isCupboardClient = options.clientId === cloudflareOauthClientId;
	const scope = loginScopeForClient(options.clientId);

	const browserPrompt = (target: string): void => {
		openBrowser(target, reporter);
		reporter.info('Waiting for you to authorise in your browser…');
	};

	if (
		isCupboardClient &&
		options.oidcIssuer === cloudflareDashIssuer &&
		options.headless !== true
	) {
		return cupboardIdToken({
			chain: {
				readGrant: readCachedGrant,
				writeGrant: writeCachedGrant,
				withGrantLock: withCachedGrantLock,
				refreshGrant: (previous, grantSignal) =>
					refreshCloudflareGrant(previous, fetch, Date.now, grantSignal),
				signal,
				now: Date.now
			},
			login: (loginSignal) =>
				cloudflareLogin({ openBrowser: browserPrompt, signal: loginSignal })
		});
	}

	const endpoints = await discoverOidcLogin(options.oidcIssuer, fetch, signal);

	if (options.headless === true) {
		try {
			return await deviceLogin({
				endpoints,
				clientId: options.clientId,
				scope,
				prompt: (verification) => {
					reporter.info(deviceLoginInstruction(verification));
				},
				signal
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
		signal
	});
}

/**
 * The identity provider options that `login` and `whoami` share, so both sign
 * in the same way. If you pass `implies`, any of these options also turns on
 * the options listed in `implies`.
 */
export function providerSignInOptions(
	implies?: Readonly<Record<string, boolean>>
): readonly Option[] {
	const options = [
		new Option('--oidc-issuer <issuer>', 'OIDC issuer URL').default(
			cloudflareDashIssuer
		),
		new Option(
			'--client-id <id>',
			'the public OAuth client ID to sign in with (PKCE, no client secret)'
		).default(cloudflareOauthClientId),
		new Option(
			'--headless',
			'sign in with a code in a browser on another device, instead of opening ' +
				'one here (for SSH or containers)'
		)
	];

	return implies === undefined
		? options
		: options.map((option) => option.implies(implies));
}

export function registerLoginCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const command = program
		.command('login')
		.description(
			'Sign in to a tenant or the deployment, and save the session on this machine.'
		)
		.argument(
			'<url>',
			'deployment or tenant URL to sign in to ' +
				'(e.g. https://cupboard.example.workers.dev or .../t/<slug>)',
			parseWorkerUrl
		);

	for (const option of providerSignInOptions()) {
		command.addOption(option);
	}

	command.action(async (url: URL, options: ProviderSignInOptions) => {
		const reporter = commandUi(program, programOptions).reporter();
		const client = CupboardClient.fromUrl(url, {
			cache: { kind: 'default' },
			signal: programOptions.signal
		});
		const scope = loginScopeForClient(options.clientId);
		const idToken = await providerIdToken(
			options,
			reporter,
			programOptions.signal
		);

		const exchanged = await client.tokenExchange(
			idToken,
			subjectTokenTypeIdToken
		);
		await cacheLoginSession(exchanged, url, programOptions.signal);

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
