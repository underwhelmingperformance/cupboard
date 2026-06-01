import type {
	KeyListResponse,
	KeyRetireResponse,
	KeyRotateResponse,
	SigningKeyStage,
	SigningKeySummary
} from '@cupboard/shared';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth.ts';
import { reporterModeFromGlobals } from '../cli.ts';
import { type AccessCredential, CupboardClient } from '../client.ts';
import { createReporter, type Reporter, type ResultRow } from '../reporter.ts';

export interface KeyClient {
	listKeys(token: AccessCredential): Promise<KeyListResponse>;
	rotateKey(token: AccessCredential): Promise<KeyRotateResponse>;
	retireKey(token: AccessCredential, id: string): Promise<KeyRetireResponse>;
}

export function registerKeyCommands(program: Command): void {
	const key = program
		.command('key')
		.description('Manage the deployment signing keys and rotation.');

	key
		.command('list')
		.description('List the signing key set.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.action(async (url: string) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);
			const token = cachedOwnerProvider();

			await runKeyList(token, reporter, client);
		});

	key
		.command('rotate')
		.description('Add a new signing key, opening a rotation window.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.action(async (url: string) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);
			const token = cachedOwnerProvider();

			await runKeyRotate(token, reporter, client);
		});

	key
		.command('retire')
		.description('Retire a signing key one stage at a time.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.argument('<id>', "key id: a rotated key's UUID, or 'active'")
		.action(async (url: string, id: string) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);
			const token = cachedOwnerProvider();

			await runKeyRetire(id, token, reporter, client);
		});
}

export async function runKeyList(
	token: AccessCredential,
	reporter: Reporter,
	client: KeyClient
): Promise<void> {
	const { keys } = await reporter.phase('Listing signing keys', () =>
		client.listKeys(token)
	);

	if (keys.length === 0) {
		reporter.info('No signing keys.');
		return;
	}

	reporter.result(keys.map((key) => keyRow(key)));
}

export async function runKeyRotate(
	token: AccessCredential,
	reporter: Reporter,
	client: KeyClient
): Promise<void> {
	const { rotated, keys } = await reporter.phase('Rotating signing key', () =>
		client.rotateKey(token)
	);

	reporter.result([
		{ label: 'New key', value: rotated.id },
		{ label: 'Public key', value: rotated.publicKey },
		{ label: 'Published keys', value: String(keys.length) }
	]);
	reporter.info(
		'Add the new public key to trusted-public-keys on every client, then ' +
			'`cupboard key retire <id>` the old key once they have updated.'
	);
}

export async function runKeyRetire(
	id: string,
	token: AccessCredential,
	reporter: Reporter,
	client: KeyClient
): Promise<void> {
	const result = await reporter.phase('Retiring signing key', () =>
		client.retireKey(token, id)
	);

	reporter.result([
		{ label: 'Key', value: result.id },
		{ label: 'Stage', value: describeStage(result.stage) }
	]);

	if (result.stage === 'publication') {
		reporter.info(
			'The key no longer signs but stays published. Retire it again once no ' +
				'client trusts it to remove it entirely.'
		);
	}
}

function keyRow(key: SigningKeySummary): ResultRow {
	return {
		label: key.id,
		value: `${describeStage(key.stage)}; ${key.publicKey}`
	};
}

export function describeStage(stage: SigningKeyStage): string {
	if (stage === 'signing') {
		return 'signing and published';
	}

	if (stage === 'publication') {
		return 'published only';
	}

	return 'removed';
}
