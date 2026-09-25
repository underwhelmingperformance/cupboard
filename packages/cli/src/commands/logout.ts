import { canonicalHref } from '@cupboard/nix-store/url';
import type { Reporter, ResultRow } from '@cupboard/reporter';
import type { Command } from 'commander';

import type { Removal } from '../auth/secret-file.ts';
import {
	removeAllCachedSessions,
	removeCachedSession
} from '../auth/token-store.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import type { CloudflareGrant } from '../deploy/cloudflare-oauth.ts';
import { readCachedGrant, removeCachedGrant } from '../deploy/grant-store.ts';
import { CliUsageError } from '../errors.ts';

interface LogoutOptions {
	readonly all?: boolean;
	readonly cloudflare?: boolean;
}

export class LogoutTargetError extends CliUsageError {
	constructor() {
		super(
			'Give the deployment or tenant URL to sign out of, or pass --all to ' +
				'sign out of everything. Pass --cloudflare to forget your Cloudflare ' +
				"sign-in. You can't give a URL and --all together."
		);
		this.name = 'LogoutTargetError';
	}
}

/**
 * Which sessions to delete. `none` is for when you only want to forget the
 * Cloudflare sign-in.
 */
type LogoutSessions =
	| { readonly kind: 'url'; readonly url: URL }
	| { readonly kind: 'all' }
	| { readonly kind: 'none' };

export interface LogoutInput {
	readonly sessions: LogoutSessions;
	readonly cloudflareSignIn: 'remove' | 'keep';
}

/**
 * Works out what to delete from the command line. You can give a URL or
 * `--all`, but not both. You must give at least one of them, or `--cloudflare`.
 */
export function logoutInput(
	url: URL | undefined,
	options: LogoutOptions
): LogoutInput {
	if (url !== undefined && options.all === true) {
		throw new LogoutTargetError();
	}

	const cloudflareSignIn = options.cloudflare === true ? 'remove' : 'keep';

	if (url !== undefined) {
		return { sessions: { kind: 'url', url }, cloudflareSignIn };
	}

	if (options.all === true) {
		return { sessions: { kind: 'all' }, cloudflareSignIn };
	}

	if (cloudflareSignIn === 'keep') {
		throw new LogoutTargetError();
	}

	return { sessions: { kind: 'none' }, cloudflareSignIn };
}

export interface LogoutDependencies {
	readonly removeSession: (url: URL, signal?: AbortSignal) => Promise<Removal>;
	readonly removeAllSessions: (signal?: AbortSignal) => Promise<number>;
	readonly readGrant: () => Promise<CloudflareGrant | undefined>;
	readonly removeGrant: (signal?: AbortSignal) => Promise<Removal>;
	readonly signal?: AbortSignal;
}

/**
 * What happened to the saved Cloudflare sign-in. It was deleted, there wasn't
 * one, or it was kept because `--cloudflare` wasn't given.
 */
type CloudflareSignInOutcome = Removal | 'kept';

export interface LogoutResult {
	/**
	The tenant or deployment URL from the command line, if one was given.
	*/
	readonly url?: string;
	readonly sessionsRemoved: number;
	readonly cloudflareSignIn: CloudflareSignInOutcome;
	/**
	Always false, because cupboard has no way to revoke a refresh token.
	*/
	readonly revoked: false;
}

async function removeSessions(
	sessions: LogoutSessions,
	dependencies: LogoutDependencies
): Promise<number> {
	switch (sessions.kind) {
		case 'url': {
			const removal = await dependencies.removeSession(
				sessions.url,
				dependencies.signal
			);

			return removal === 'removed' ? 1 : 0;
		}
		case 'all': {
			return dependencies.removeAllSessions(dependencies.signal);
		}
		case 'none': {
			return 0;
		}
	}
}

async function settleCloudflareSignIn(
	intent: LogoutInput['cloudflareSignIn'],
	dependencies: LogoutDependencies
): Promise<CloudflareSignInOutcome> {
	if (intent === 'remove') {
		return dependencies.removeGrant(dependencies.signal);
	}

	const grant = await dependencies.readGrant();

	return grant === undefined ? 'absent' : 'kept';
}

function sessionsRow(
	sessions: LogoutSessions,
	removed: number
): ResultRow | undefined {
	switch (sessions.kind) {
		case 'url': {
			return {
				label: canonicalHref(sessions.url),
				value: removed > 0 ? 'signed out' : 'no saved session'
			};
		}
		case 'all': {
			return { label: 'Sessions removed', value: String(removed) };
		}
		case 'none': {
			return undefined;
		}
	}
}

const cloudflareSignInLabels: Readonly<
	Record<CloudflareSignInOutcome, string>
> = {
	removed: 'removed',
	absent: 'none saved',
	kept: 'still saved'
};

/**
 * Deletes saved sessions, and the Cloudflare sign-in if asked. This only
 * affects this machine. cupboard can't revoke a session, so its refresh token
 * keeps working on the server until it expires.
 */
export async function runLogout(
	input: LogoutInput,
	reporter: Reporter,
	dependencies: LogoutDependencies
): Promise<LogoutResult> {
	const sessionsRemoved = await removeSessions(input.sessions, dependencies);
	const cloudflareSignIn = await settleCloudflareSignIn(
		input.cloudflareSignIn,
		dependencies
	);
	const result: LogoutResult = {
		...(input.sessions.kind === 'url' && {
			url: canonicalHref(input.sessions.url)
		}),
		sessionsRemoved,
		cloudflareSignIn,
		revoked: false
	};
	const sessions = sessionsRow(input.sessions, sessionsRemoved);
	const rows: ResultRow[] = sessions === undefined ? [] : [sessions];

	if (cloudflareSignIn === 'kept' || input.cloudflareSignIn === 'remove') {
		rows.push({
			label: 'Cloudflare sign-in',
			value: cloudflareSignInLabels[cloudflareSignIn]
		});
	}

	reporter.result({ kind: 'logout', data: result, rows });

	if (cloudflareSignIn === 'kept') {
		reporter.warn(
			'Your Cloudflare sign-in is still saved, so cupboard can use it to sign ' +
				'you in again without a browser. To remove it, run `cupboard logout ' +
				'--cloudflare`. After that, `cupboard login` and `cupboard init` will ' +
				'open a browser to sign in to Cloudflare.'
		);
	}

	return result;
}

export function registerLogoutCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('logout')
		.description('Sign out of a tenant or the deployment on this machine.')
		.argument(
			'[url]',
			'the deployment or tenant URL to sign out of ' +
				'(e.g. https://cupboard.example.workers.dev or .../t/<slug>)',
			parseWorkerUrl
		)
		.option('--all', 'sign out of everything')
		.option(
			'--cloudflare',
			'also forget your Cloudflare sign-in, which `login` and `init` use'
		)
		.addHelpText(
			'after',
			[
				'',
				'logout only deletes the session saved on this machine. cupboard has no',
				'way to cancel a session, so a copy of it elsewhere keeps working for',
				"up to 30 days after you signed in. To take away someone's access, a",
				'tenant administrator removes their trust rule. They then lose access',
				'within ten minutes.',
				'',
				'If you signed in with Cloudflare, cupboard remembers that sign-in and',
				'can use it to sign you in again without a browser. Add --cloudflare to',
				'forget it too.',
				'',
				'Examples:',
				'  cupboard logout https://cupboard.example.workers.dev/t/acme',
				'  cupboard logout --all --cloudflare'
			].join('\n')
		)
		.action(async (url: URL | undefined, options: LogoutOptions) => {
			const input = logoutInput(url, options);
			const reporter = commandUi(program, programOptions).reporter();

			await runLogout(input, reporter, {
				removeSession: removeCachedSession,
				removeAllSessions: removeAllCachedSessions,
				readGrant: readCachedGrant,
				removeGrant: removeCachedGrant,
				signal: programOptions.signal
			});
		});
}
