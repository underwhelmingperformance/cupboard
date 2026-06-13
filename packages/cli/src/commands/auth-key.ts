import type {
	AuthKeyListResponse,
	AuthKeyRetireResponse,
	AuthKeyRotateResponse,
	AuthKeySummary
} from '@cupboard/protocol/keys';
import {
	createReporter,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { type ProgramOptions, reporterModeFromGlobals } from '../cli.ts';
import { tenantRpc } from '../client/orpc.ts';

/**
 * The slice of the derived client the auth-key commands consume, in the
 * contract's input and output shapes; the real `tenantRpc(...).keys.auth`
 * satisfies it by construction.
 */
export interface AuthKeyClient {
	list(): Promise<AuthKeyListResponse>;
	rotate(): Promise<AuthKeyRotateResponse>;
	retire(input: { kid: string }): Promise<AuthKeyRetireResponse>;
}

export function registerAuthKeyCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const authKey = program
		.command('auth-key')
		.description('Manage the access-token signing keys and rotation.');

	authKey
		.command('list')
		.description('List the auth signing-key set.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.action(async (url: string) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url),
				signal: programOptions.signal
			});

			await runAuthKeyList(reporter, rpc.keys.auth);
		});

	authKey
		.command('rotate')
		.description(
			'Add a new active auth key and schedule the previous one for retirement.'
		)
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.action(async (url: string) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url),
				signal: programOptions.signal
			});

			await runAuthKeyRotate(reporter, rpc.keys.auth);
		});

	authKey
		.command('retire')
		.description('Retire a superseded auth key once its tokens have expired.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.argument('<kid>', 'auth key id')
		.action(async (url: string, kid: string) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url),
				signal: programOptions.signal
			});

			await runAuthKeyRetire(kid, reporter, rpc.keys.auth);
		});
}

export async function runAuthKeyList(
	reporter: Reporter,
	client: AuthKeyClient
): Promise<void> {
	const { keys } = await reporter.phase('Listing auth keys', () =>
		client.list()
	);

	reporter.result({
		kind: 'auth-keys',
		data: keys,
		rows: keys.map((key) => authKeyRow(key))
	});
}

export async function runAuthKeyRotate(
	reporter: Reporter,
	client: AuthKeyClient
): Promise<void> {
	const { rotated, retiring, keys } = await reporter.phase(
		'Rotating auth key',
		() => client.rotate()
	);

	reporter.result({
		kind: 'auth-key-rotation',
		data: { rotated, retiring, keys },
		rows: [
			{ label: 'New key', value: rotated },
			...(retiring === undefined
				? []
				: [
						{ label: 'Retiring key', value: retiring.kid },
						{
							label: 'Scheduled retirement',
							value: retiring.scheduledRetireAt
						}
					]),
			{ label: 'Keys in set', value: String(keys.length) }
		]
	});
	reporter.info('New tokens are signed with this key.');
}

export async function runAuthKeyRetire(
	kid: string,
	reporter: Reporter,
	client: AuthKeyClient
): Promise<void> {
	const result = await reporter.phase('Retiring auth key', () =>
		client.retire({ kid })
	);

	reporter.result({
		kind: 'auth-key',
		data: result,
		rows: [
			{ label: 'Key', value: result.kid },
			{ label: 'Retired', value: result.retired ? 'yes' : 'not present' }
		]
	});
}

function authKeyRow(key: AuthKeySummary): ResultRow {
	const retirement =
		key.scheduledRetireAt === undefined
			? ''
			: `; retires ${key.scheduledRetireAt}`;

	return {
		label: key.kid,
		value: `${key.active ? 'active' : 'retained'}; created ${key.createdAt}${retirement}`
	};
}
