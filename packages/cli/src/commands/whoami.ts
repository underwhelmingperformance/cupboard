import { canonicalHref } from '@cupboard/nix-store/url';
import {
	formatTimestamp,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import type { Command } from 'commander';

import {
	type ProviderIdentity,
	providerIdentity,
	type SessionIdentity,
	sessionIdentity
} from '../auth/identity.ts';
import {
	type CachedSession,
	listCachedSessions,
	readCachedSession
} from '../auth/token-store.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import type { CloudflareGrant } from '../deploy/cloudflare-oauth.ts';
import { readCachedGrant } from '../deploy/grant-store.ts';
import { authExitCode, CliError, CliUsageError } from '../errors.ts';

import {
	providerIdToken,
	type ProviderSignInOptions,
	providerSignInOptions
} from './login.ts';

export interface WhoamiOptions extends ProviderSignInOptions {
	readonly provider?: boolean;
}

export class NoCachedSessionError extends CliError {
	constructor(public readonly url: string) {
		super(
			`No session is cached for ${url}. Sign in with \`cupboard login ${url}\`.`
		);
		this.name = 'NoCachedSessionError';
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
	readonly listSessions: () => Promise<readonly CachedSession[]>;
	readonly readSession: (target: URL) => Promise<CachedSession | undefined>;
	readonly readGrant: () => Promise<CloudflareGrant | undefined>;
	readonly signIn: (options: ProviderSignInOptions) => Promise<string>;
	readonly now: () => number;
}

export type WhoamiInput =
	| { readonly kind: 'sessions'; readonly url?: URL }
	| { readonly kind: 'provider'; readonly options: ProviderSignInOptions };

/**
 * The cached sessions and, when one is cached, the Cloudflare sign-in that
 * can start new sessions silently.
 */
interface WhoamiSessions {
	readonly sessions: readonly SessionIdentity[];
	/**
	Present when a Cloudflare sign-in is cached; its subject when recorded.
	*/
	readonly cloudflareSignIn?: { readonly subject?: string };
}

function sessionSummary(session: SessionIdentity, now: number): string {
	const expiry = session.accessTokenExpiresAt;
	const accessState =
		expiry === undefined
			? undefined
			: Date.parse(expiry) <= now
				? `access token expired ${formatTimestamp(expiry)}`
				: `access token expires ${formatTimestamp(expiry)}`;

	return [
		session.subject ?? 'unknown subject',
		session.kind,
		session.rule === undefined ? undefined : `rule ${session.rule}`,
		accessState,
		session.renewable ? 'renewable' : 'not renewable'
	]
		.filter((part) => part !== undefined)
		.join(' · ');
}

async function reportSessions(
	url: URL | undefined,
	reporter: Reporter,
	dependencies: WhoamiDependencies
): Promise<void> {
	const cached =
		url === undefined
			? await dependencies.listSessions()
			: [await dependencies.readSession(url)].filter(
					(session) => session !== undefined
				);

	if (url !== undefined && cached.length === 0) {
		throw new NoCachedSessionError(canonicalHref(url));
	}

	const sessions = cached
		.map((session) => sessionIdentity(session))
		.filter((session) => session !== undefined);
	const grant = await dependencies.readGrant();
	const now = dependencies.now();
	const rows: ResultRow[] = sessions.map((session) => ({
		label: session.url,
		value: sessionSummary(session, now)
	}));

	if (grant !== undefined && rows.length > 0) {
		rows.push({
			label: 'Cloudflare sign-in',
			value: grant.subject ?? 'cached'
		});
	}

	const data: WhoamiSessions = {
		sessions,
		...(grant !== undefined && {
			cloudflareSignIn: {
				...(grant.subject !== undefined && { subject: grant.subject })
			}
		})
	};

	reporter.result({
		kind: 'whoami',
		data,
		rows,
		empty:
			'No sessions are cached. Sign in with `cupboard login <url>`, or run ' +
			'`cupboard whoami --provider` to see the identity you would sign in as.'
	});
}

function providerRows(identity: ProviderIdentity): ResultRow[] {
	const audience =
		typeof identity.audience === 'string'
			? identity.audience
			: identity.audience.join(', ');

	return [
		{ label: 'Issuer', value: identity.issuer },
		{ label: 'Audience', value: audience },
		{ label: 'Subject', value: identity.subject },
		...(identity.expiresAt === undefined
			? []
			: [{ label: 'Expires', value: formatTimestamp(identity.expiresAt) }]),
		...Object.entries(identity.claims)
			.filter(([name]) => name !== 'sub')
			.map(([name, value]) => ({ label: `Claim ${name}`, value }))
	];
}

async function reportProvider(
	options: ProviderSignInOptions,
	reporter: Reporter,
	dependencies: WhoamiDependencies
): Promise<void> {
	const idToken = await dependencies.signIn(options);
	const identity = providerIdentity(idToken, options.clientId);

	reporter.result({
		kind: 'whoami-provider',
		data: identity,
		rows: providerRows(identity)
	});
	reporter.info(
		'Send the issuer, audience and subject to a tenant administrator: a ' +
			'trust rule matching them lets you sign in. The claims were decoded ' +
			'locally without checking the signature, and nothing was sent to cupboard.'
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
 * Shows the identity of the cached sessions, or of the person as their identity
 * provider sees them, so they can ask for access before any rule admits them.
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

	const signInOptions = providerSignInOptions({ provider: true });

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
				'does, but never sends the ID token to cupboard: send the issuer,',
				'audience and subject it prints to a tenant administrator.',
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
			const reporter = commandUi(program, programOptions).reporter();

			await runWhoami(input, reporter, {
				listSessions: listCachedSessions,
				readSession: readCachedSession,
				readGrant: readCachedGrant,
				signIn: (provider) =>
					providerIdToken(provider, reporter, programOptions.signal),
				now: Date.now
			});
		});
}
