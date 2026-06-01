import type {
	AuthKeyListResponse,
	AuthKeyRetireResponse,
	AuthKeyRotateResponse,
	AuthKeySummary
} from '@cupboard/shared';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth.ts';
import { reporterModeFromGlobals } from '../cli.ts';
import { type AccessCredential, CupboardClient } from '../client.ts';
import { createReporter, type Reporter, type ResultRow } from '../reporter.ts';

export interface AuthKeyClient {
	listAuthKeys(token: AccessCredential): Promise<AuthKeyListResponse>;
	rotateAuthKey(token: AccessCredential): Promise<AuthKeyRotateResponse>;
	retireAuthKey(
		token: AccessCredential,
		kid: string
	): Promise<AuthKeyRetireResponse>;
}

export function registerAuthKeyCommands(program: Command): void {
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
			const client = CupboardClient.fromUrl(url);

			await runAuthKeyList(cachedOwnerProvider(), reporter, client);
		});

	authKey
		.command('rotate')
		.description('Add a new active auth key, retiring nothing.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.action(async (url: string) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);

			await runAuthKeyRotate(cachedOwnerProvider(), reporter, client);
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
			const client = CupboardClient.fromUrl(url);

			await runAuthKeyRetire(kid, cachedOwnerProvider(), reporter, client);
		});
}

export async function runAuthKeyList(
	token: AccessCredential,
	reporter: Reporter,
	client: AuthKeyClient
): Promise<void> {
	const { keys } = await reporter.phase('Listing auth keys', () =>
		client.listAuthKeys(token)
	);

	reporter.result(keys.map((key) => authKeyRow(key)));
}

export async function runAuthKeyRotate(
	token: AccessCredential,
	reporter: Reporter,
	client: AuthKeyClient
): Promise<void> {
	const { rotated, keys } = await reporter.phase('Rotating auth key', () =>
		client.rotateAuthKey(token)
	);

	reporter.result([
		{ label: 'New key', value: rotated },
		{ label: 'Keys in set', value: String(keys.length) }
	]);
	reporter.info(
		'New tokens are signed with this key; existing tokens still verify until ' +
			'you `cupboard auth-key retire <kid>` the previous key.'
	);
}

export async function runAuthKeyRetire(
	kid: string,
	token: AccessCredential,
	reporter: Reporter,
	client: AuthKeyClient
): Promise<void> {
	const result = await reporter.phase('Retiring auth key', () =>
		client.retireAuthKey(token, kid)
	);

	reporter.result([
		{ label: 'Key', value: result.kid },
		{ label: 'Retired', value: result.retired ? 'yes' : 'not present' }
	]);
}

function authKeyRow(key: AuthKeySummary): ResultRow {
	return {
		label: key.kid,
		value: `${key.active ? 'active' : 'retained'}; created ${key.createdAt}`
	};
}
