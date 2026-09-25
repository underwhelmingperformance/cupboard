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
			`You aren't signed in to ${url}. Sign in with \`cupboard login ${url}\`.`
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
			"--provider doesn't take a URL, because it only signs in to your " +
				'identity provider. Leave out the URL, or leave out --provider to ' +
				'show your session for that URL.'
		);
		this.name = 'WhoamiProviderWithUrlError';
	}
}

/**
 * What `whoami` reads. Tests pass their own versions, so they don't need real
 * files or a browser.
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
 * The saved sessions, and the saved Cloudflare sign-in if there is one. That
 * sign-in can start new sessions without opening a browser.
 */
interface WhoamiSessions {
	readonly sessions: readonly SessionIdentity[];
	/**
	Present when a Cloudflare sign-in is saved. Includes its subject if known.
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
			value: grant.subject ?? 'saved'
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
			"You aren't signed in anywhere. Sign in with `cupboard login <url>`. " +
			'To see which identity you would sign in with, run ' +
			'`cupboard whoami --provider`.'
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
		'To get access, send the issuer, audience and subject to a tenant ' +
			'administrator. They can add a trust rule that lets you sign in. ' +
			"Nothing was sent to cupboard, and the token's signature wasn't checked."
	);
}

/**
 * Works out what to show from the command line. `--provider` asks the identity
 * provider and doesn't take a URL. Any of the sign-in options turns
 * `--provider` on. Otherwise whoami shows all the saved sessions, or only the
 * session for the given URL.
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
 * Shows who the saved sessions are signed in as. With `--provider`, it shows
 * who the identity provider says you are instead, so you can ask for access
 * before any trust rule lets you in.
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
			'Show who you are signed in as. With --provider, show the identity ' +
				'an administrator needs to give you access.'
		)
		.argument(
			'[url]',
			'only show your session for this deployment or tenant URL',
			parseWorkerUrl
		)
		.option(
			'--provider',
			'sign in to your identity provider and show your identity, without ' +
				'contacting cupboard (implied by the options below)'
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
				'Without --provider, whoami only looks at the sessions saved on this',
				'machine. It does not use the network.',
				'',
				'With --provider, whoami signs you in the same way as `login`, but',
				'does not contact cupboard. Use it before you have access: send the',
				'issuer, audience and subject it prints to a tenant administrator, who',
				'can then add a trust rule for you.',
				'',
				'whoami decodes tokens without checking their signatures. This is fine',
				'for showing them, because cupboard checks every token it receives.',
				'',
				'Examples:',
				'  # Who am I signed in as?',
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
