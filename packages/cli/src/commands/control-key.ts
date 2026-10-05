import type { CliUi } from '@cupboard/cli-ui';
import { type AuthKeyId, authKeyIdSchema } from '@cupboard/nix-store/scalars';
import type {
	ControlKeyListResponse,
	ControlKeyRetireResponse,
	ControlKeyRotateResponse,
	ControlKeySummaryInput
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
	list(): Promise<ControlKeyListResponse>;
	rotate(): Promise<ControlKeyRotateResponse>;
	retire(input: { kid: AuthKeyId }): Promise<ControlKeyRetireResponse>;
}

export function registerControlKeyCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const controlKey = program
		.command('control-key')
		.description(
			'Manage and rotate the keys that sign operator access tokens (operator only).'
		);

	controlKey
		.command('list')
		.description(
			"List the deployment's operator access-token keys and scheduled retirements."
		)
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
			'Add a new operator access-token key, and retire the old one after its tokens expire.'
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
			'Retire an old operator access-token key now. Tokens that it signed stop working immediately.'
		)
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<kid>', 'operator access-token key ID')
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
	const { keys } = await reporter.phase(
		'Listing control keys',
		() => client.list(),
		{ humanLabel: 'Listing operator access-token keys' }
	);

	reporter.result({
		kind: 'control-keys',
		title: 'Operator access-token keys',
		data: keys,
		rows: keys.map((key) => controlKeyRow(key)),
		empty: 'No operator access-token keys.'
	});
}

export async function runControlKeyRotate(
	reporter: Reporter,
	client: Pick<ControlKeyClient, 'rotate'>
): Promise<void> {
	const { kid, retiring } = await reporter.phase(
		'Rotating control key',
		() => client.rotate(),
		{ humanLabel: 'Rotating operator access-token key' }
	);

	reporter.result({
		kind: 'control-key-rotation',
		title: 'Operator access-token key rotation',
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
	reporter.info('New control tokens are signed with this key.', {
		humanMessage: 'New operator access tokens are signed with this key.'
	});
}

export async function runControlKeyRetire(
	kid: AuthKeyId,
	ui: CliUi,
	client: ControlKeyClient
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Retire operator access-token key ${kid}?`,
		detail:
			'Existing operator access tokens signed with this key stop working immediately.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('The key was left in place.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase(
		'Retiring control key',
		() => client.retire({ kid }),
		{ humanLabel: 'Retiring operator access-token key' }
	);

	reporter.result({
		kind: 'control-key',
		title: 'Operator access-token key',
		data: result,
		rows: [
			{ label: 'Key', value: result.kid },
			{ label: 'Retired', value: result.retired ? 'yes' : 'not present' }
		]
	});
}

function controlKeyRow(key: ControlKeySummaryInput): ResultRow {
	const retirement =
		key.scheduledRetireAt === undefined
			? ''
			: `; retires ${formatTimestamp(key.scheduledRetireAt)}`;

	return {
		label: key.kid,
		value: `${key.retired ? 'retired' : 'live'}${retirement}`
	};
}
