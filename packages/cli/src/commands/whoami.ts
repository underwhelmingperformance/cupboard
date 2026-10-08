import { openBrowser } from '@cupboard/cli-ui';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	formatTimestamp,
	type Reporter,
	type ResultRow,
	shouldShowDetails
} from '@cupboard/reporter';
import type { Command } from 'commander';

import { BoundSignIn } from '../auth/bound-sign-in.ts';
import {
	type ProviderIdentity,
	providerIdentity,
	type SessionIdentity,
	sessionIdentity
} from '../auth/identity.ts';
import {
	type CachedSession,
	listCachedSessions,
	readCachedSession,
	type SessionReadFailure
} from '../auth/token-store.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import type { CloudflareGrant } from '../deploy/cloudflare-oauth.ts';
import { readCachedGrant } from '../deploy/grant-store.ts';
import { authExitCode, CliError, CliUsageError } from '../errors.ts';

import {
	type IdentityLoginOptions,
	identityLoginOptions,
	identitySignIn,
	pastedRedirectReader
} from './login.ts';

export interface WhoamiOptions extends IdentityLoginOptions {
	readonly provider?: boolean;
}

export class NoCachedSessionError extends CliError {
	override readonly humanMessage: string;
	constructor(public readonly url: string) {
		super(
			`No session is cached for ${url}. Sign in with \`cupboard login ${url}\`.`
		);
		this.name = 'NoCachedSessionError';
		this.humanMessage = `No saved sign-in for ${url}. Run \`cupboard login ${url}\` to sign in.`;
	}

	override get exitCode(): number {
		return authExitCode;
	}
}

export class WhoamiProviderWithUrlError extends CliUsageError {
	constructor() {
		super(
			'--provider signs in with the identity provider only and takes no URL; ' +
				'drop the URL, or drop --provider to show the cached session.'
		);
		this.name = 'WhoamiProviderWithUrlError';
	}
}

/**
 * What `whoami` reads, injectable so it is testable without real files or a
 * browser.
 */
export interface WhoamiDependencies {
	readonly listSessions: typeof listCachedSessions;
	readonly readSession: (target: URL) => Promise<CachedSession | undefined>;
	readonly readGrant: () => Promise<CloudflareGrant | undefined>;
	readonly signIn: (options: IdentityLoginOptions) => Promise<string>;
	readonly now: () => number;
}

export type WhoamiInput =
	| { readonly kind: 'sessions'; readonly url?: URL }
	| { readonly kind: 'provider'; readonly options: IdentityLoginOptions };

/**
 * The cached sessions and, when one is cached, the Cloudflare sign-in that
 * `cupboard init` keeps for the Cloudflare API.
 */
interface WhoamiSessions {
	readonly sessions?: readonly SessionIdentity[];
	/**
	Present when a Cloudflare sign-in is cached; its subject when recorded.
	*/
	readonly cloudflareSignIn?: { readonly subject?: string };
}

function sessionSummary(session: SessionIdentity, now: number): string {
	const expiry = session.accessTokenExpiresAt;
	const accessState =
		expiry === undefined
			? 'expiry unknown'
			: Date.parse(expiry) <= now
				? 'saved sign-in expired'
				: 'saved sign-in current';

	return [
		session.subject ?? 'identity unknown',
		`${session.kind} sign-in`,
		accessState,
		session.refreshTokenCached
			? 'automatic renewal available'
			: 'sign in again when needed'
	].join(' · ');
}

function sessionDetailRows(session: SessionIdentity): ResultRow[] {
	return [
		...(session.rule === undefined
			? []
			: [{ label: 'Trust rule', value: session.rule }]),
		...(session.accessTokenExpiresAt === undefined
			? []
			: [
					{
						label: 'Credential expiry',
						value: formatTimestamp(session.accessTokenExpiresAt)
					}
				])
	];
}

async function reportSessions(
	url: URL | undefined,
	reporter: Reporter,
	dependencies: WhoamiDependencies
): Promise<void> {
	const sessionFailures: SessionReadFailure[] = [];
	const readSessions = async (): Promise<readonly CachedSession[]> => {
		if (url === undefined) {
			return dependencies.listSessions((failure) => {
				sessionFailures.push(failure);
			});
		}

		const session = await dependencies.readSession(url);

		return session === undefined ? [] : [session];
	};
	const [sessionRead, grantRead] = await Promise.allSettled([
		readSessions(),
		dependencies.readGrant()
	]);
	const cached =
		sessionRead.status === 'fulfilled' ? sessionRead.value : undefined;

	if (url !== undefined && cached?.length === 0) {
		throw new NoCachedSessionError(canonicalHref(url));
	}

	const sessions = cached
		?.map((session) => sessionIdentity(session))
		.filter((session) => session !== undefined);
	const grant = grantRead.status === 'fulfilled' ? grantRead.value : undefined;
	const now = dependencies.now();
	const rows: ResultRow[] = (sessions ?? []).flatMap((session) => [
		{ label: session.url, value: sessionSummary(session, now) },
		...(shouldShowDetails(reporter) ? sessionDetailRows(session) : [])
	]);

	for (const failure of sessionFailures) {
		const detail =
			failure.cause instanceof Error
				? failure.cause.message
				: String(failure.cause);
		reporter.warn(
			`Could not read cached Cupboard session file ${failure.file}: ${detail}. Check that the file is readable and retry.`,
			undefined,
			{
				humanMessage: `Could not read the saved sign-in at ${failure.file}. Check that the file is readable and retry.`
			}
		);
	}

	for (const [read, description] of [
		[sessionRead, 'the cached Cupboard sessions'],
		[grantRead, 'the cached Cloudflare sign-in']
	] as const) {
		if (read.status === 'rejected') {
			reporter.warn(
				`Could not read ${description}. Check access to the CLI's configuration directory and retry.`
			);
		}
	}

	if (grant !== undefined) {
		rows.push({
			label: 'Cloudflare sign-in',
			value: grant.subject ?? 'cached'
		});
	}

	const data: WhoamiSessions = {
		...(sessions !== undefined && { sessions }),
		...(grant !== undefined && {
			cloudflareSignIn: {
				...(grant.subject !== undefined && { subject: grant.subject })
			}
		})
	};

	reporter.result({
		kind: 'whoami',
		title: 'Saved sign-ins (server access not checked)',
		data,
		rows,
		empty:
			sessionFailures.length > 0 ||
			sessionRead.status === 'rejected' ||
			grantRead.status === 'rejected'
				? 'Some cached identity files could not be read.'
				: 'No sessions are cached. Sign in with `cupboard login <url>`, or run ' +
					'`cupboard whoami --provider` to see the identity you would sign in as.'
	});

	const firstSessionFailure = sessionFailures[0];

	if (firstSessionFailure !== undefined) {
		throw firstSessionFailure.cause;
	}

	if (sessionRead.status === 'rejected') {
		throw sessionRead.reason;
	}

	if (grantRead.status === 'rejected') {
		throw grantRead.reason;
	}
}

// The issuer, audience and subject are the values of a matching trust rule.
// When the token lists several audiences, the rule uses only one of them.
function providerRows(identity: ProviderIdentity): ResultRow[] {
	return [
		{ label: 'Issuer', value: identity.rule.issuer },
		{ label: 'Audience', value: identity.rule.audience },
		{ label: 'Subject', value: identity.rule.claims.sub },
		...(identity.expiresAt === undefined
			? []
			: [{ label: 'Expires', value: formatTimestamp(identity.expiresAt) }]),
		...Object.entries(identity.claims)
			.filter(([name]) => name !== 'sub')
			.map(([name, value]) => ({ label: `Claim ${name}`, value }))
	];
}

async function reportProvider(
	options: IdentityLoginOptions,
	reporter: Reporter,
	dependencies: WhoamiDependencies
): Promise<void> {
	const idToken = await dependencies.signIn(options);
	const identity = providerIdentity(idToken, options.clientId);

	reporter.result({
		kind: 'whoami-provider',
		title: 'Identity provider claims (not verified)',
		data: identity,
		rows: providerRows(identity)
	});
	reporter.info(
		'Send the issuer, audience and subject to the administrator of the ' +
			'tenant or deployment that you need: a tenant administrator adds a ' +
			'rule with `cupboard oidc-trust add`, and an operator adds a ' +
			'deployment rule with `cupboard control-oidc-trust add`. The claims ' +
			'were decoded locally without checking the signature, and nothing was ' +
			'sent to cupboard.'
	);
}

/**
 * Resolves the command line: `--provider` (or any sign-in option, which implies
 * it) asks the identity provider and takes no URL; otherwise the cached
 * sessions are shown, all of them or the one for the URL.
 */
export function whoamiInput(
	url: URL | undefined,
	options: WhoamiOptions
): WhoamiInput {
	if (options.provider !== true) {
		return { kind: 'sessions', ...(url !== undefined && { url }) };
	}

	if (url !== undefined) {
		throw new WhoamiProviderWithUrlError();
	}

	return {
		kind: 'provider',
		options: {
			oidcIssuer: options.oidcIssuer,
			clientId: options.clientId,
			...(options.headless === true && { headless: true })
		}
	};
}

/**
 * Shows the claims of the cached sessions' access tokens, or of an ID token
 * from the identity provider, which a person can send with an access request.
 */
export async function runWhoami(
	input: WhoamiInput,
	reporter: Reporter,
	dependencies: WhoamiDependencies
): Promise<void> {
	if (input.kind === 'provider') {
		await reportProvider(input.options, reporter, dependencies);

		return;
	}

	await reportSessions(input.url, reporter, dependencies);
}

export function registerWhoamiCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const command = program
		.command('whoami')
		.description(
			'Show who the cached sessions sign in as or, with --provider, the ' +
				'identity a trust rule must match to admit you.'
		)
		.argument(
			'[url]',
			'deployment or tenant URL whose session to show (default: every cached session)',
			parseWorkerUrl
		)
		.option(
			'--provider',
			'sign in with the identity provider without contacting cupboard, and ' +
				'show the claims a trust rule matches (implied by the options below)'
		);

	const signInOptions = identityLoginOptions({ provider: true });

	for (const option of signInOptions) {
		command.addOption(option);
	}

	command
		.addHelpText(
			'after',
			[
				'',
				'Without --provider, whoami reads only the cached sessions and sends',
				'nothing over the network. With it, whoami signs in exactly as `login`',
				'does, but never sends the ID token to cupboard. Send the issuer,',
				'audience and subject that it prints to the administrator of the',
				'tenant, or to an operator for access to the deployment.',
				'',
				'Claims are decoded locally and their signatures are not checked; the',
				'output is for display, and the server verifies every token it is given.',
				'',
				'Examples:',
				'  # Who are my cached sessions signed in as?',
				'  cupboard whoami',
				'',
				'  # What identity would a trust rule need to match for me?',
				'  cupboard whoami --provider',
				'',
				'  # The same, for another OpenID Connect provider',
				'  cupboard whoami --oidc-issuer https://idp.example.com --client-id <id>'
			].join('\n')
		)
		.action(async (url: URL | undefined, options: WhoamiOptions) => {
			const input = whoamiInput(url, options);
			const ui = commandUi(program, programOptions);
			const reporter = ui.reporter();

			await runWhoami(input, reporter, {
				listSessions: listCachedSessions,
				readSession: readCachedSession,
				readGrant: readCachedGrant,
				signIn: async (provider) => {
					// The token is only displayed, so it is bound to no server.
					const { idToken } = await new BoundSignIn(
						identitySignIn(provider, {
							openBrowser: (target) => {
								openBrowser(target, reporter);
							},
							info: (message) => {
								reporter.info(message);
							},
							readPastedRedirect: pastedRedirectReader(ui),
							signal: programOptions.signal
						})
					).idTokenFor([]);

					return idToken;
				},
				now: Date.now
			});
		});
}
