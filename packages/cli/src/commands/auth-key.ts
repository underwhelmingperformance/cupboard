import type { CliUi } from '@cupboard/cli-ui';
import { type AuthKeyId, authKeyIdSchema } from '@cupboard/nix-store/scalars';
import type {
	AuthKeySummary,
	ParsedAuthKeyListResponse,
	ParsedAuthKeyRetireResponse,
	ParsedAuthKeyRotateResponse
} from '@cupboard/protocol/keys';
import {
	formatTimestamp,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface RetireOptions {
	readonly yes?: boolean;
}

/**
 * The part of the derived client that the auth-key commands use, in the
 * contract's input and output shapes. The real `tenantRpc(...).keys.auth`
 * satisfies this interface by construction.
 */
export interface AuthKeyClient {
	list(): Promise<ParsedAuthKeyListResponse>;
	rotate(): Promise<ParsedAuthKeyRotateResponse>;
	retire(input: { kid: AuthKeyId }): Promise<ParsedAuthKeyRetireResponse>;
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
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runAuthKeyList(reporter, rpc.keys.auth);
		});

	authKey
		.command('rotate')
		.description(
			'Add a new active auth key and schedule the previous one for retirement.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runAuthKeyRotate(reporter, rpc.keys.auth);
		});

	authKey
		.command('retire')
		.description('Retire a superseded auth key once its tokens have expired.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<kid>', 'auth key id')
		.option('-y, --yes', 'retire without the confirmation prompt')
		.action(async (url: URL, kid: string, options: RetireOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runAuthKeyRetire(authKeyIdSchema.parse(kid), ui, rpc.keys.auth);
		});
}

export async function runAuthKeyList(
	reporter: Reporter,
	client: Pick<AuthKeyClient, 'list'>
): Promise<void> {
	const { keys } = await reporter.phase('Listing auth keys', () =>
		client.list()
	);

	reporter.result({
		kind: 'auth-keys',
		data: keys,
		rows: keys.map((key) => authKeyRow(key)),
		empty: 'No auth keys.'
	});
}

export async function runAuthKeyRotate(
	reporter: Reporter,
	client: Pick<AuthKeyClient, 'rotate'>
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
							value: formatTimestamp(retiring.scheduledRetireAt)
						}
					]),
			{ label: 'Keys in set', value: String(keys.length) }
		]
	});
	reporter.info('New tokens are signed with this key.');
}

export async function runAuthKeyRetire(
	kid: AuthKeyId,
	ui: CliUi,
	client: AuthKeyClient
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Retire auth key ${kid}?`,
		detail: 'Tokens still signed by this key can no longer be verified.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('The key was left in place.');
		return;
	}

	const reporter = ui.reporter();
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
			: `; retires ${formatTimestamp(key.scheduledRetireAt)}`;

	return {
		label: key.kid,
		value: `${key.active ? 'active' : 'retained'}; created ${formatTimestamp(key.createdAt)}${retirement}`
	};
}
