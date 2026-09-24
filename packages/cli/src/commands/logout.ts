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
			'Give the deployment or tenant URL to sign out of, or pass --all for ' +
				'every cached session, or --cloudflare for the Cloudflare sign-in; ' +
				'a URL and --all cannot be combined.'
		);
		this.name = 'LogoutTargetError';
	}
}

/**
 * Which sessions to delete: one target's, every one, or none (when only the
 * Cloudflare sign-in is to go).
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
 * Resolves the command line into what to delete. A URL and `--all` are
 * exclusive, and at least one of them or `--cloudflare` is required.
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
 * What became of the cached Cloudflare sign-in: deleted, never cached, or left
 * in place because `--cloudflare` was not given.
 */
type CloudflareSignInOutcome = Removal | 'kept';

export interface LogoutResult {
	/**
	The URL that the command signed out of, when the command line gave one.
	*/
	readonly url?: string;
	readonly sessionsRemoved: number;
	readonly cloudflareSignIn: CloudflareSignInOutcome;
	/**
	Always false: cupboard has no endpoint that revokes a refresh token.
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

async function resolveCloudflareSignIn(
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
				value: removed > 0 ? 'session removed' : 'no session was cached'
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
	absent: 'none was cached',
	kept: 'still cached'
};

/**
 * Deletes cached sessions, and the Cloudflare sign-in when asked. Logout does
 * not revoke anything on the server: cupboard has no revocation endpoint.
 *
 * The Cloudflare sign-in goes first. A renewal that falls back to it keeps the
 * grant lock until it has written its session, so once the grant is removed no
 * renewal can create a session that the removal below would miss.
 */
export async function runLogout(
	input: LogoutInput,
	reporter: Reporter,
	dependencies: LogoutDependencies
): Promise<LogoutResult> {
	const cloudflareSignIn = await resolveCloudflareSignIn(
		input.cloudflareSignIn,
		dependencies
	);
	const sessionsRemoved = await removeSessions(input.sessions, dependencies);
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
			'Your Cloudflare sign-in is still cached, and later commands can use it ' +
				'to start a new session without a browser. Run `cupboard logout ' +
				'--cloudflare` to remove it. `cupboard login` and `cupboard init` will ' +
				'then ask you to sign in to Cloudflare again.'
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
		.description(
			'Delete the cached session for a tenant or the deployment from this machine.'
		)
		.argument(
			'[url]',
			'deployment or tenant URL to sign out of ' +
				'(e.g. https://cupboard.example.workers.dev or .../t/<slug>)',
			parseWorkerUrl
		)
		.option('--all', 'delete every cached session')
		.option(
			'--cloudflare',
			'also delete the cached Cloudflare sign-in, which `login` and `init` share'
		)
		.addHelpText(
			'after',
			[
				'',
				'Sessions are deleted from this machine only. Logout does not revoke',
				'anything on the server, because cupboard has no endpoint that revokes',
				'a refresh token. A copy of a tenant session taken elsewhere can be',
				'renewed for up to 30 days after sign-in, unless the server stops',
				'accepting its refresh token earlier. A deployment session has no',
				'refresh token, and its access token expires ten minutes after',
				'sign-in.',
				'',
				'To end your access to a tenant on the server, a tenant administrator',
				'removes the trust rule that admits you. Renewal then stops, and the',
				'current access token expires within ten minutes.',
				'',
				'While a Cloudflare sign-in is cached, later commands can use it to',
				'start a new session without a browser; pass --cloudflare to remove it.',
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
