import { type CliUi, createCliUi } from '@cupboard/cli-ui';
import type {
	ControlKeyListResponse,
	ControlKeyRetireResponse,
	ControlKeyRotateResponse,
	ControlKeySummary
} from '@cupboard/protocol/control-keys';
import {
	formatTimestamp,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { type ProgramOptions, reporterModeFromGlobals } from '../cli.ts';
import { controlRpc } from '../client/orpc.ts';

interface RetireOptions {
	readonly yes?: boolean;
}

/**
 * The slice of the derived control client the control-key commands consume,
 * in the contract's input and output shapes; the real `controlRpc(...).keys`
 * satisfies it by construction.
 */
export interface ControlKeyClient {
	list(): Promise<ControlKeyListResponse>;
	rotate(): Promise<ControlKeyRotateResponse>;
	retire(input: { kid: string }): Promise<ControlKeyRetireResponse>;
}

const urlArgument =
	'deployment URL (e.g. https://cupboard.example.workers.dev)';

export function registerControlKeyCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const controlKey = program
		.command('control-key')
		.description('Manage the control-plane signing keys and rotation.');

	controlKey
		.command('list')
		.description('List the control-plane signing-key set.')
		.argument('<url>', urlArgument)
		.action(async (url: string) => {
			const reporter = createCliUi({
				mode: reporterModeFromGlobals(program)
			}).reporter();
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
		.argument('<url>', urlArgument)
		.action(async (url: string) => {
			const reporter = createCliUi({
				mode: reporterModeFromGlobals(program)
			}).reporter();
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
		.argument('<url>', urlArgument)
		.argument('<kid>', 'control key id')
		.option('-y, --yes', 'retire without the confirmation prompt')
		.action(async (url: string, kid: string, options: RetireOptions) => {
			const ui = createCliUi({
				mode: reporterModeFromGlobals(program),
				assumeYes: options.yes
			});
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runControlKeyRetire(kid, ui, rpc.keys);
		});
}

export async function runControlKeyList(
	reporter: Reporter,
	client: ControlKeyClient
): Promise<void> {
	const { keys } = await reporter.phase('Listing control keys', () =>
		client.list()
	);

	reporter.result({
		kind: 'control-keys',
		data: keys,
		rows: keys.map((key) => controlKeyRow(key))
	});
}

export async function runControlKeyRotate(
	reporter: Reporter,
	client: ControlKeyClient
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
	kid: string,
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
