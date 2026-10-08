import { canonicalHref } from '@cupboard/nix-store/url';
import type { Reporter, ResultRow } from '@cupboard/reporter';
import type { Command } from 'commander';
import { z } from 'zod';

import { type SessionIdentity, sessionIdentity } from '../auth/identity.ts';
import { decodeJwtPayload } from '../auth/jwt.ts';
import {
	type RevocationOutcome,
	revokeRefreshToken
} from '../auth/revocation.ts';
import type { Removal } from '../auth/secret-file.ts';
import {
	type CachedSession,
	removeAllCachedSessions,
	removeCachedSession,
	type RemovedSession
} from '../auth/token-store.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { parseWorkerUrl, resilientFetcher } from '../client/transport.ts';
import {
	type CloudflareGrant,
	revokeCloudflareGrant
} from '../deploy/cloudflare-oauth.ts';
import {
	type GrantRemoval,
	readCachedGrant,
	removeCachedGrant
} from '../deploy/grant-store.ts';
import { CliUsageError } from '../errors.ts';

interface LogoutOptions {
	readonly all?: boolean;
	readonly cloudflare?: boolean;
}

export class LogoutTargetError extends CliUsageError {
	override readonly humanMessage =
		'Give the deployment or tenant URL to sign out of, or pass --all for every saved sign-in, or --cloudflare for the Cloudflare sign-in. A URL and --all cannot be combined.';
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
	readonly removeSession: (
		url: URL,
		signal?: AbortSignal
	) => Promise<RemovedSession>;
	readonly removeAllSessions: (
		signal?: AbortSignal
	) => Promise<readonly (CachedSession | undefined)[]>;
	readonly readGrant: () => Promise<CloudflareGrant | undefined>;
	readonly removeGrant: (
		revoke: (grant: CloudflareGrant) => Promise<RevocationOutcome>,
		signal?: AbortSignal
	) => Promise<GrantRemoval>;
	readonly fetcher: typeof fetch;
	readonly signal?: AbortSignal;
}

type CloudflareSignInOutcome = Removal | 'kept' | 'unreadable';

/**
 * The revocation of one deleted session. `target` is the tenant or deployment
 * URL of the session, when the command line or the saved session shows it.
 */
export interface SessionRevocation {
	readonly target?: string;
	readonly revocation: RevocationOutcome;
}

export interface LogoutResult {
	/**
	The URL that the command signed out of, when the command line gave one.
	*/
	readonly url?: string;
	readonly sessionsRemoved: number;
	readonly cloudflareSignIn: CloudflareSignInOutcome;
	readonly revoked: {
		readonly sessions: readonly SessionRevocation[];
		/**
		Present when the command deleted a Cloudflare sign-in.
		*/
		readonly cloudflareSignIn?: RevocationOutcome;
	};
}

interface RemovedTarget {
	readonly target: URL | undefined;
	readonly session: CachedSession | undefined;
}

const issuerClaimSchema = z.object({ iss: z.string() });

// The access token's issuer is the tenant or deployment URL of the session.
// Its signature is not checked here: the token only selects where the
// matching refresh token is sent, and both came from the same saved file.
function sessionTarget(session: CachedSession | undefined): URL | undefined {
	const claims = issuerClaimSchema.safeParse(
		session === undefined ? undefined : decodeJwtPayload(session.accessToken)
	);

	if (!claims.success) {
		return undefined;
	}

	try {
		return parseWorkerUrl(claims.data.iss);
	} catch {
		return undefined;
	}
}

async function removeSessions(
	sessions: LogoutSessions,
	dependencies: LogoutDependencies
): Promise<readonly RemovedTarget[]> {
	switch (sessions.kind) {
		case 'url': {
			const removed = await dependencies.removeSession(
				sessions.url,
				dependencies.signal
			);

			return removed.removal === 'removed'
				? [{ target: sessions.url, session: removed.session }]
				: [];
		}
		case 'all': {
			const removed = await dependencies.removeAllSessions(dependencies.signal);

			return removed.map((session) => ({
				target: sessionTarget(session),
				session
			}));
		}
		case 'none': {
			return [];
		}
	}
}

async function revokeSession(
	removed: RemovedTarget,
	dependencies: LogoutDependencies
): Promise<SessionRevocation> {
	const target =
		removed.target === undefined
			? {}
			: { target: canonicalHref(removed.target) };

	if (removed.session === undefined || removed.target === undefined) {
		return { ...target, revocation: 'failed' };
	}

	if (removed.session.refreshToken === undefined) {
		return { ...target, revocation: 'no-refresh-token' };
	}

	return {
		...target,
		revocation: await revokeRefreshToken(
			removed.target,
			removed.session.refreshToken,
			dependencies.fetcher,
			dependencies.signal
		)
	};
}

interface RevokedSession {
	readonly revocation: SessionRevocation;
	readonly kind: SessionIdentity['kind'] | undefined;
}

async function revokeSessions(
	removed: readonly RemovedTarget[],
	dependencies: LogoutDependencies
): Promise<readonly RevokedSession[]> {
	const revoked: RevokedSession[] = [];

	for (const entry of removed) {
		revoked.push({
			revocation: await revokeSession(entry, dependencies),
			kind:
				entry.session === undefined
					? undefined
					: sessionIdentity(entry.session)?.kind
		});
	}

	return revoked;
}

const sessionKinds: readonly SessionIdentity['kind'][] = [
	'tenant',
	'deployment'
];

const sessionRevokeHints: Readonly<Record<SessionIdentity['kind'], string>> = {
	tenant:
		'A tenant administrator can end a tenant session with ' +
		'`cupboard session revoke`.',
	deployment:
		'An operator can end a deployment session with ' +
		'`cupboard deployment session revoke`.'
};

function failedRevocationHints(
	revoked: readonly RevokedSession[]
): readonly string[] {
	const kinds = new Set(
		revoked
			.filter((entry) => entry.revocation.revocation === 'failed')
			.flatMap((entry) =>
				entry.kind === undefined ? sessionKinds : [entry.kind]
			)
	);

	return sessionKinds
		.filter((kind) => kinds.has(kind))
		.map((kind) => sessionRevokeHints[kind]);
}

interface CloudflareSignInResolution {
	readonly outcome: CloudflareSignInOutcome;
	readonly revocation?: RevocationOutcome;
}

async function resolveCloudflareSignIn(
	intent: LogoutInput['cloudflareSignIn'],
	dependencies: LogoutDependencies
): Promise<CloudflareSignInResolution> {
	if (intent === 'remove') {
		const removed = await dependencies.removeGrant(
			(grant) =>
				revokeCloudflareGrant(grant, dependencies.fetcher, dependencies.signal),
			dependencies.signal
		);

		return {
			outcome: removed.removal,
			...(removed.revocation !== undefined && {
				revocation: removed.revocation
			})
		};
	}

	try {
		const grant = await dependencies.readGrant();

		return { outcome: grant === undefined ? 'absent' : 'kept' };
	} catch {
		return { outcome: 'unreadable' };
	}
}

const revocationLabels: Readonly<Record<RevocationOutcome, string>> = {
	revoked: 'refresh token revoked',
	failed: 'revocation could not be confirmed',
	'no-refresh-token': 'no refresh token to revoke'
};

function sessionRows(
	sessions: LogoutSessions,
	revocations: readonly SessionRevocation[]
): ResultRow[] {
	switch (sessions.kind) {
		case 'url': {
			const [revocation] = revocations;

			return [
				{
					label: canonicalHref(sessions.url),
					value:
						revocation === undefined
							? 'no saved sign-in'
							: `saved sign-in removed; ${revocationLabels[revocation.revocation]}`
				}
			];
		}
		case 'all': {
			return [
				{
					label: 'Saved sign-ins removed',
					value: String(revocations.length)
				},
				...revocations.map((revocation) => ({
					label: revocation.target ?? 'Unreadable saved sign-in',
					value: revocationLabels[revocation.revocation]
				}))
			];
		}
		case 'none': {
			return [];
		}
	}
}

const cloudflareSignInLabels: Readonly<
	Record<CloudflareSignInOutcome, string>
> = {
	removed: 'removed',
	absent: 'none was cached',
	kept: 'still cached',
	unreadable: 'could not be checked'
};

function cloudflareSignInLabel(resolution: CloudflareSignInResolution): string {
	const label = cloudflareSignInLabels[resolution.outcome];

	return resolution.revocation === undefined
		? label
		: `${label}; ${revocationLabels[resolution.revocation]}`;
}

/**
 * Deletes cached sessions, and the Cloudflare sign-in when asked, and sends
 * revocation requests for their refresh tokens to the servers. The local files
 * are deleted whether or not a revocation succeeds.
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
	const removed = await removeSessions(input.sessions, dependencies);
	const revoked = await revokeSessions(removed, dependencies);
	const revocations = revoked.map((entry) => entry.revocation);
	const result: LogoutResult = {
		...(input.sessions.kind === 'url' && {
			url: canonicalHref(input.sessions.url)
		}),
		sessionsRemoved: removed.length,
		cloudflareSignIn: cloudflareSignIn.outcome,
		revoked: {
			sessions: revocations,
			...(cloudflareSignIn.revocation !== undefined && {
				cloudflareSignIn: cloudflareSignIn.revocation
			})
		}
	};
	const rows = sessionRows(input.sessions, revocations);

	if (
		cloudflareSignIn.outcome === 'kept' ||
		cloudflareSignIn.outcome === 'unreadable' ||
		input.cloudflareSignIn === 'remove'
	) {
		rows.push({
			label: 'Cloudflare sign-in',
			value: cloudflareSignInLabel(cloudflareSignIn)
		});
	}

	reporter.result({
		kind: 'logout',
		title: 'Signed out on this machine',
		data: result,
		rows
	});

	const hasRevoked =
		revocations.some((revocation) => revocation.revocation === 'revoked') ||
		cloudflareSignIn.revocation === 'revoked';

	if (hasRevoked) {
		reporter.info(
			'A revoked refresh token cannot renew its sign-in. A copy of a cupboard ' +
				'access token remains valid for up to ten minutes, and a copy of a ' +
				'Cloudflare access token until it expires.'
		);
	}

	const hasFailedRevocation =
		revocations.some((revocation) => revocation.revocation === 'failed') ||
		cloudflareSignIn.revocation === 'failed';

	if (hasFailedRevocation) {
		reporter.warn(
			[
				'Could not confirm revocation of some refresh tokens. A copied token ' +
					'might remain usable.',
				...failedRevocationHints(revoked)
			].join(' ')
		);
	}

	if (cloudflareSignIn.outcome === 'kept') {
		reporter.warn(
			'Your Cloudflare sign-in is still cached, and it can deploy to your ' +
				'Cloudflare account. Run `cupboard logout --cloudflare` to remove it. ' +
				'`cupboard init` will then ask you to sign in to Cloudflare again.'
		);
	} else if (cloudflareSignIn.outcome === 'unreadable') {
		reporter.warn(
			'Could not check the cached Cloudflare sign-in. Run `cupboard logout ' +
				'--cloudflare` to remove the sign-in.'
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
			'Remove a saved sign-in for a tenant or deployment from this machine, and revoke its refresh token.'
		)
		.argument(
			'[url]',
			'deployment or tenant URL to sign out of ' +
				'(e.g. https://cupboard.example.workers.dev or .../t/<slug>)',
			parseWorkerUrl
		)
		.option('--all', 'delete every saved sign-in')
		.option(
			'--cloudflare',
			'also delete the cached Cloudflare sign-in, which `init` keeps for the Cloudflare API'
		)
		.addHelpText(
			'after',
			[
				'',
				'Logout sends a revocation request for the refresh token of each saved',
				'sign-in that it deletes. With --cloudflare, it also sends Cloudflare a',
				'revocation request for the Cloudflare refresh token. The saved files',
				'are deleted even when a revocation fails. A copy of a revoked sign-in',
				'cannot be renewed. A copy of a cupboard access token remains valid for',
				'up to ten minutes, and a copy of a Cloudflare access token until it',
				'expires.',
				'',
				'If a revocation fails, a copy of that sign-in on another machine',
				'can be renewed for up to 30 days after sign-in. A tenant',
				'administrator can end it with `cupboard session revoke`, and an',
				'operator with `cupboard deployment session revoke`.',
				'',
				'A cached Cloudflare sign-in can deploy to your Cloudflare account;',
				'pass --cloudflare to remove it.',
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
				fetcher: resilientFetcher('replay-safe'),
				signal: programOptions.signal
			});
		});
}
