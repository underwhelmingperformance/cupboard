import type { CliUi } from '@cupboard/cli-ui';
import { type AuthKeyId, authKeyIdSchema } from '@cupboard/nix-store/scalars';
import type {
	ControlKeySummary,
	ParsedControlKeyListResponse,
	ParsedControlKeyRetireResponse,
	ParsedControlKeyRotateResponse
} from '@cupboard/protocol/control-keys';
import {
	formatTimestamp,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { controlRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { deploymentUrlArgument } from '../url-argument.ts';

interface RetireOptions {
	readonly yes?: boolean;
}

export interface ControlKeyClient {
	list(): Promise<ParsedControlKeyListResponse>;
	rotate(): Promise<ParsedControlKeyRotateResponse>;
	retire(input: { kid: AuthKeyId }): Promise<ParsedControlKeyRetireResponse>;
}

export function registerControlKeyCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const controlKey = program
		.command('control-key')
		.description(
			'Manage the control-plane signing keys and rotation (operator only).'
		);

	controlKey
		.command('list')
		.description('List the control-plane signing-key set.')
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runControlKeyList(reporter, rpc.keys);
		});

	controlKey
		.command('rotate')
		.description(
			'Add a new active control key and schedule the previous one for retirement.'
		)
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runControlKeyRotate(reporter, rpc.keys);
		});

	controlKey
		.command('retire')
		.description(
			'Retire a superseded control key once its tokens have expired.'
		)
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<kid>', 'control key id')
		.option('-y, --yes', 'retire without the confirmation prompt')
		.action(async (url: URL, kid: string, options: RetireOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runControlKeyRetire(authKeyIdSchema.parse(kid), ui, rpc.keys);
		});
}

export async function runControlKeyList(
	reporter: Reporter,
	client: Pick<ControlKeyClient, 'list'>
): Promise<void> {
	const { keys } = await reporter.phase('Listing control keys', () =>
		client.list()
	);

	reporter.result({
		kind: 'control-keys',
		data: keys,
		rows: keys.map((key) => controlKeyRow(key)),
		empty: 'No control keys.'
	});
}

export async function runControlKeyRotate(
	reporter: Reporter,
	client: Pick<ControlKeyClient, 'rotate'>
): Promise<void> {
	const { kid, retiring } = await reporter.phase('Rotating control key', () =>
		client.rotate()
	);

	reporter.result({
		kind: 'control-key-rotation',
		data: { kid, retiring },
		rows: [
			{ label: 'New key', value: kid },
			...(retiring === undefined
				? []
				: [
						{ label: 'Retiring key', value: retiring.kid },
						{
							label: 'Scheduled retirement',
							value: formatTimestamp(retiring.scheduledRetireAt)
						}
					])
		]
	});
	reporter.info('New control tokens are signed with this key.');
}

export async function runControlKeyRetire(
	kid: AuthKeyId,
	ui: CliUi,
	client: ControlKeyClient
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Retire control key ${kid}?`,
		detail: 'Control tokens still signed by this key can no longer be verified.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('The key was left in place.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase('Retiring control key', () =>
		client.retire({ kid })
	);

	reporter.result({
		kind: 'control-key',
		data: result,
		rows: [
			{ label: 'Key', value: result.kid },
			{ label: 'Retired', value: result.retired ? 'yes' : 'not present' }
		]
	});
}

function controlKeyRow(key: ControlKeySummary): ResultRow {
	const retirement =
		key.scheduledRetireAt === undefined
			? ''
			: `; retires ${formatTimestamp(key.scheduledRetireAt)}`;

	return {
		label: key.kid,
		value: `${key.retired ? 'retired' : 'live'}${retirement}`
	};
}
