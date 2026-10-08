import { type CliUi, openBrowser } from '@cupboard/cli-ui';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	subjectTokenTypeIdToken,
	type TokenResponse
} from '@cupboard/protocol/oidc';
import { shouldShowDetails } from '@cupboard/reporter';
import { type Command, Option } from 'commander';

import {
	BoundSignIn,
	canonicalTarget,
	type SignInMethod
} from '../auth/bound-sign-in.ts';
import {
	discoverOidcLogin,
	loopbackLogin,
	type LoopbackOptions,
	type PastedRedirectReader
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
	cloudflareDashIssuer,
	cloudflareLogin,
	cloudflareLoopback,
	cloudflareOauthClientId,
	signInScopes
} from '../deploy/cloudflare-oauth.ts';
import { CliError } from '../errors.ts';

export function loginScopeForClient(clientId: string): string | undefined {
	return clientId === cloudflareOauthClientId
		? signInScopes.join(' ')
		: undefined;
}

export class LoginIdTokenMissingError extends CliError {
	override readonly humanMessage =
		'Cloudflare did not provide a sign-in identity. Ask the operator to enable ID-token support for the Cupboard OAuth client.';
	constructor() {
		super(
			'The Cloudflare login returned no id token. Check that ID token ' +
				'support is enabled on the cupboard OAuth client.'
		);
		this.name = 'LoginIdTokenMissingError';
	}
}

/**
 * Options for the OIDC login that identifies the operator. `cupboard login`
 * and `cupboard init` both use it.
 */
export interface IdentityLoginOptions {
	readonly oidcIssuer: string;
	readonly clientId: string;
	readonly headless?: boolean;
}

export interface IdentityLoginDependencies {
	readonly openBrowser: (url: string) => void;
	readonly info: (message: string) => void;
	/**
	 * The prompt for the redirect URL of a headless sign-in. Without it, a
	 * headless sign-in completes only from the loopback redirect.
	 */
	readonly readPastedRedirect?: PastedRedirectReader;
	readonly signal?: AbortSignal;
	/**
	The `fetch` for the identity provider's endpoints.
	*/
	readonly fetcher?: typeof fetch;
	/**
	The loopback ports to try for the redirect, in place of the defaults.
	*/
	readonly loopbackPorts?: readonly number[];
}

const waitingMessage = 'Waiting for you to authorise in your browser…';

/**
 * Returns a redirect-URL reader for an interactive run, or `undefined` when
 * prompting is unavailable.
 */
export function pastedRedirectReader(
	ui: Pick<CliUi, 'interactive' | 'editText'>
): PastedRedirectReader | undefined {
	if (!ui.interactive) {
		return undefined;
	}

	return async (signal, refusal) => {
		const edit = await ui.editText({
			message:
				refusal === undefined
					? "Paste the URL from the browser's address bar"
					: `That URL is not the redirect for this sign-in (${refusal.problem}). Paste the URL from the browser's address bar after you authorise`,
			problem: (value) =>
				URL.canParse(value.trim())
					? undefined
					: 'Paste the whole URL, starting with http.',
			signal
		});

		return edit.kind === 'set' ? edit.value : undefined;
	};
}

interface AuthorizationPrompt {
	readonly openBrowser: (url: string) => void;
	readonly readPastedRedirect?: PastedRedirectReader;
}

function authorizationPrompt(
	options: IdentityLoginOptions,
	dependencies: IdentityLoginDependencies
): AuthorizationPrompt {
	if (options.headless !== true) {
		return {
			openBrowser: (target) => {
				dependencies.openBrowser(target);
				dependencies.info(waitingMessage);
			}
		};
	}

	const read = dependencies.readPastedRedirect;

	return {
		openBrowser: (target) => {
			dependencies.info(`To sign in, open this URL in a browser: ${target}`);
			dependencies.info(
				read === undefined
					? waitingMessage
					: 'After you authorise, the browser opens a localhost URL. If ' +
							'that page does not load, copy the URL from the address bar ' +
							'and paste it here.'
			);
		},
		readPastedRedirect: read
	};
}

/**
 * Whether `options` select the Cloudflare issuer with cupboard's own client,
 * the identity of the Cloudflare login for the account.
 */
export function isCloudflareSignIn(options: IdentityLoginOptions): boolean {
	return (
		options.clientId === cloudflareOauthClientId &&
		options.oidcIssuer === cloudflareDashIssuer
	);
}

/**
 * Returns the sign-in method for the issuer and client in `options`. With the
 * built-in client and the Cloudflare issuer, it uses Cloudflare's fixed
 * endpoints, and otherwise it discovers the issuer's endpoints. By default, a
 * sign-in opens a browser at the authorisation URL. With `headless`, the CLI
 * prints that URL instead, and the sign-in completes from the loopback redirect
 * or from the redirect URL that the user pastes, whichever arrives first. A Cloudflare sign-in does not
 * request `offline_access`, so it receives no refresh token, and nothing keeps
 * its grant.
 */
export function identitySignIn(
	options: IdentityLoginOptions,
	dependencies: IdentityLoginDependencies
): SignInMethod {
	const { signal } = dependencies;
	const fetcher = dependencies.fetcher ?? fetch;
	const scope = loginScopeForClient(options.clientId);
	const prompt = authorizationPrompt(options, dependencies);
	const isCupboardClient = options.clientId === cloudflareOauthClientId;

	if (isCloudflareSignIn(options)) {
		return {
			signIn: async (nonce) => {
				const grant = await cloudflareLogin({
					nonce,
					scopes: signInScopes,
					...prompt,
					fetcher,
					...(dependencies.loopbackPorts !== undefined && {
						ports: dependencies.loopbackPorts
					}),
					signal
				});

				if (grant.idToken === undefined) {
					throw new LoginIdTokenMissingError();
				}

				return grant.idToken;
			}
		};
	}

	return {
		signIn: async (nonce) => {
			const endpoints = await discoverOidcLogin(
				options.oidcIssuer,
				fetcher,
				signal
			);
			const loopback = loopbackFor(
				isCupboardClient,
				dependencies.loopbackPorts
			);

			return loopbackLogin({
				endpoints,
				clientId: options.clientId,
				scope,
				nonce,
				...prompt,
				fetcher,
				...(loopback !== undefined && { loopback }),
				signal
			});
		}
	};
}

// cupboard's own client has exact-match registered redirect URLs, so the
// loopback server must bind one of them; any other client keeps the
// ephemeral-port default.
function loopbackFor(
	isCupboardClient: boolean,
	ports: readonly number[] | undefined
): LoopbackOptions | undefined {
	const registered = isCupboardClient ? cloudflareLoopback : undefined;

	return ports === undefined ? registered : { ...registered, ports };
}

export interface SignInToDependencies {
	readonly signIn: BoundSignIn;
	readonly client: Pick<CupboardClient, 'tokenExchange'>;
	readonly cacheSession: (
		response: TokenResponse,
		target: URL
	) => Promise<void>;
}

/**
 * Signs in for `url`, exchanges an ID token bound to `url` at its token
 * endpoint, and caches the session for `url`.
 */
export async function signInTo(
	url: URL,
	dependencies: SignInToDependencies
): Promise<void> {
	const target = canonicalTarget(url);
	const session = await dependencies.signIn.present([target], target, (token) =>
		dependencies.client.tokenExchange(
			token.idToken,
			subjectTokenTypeIdToken,
			undefined,
			token.binding
		)
	);

	await dependencies.cacheSession(session, url);
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
 * The identity-provider options of `login` and `whoami`, so both commands
 * accept the same options with the same defaults. Each option in `implies`
 * is set when any of these options is given.
 */
export function identityLoginOptions(
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
			'print the sign-in URL instead of opening a browser, and accept the ' +
				'redirect URL pasted from a browser on another machine (for SSH or ' +
				'containers)'
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
			'Sign in to a tenant or deployment and save the sign-in on this machine.'
		)
		.argument(
			'<url>',
			'deployment or tenant URL to sign in to ' +
				'(e.g. https://cupboard.example.workers.dev or .../t/<slug>)',
			parseWorkerUrl
		);

	for (const option of identityLoginOptions()) {
		command.addOption(option);
	}

	command.action(async (url: URL, options: IdentityLoginOptions) => {
		const ui = commandUi(program, programOptions);
		const reporter = ui.reporter();
		const client = CupboardClient.fromUrl(url, {
			cache: { kind: 'default' },
			signal: programOptions.signal
		});
		const scope = loginScopeForClient(options.clientId);

		// Login is interactive, so its prompts are shown as soon as they happen.
		// A spinner would hide them while the user has to act on them.
		const signIn = new BoundSignIn(
			identitySignIn(options, {
				openBrowser: (target) => {
					openBrowser(target, reporter);
				},
				info: (message) => {
					reporter.info(message);
				},
				readPastedRedirect: pastedRedirectReader(ui),
				signal: programOptions.signal
			})
		);

		await signInTo(url, {
			signIn,
			client,
			cacheSession: (response, target) =>
				cacheLoginSession(response, target, programOptions.signal)
		});

		const target = canonicalHref(url);

		const storedIn = tokensDirectory();

		reporter.result({
			kind: 'login',
			title: 'Signed in',
			data: { url: target, scope, storedIn },
			rows: [
				{ label: 'URL', value: target },
				{ label: 'Sign-in', value: 'saved on this machine' },
				...(shouldShowDetails(reporter)
					? [{ label: 'Saved in', value: storedIn }]
					: [])
			]
		});
	});
}
