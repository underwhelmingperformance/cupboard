import type { CliUi } from '@cupboard/cli-ui';
import {
	type RefreshSessionId,
	refreshSessionIdSchema,
	type RefreshSessionListResponse,
	type RefreshSessionRevokeResponse,
	type RefreshSessionSummary
} from '@cupboard/protocol/sessions';
import {
	formatTimestamp,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { controlRpc, tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { deploymentUrlArgument, tenantUrlArgument } from '../url-argument.ts';

interface RevokeOptions {
	readonly yes?: boolean;
}

/**
 * The owner of the sign-in sessions that a command lists or revokes: one
 * tenant, or the operators at the control plane.
 */
export type SessionScope = 'tenant' | 'operator';

const sessionNouns: Readonly<Record<SessionScope, string>> = {
	tenant: 'tenant sign-in session',
	operator: 'operator sign-in session'
};

export interface SessionClient {
	list(): Promise<RefreshSessionListResponse>;
	revoke(input: {
		id: RefreshSessionId;
	}): Promise<RefreshSessionRevokeResponse>;
}

export function registerSessionCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const session = program
		.command('session')
		.description(
			"List and revoke the tenant's sign-in sessions, which renew access tokens for up to 30 days."
		);

	session
		.command('list')
		.description(
			'List unexpired sign-in sessions with their recorded identity and trust rule.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runSessionList(reporter, rpc.sessions, 'tenant');
		});

	session
		.command('revoke')
		.description(
			'Revoke a sign-in session. Its refresh token stops working immediately, and its last access token expires within ten minutes.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<id>', 'session ID, as `cupboard session list` shows it')
		.option('-y, --yes', 'revoke without the confirmation prompt')
		.action(async (url: URL, id: string, options: RevokeOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runSessionRevoke(
				refreshSessionIdSchema.parse(id),
				ui,
				rpc.sessions,
				'tenant'
			);
		});
}

/**
 * Registers `session list` and `session revoke` under `deployment`, for the
 * operators' sessions at the control plane.
 */
export function registerOperatorSessionCommands(
	deployment: Command,
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const session = deployment
		.command('session')
		.description(
			"List and revoke the operators' sign-in sessions, which renew access tokens for up to 30 days."
		);

	session
		.command('list')
		.description(
			'List unexpired operator sign-in sessions, with each identity and any recorded trust rule.'
		)
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runSessionList(reporter, rpc.sessions, 'operator');
		});

	session
		.command('revoke')
		.description(
			'Revoke an operator sign-in session. Its refresh token stops working immediately, and its last access token expires within ten minutes.'
		)
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument(
			'<id>',
			'session ID, as `cupboard deployment session list` shows it'
		)
		.option('-y, --yes', 'revoke without the confirmation prompt')
		.action(async (url: URL, id: string, options: RevokeOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runSessionRevoke(
				refreshSessionIdSchema.parse(id),
				ui,
				rpc.sessions,
				'operator'
			);
		});
}

export async function runSessionList(
	reporter: Reporter,
	client: Pick<SessionClient, 'list'>,
	scope: SessionScope
): Promise<void> {
	const noun = sessionNouns[scope];
	const { sessions } = await reporter.phase(
		'Listing sessions',
		() => client.list(),
		{ humanLabel: `Listing ${noun}s` }
	);

	reporter.result({
		kind: 'sessions',
		title: capitalised(`${noun}s`),
		data: sessions,
		rows: sessions.map((entry) => sessionRow(entry)),
		empty: 'No sign-in sessions.'
	});
}

export async function runSessionRevoke(
	id: RefreshSessionId,
	ui: CliUi,
	client: Pick<SessionClient, 'revoke'>,
	scope: SessionScope
): Promise<void> {
	const noun = sessionNouns[scope];
	const outcome = await ui.confirm({
		message: `Revoke ${noun} ${id}?`,
		detail:
			'Its refresh token stops working immediately. Its last access token remains valid until it expires, within ten minutes.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('The session was left in place.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase(
		'Revoking session',
		() => client.revoke({ id }),
		{ humanLabel: `Revoking ${noun}` }
	);

	reporter.result({
		kind: 'session',
		title: capitalised(noun),
		data: result,
		rows: [
			{ label: 'Session', value: result.id },
			{
				label: 'Outcome',
				value: result.revoked ? 'session revoked' : 'session not found'
			}
		]
	});
}

function sessionRow(session: RefreshSessionSummary): ResultRow {
	return {
		label: session.id,
		value: [
			`issuer ${session.issuer ?? 'unknown'}`,
			`subject ${session.subject ?? 'unknown'}`,
			`rule ${session.rule ?? 'unknown'}`,
			`created ${formatTimestamp(session.createdAt)}`,
			`expires ${formatTimestamp(session.expiresAt)}`
		].join('; ')
	};
}

function capitalised(text: string): string {
	return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
