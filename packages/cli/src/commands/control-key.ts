import type {
	ControlKeyListResponse,
	ControlKeyRetireResponse,
	ControlKeyRotateResponse,
	ControlKeySummary
} from '@cupboard/protocol/control-keys';
import {
	createReporter,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { type ProgramOptions, reporterModeFromGlobals } from '../cli.ts';
import { controlRpc } from '../client/orpc.ts';

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
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url),
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
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url),
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
		.action(async (url: string, kid: string) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url),
				signal: programOptions.signal
			});

			await runControlKeyRetire(kid, reporter, rpc.keys);
		});
}

export async function runControlKeyList(
	reporter: Reporter,
	client: ControlKeyClient
): Promise<void> {
	const { keys } = await reporter.phase('Listing control keys', () =>
		client.list()
	);

	reporter.result(keys.map((key) => controlKeyRow(key)));
}

export async function runControlKeyRotate(
	reporter: Reporter,
	client: ControlKeyClient
): Promise<void> {
	const { kid, retiring } = await reporter.phase('Rotating control key', () =>
		client.rotate()
	);

	reporter.result([
		{ label: 'New key', value: kid },
		...(retiring === undefined
			? []
			: [
					{ label: 'Retiring key', value: retiring.kid },
					{
						label: 'Scheduled retirement',
						value: retiring.scheduledRetireAt
					}
				])
	]);
	reporter.info('New control tokens are signed with this key.');
}

export async function runControlKeyRetire(
	kid: string,
	reporter: Reporter,
	client: ControlKeyClient
): Promise<void> {
	const result = await reporter.phase('Retiring control key', () =>
		client.retire({ kid })
	);

	reporter.result([
		{ label: 'Key', value: result.kid },
		{ label: 'Retired', value: result.retired ? 'yes' : 'not present' }
	]);
}

function controlKeyRow(key: ControlKeySummary): ResultRow {
	const retirement =
		key.scheduledRetireAt === undefined
			? ''
			: `; retires ${key.scheduledRetireAt}`;

	return {
		label: key.kid,
		value: `${key.retired ? 'retired' : 'live'}${retirement}`
	};
}
