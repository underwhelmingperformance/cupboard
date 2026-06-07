import type {
	ControlKeyListResponse,
	ControlKeyRetireResponse,
	ControlKeyRotateResponse,
	ControlKeySummary
} from '@cupboard/protocol/control-keys';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { reporterModeFromGlobals } from '../cli.ts';
import { type AccessCredential, CupboardClient } from '../client/client.ts';
import { createReporter, type Reporter, type ResultRow } from '../reporter.ts';

export interface ControlKeyClient {
	listControlKeys(token: AccessCredential): Promise<ControlKeyListResponse>;
	rotateControlKey(token: AccessCredential): Promise<ControlKeyRotateResponse>;
	retireControlKey(
		token: AccessCredential,
		kid: string
	): Promise<ControlKeyRetireResponse>;
}

const urlArgument =
	'deployment URL (e.g. https://cupboard.example.workers.dev)';

export function registerControlKeyCommands(program: Command): void {
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
			const client = CupboardClient.fromUrl(url);

			await runControlKeyList(cachedOwnerProvider(url), reporter, client);
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
			const client = CupboardClient.fromUrl(url);

			await runControlKeyRotate(cachedOwnerProvider(url), reporter, client);
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
			const client = CupboardClient.fromUrl(url);

			await runControlKeyRetire(
				kid,
				cachedOwnerProvider(url),
				reporter,
				client
			);
		});
}

export async function runControlKeyList(
	token: AccessCredential,
	reporter: Reporter,
	client: ControlKeyClient
): Promise<void> {
	const { keys } = await reporter.phase('Listing control keys', () =>
		client.listControlKeys(token)
	);

	reporter.result(keys.map((key) => controlKeyRow(key)));
}

export async function runControlKeyRotate(
	token: AccessCredential,
	reporter: Reporter,
	client: ControlKeyClient
): Promise<void> {
	const { kid, retiring } = await reporter.phase('Rotating control key', () =>
		client.rotateControlKey(token)
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
	token: AccessCredential,
	reporter: Reporter,
	client: ControlKeyClient
): Promise<void> {
	const result = await reporter.phase('Retiring control key', () =>
		client.retireControlKey(token, kid)
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
