import { type CliUi, createCliUi } from '@cupboard/cli-ui';
import type {
	KeyListResponse,
	KeyRetireResponse,
	KeyRotateResponse,
	SigningKeyStage,
	SigningKeySummary
} from '@cupboard/protocol/keys';
import { type Reporter, type ResultRow } from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { type ProgramOptions, reporterModeFromGlobals } from '../cli.ts';
import { tenantRpc } from '../client/orpc.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface RetireOptions {
	readonly yes?: boolean;
}

/**
 * The slice of the derived client the key commands consume, in the
 * contract's input and output shapes; the real `tenantRpc(...).keys.signing`
 * satisfies it by construction.
 */
export interface KeyClient {
	list(): Promise<KeyListResponse>;
	rotate(): Promise<KeyRotateResponse>;
	retire(input: { id: string }): Promise<KeyRetireResponse>;
}

export function registerKeyCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const key = program
		.command('key')
		.description("Manage a tenant's narinfo signing keys and rotation.");

	key
		.command('list')
		.description('List the signing key set.')
		.argument('<url>', tenantUrlArgument)
		.action(async (url: string) => {
			const reporter = createCliUi({
				mode: reporterModeFromGlobals(program)
			}).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runKeyList(reporter, rpc.keys.signing);
		});

	key
		.command('rotate')
		.description('Add a new signing key, opening a rotation window.')
		.argument('<url>', tenantUrlArgument)
		.action(async (url: string) => {
			const reporter = createCliUi({
				mode: reporterModeFromGlobals(program)
			}).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runKeyRotate(reporter, rpc.keys.signing);
		});

	key
		.command('retire')
		.description('Retire a signing key one stage at a time.')
		.argument('<url>', tenantUrlArgument)
		.argument('<id>', "key id: a rotated key's UUID, or 'active'")
		.option('-y, --yes', 'retire without the confirmation prompt')
		.action(async (url: string, id: string, options: RetireOptions) => {
			const ui = createCliUi({
				mode: reporterModeFromGlobals(program),
				assumeYes: options.yes
			});
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runKeyRetire(id, ui, rpc.keys.signing);
		});
}

export async function runKeyList(
	reporter: Reporter,
	client: KeyClient
): Promise<void> {
	const { keys } = await reporter.phase('Listing signing keys', () =>
		client.list()
	);

	reporter.result({
		kind: 'keys',
		data: keys,
		rows: keys.map((key) => keyRow(key)),
		empty: 'No signing keys.'
	});
}

export async function runKeyRotate(
	reporter: Reporter,
	client: KeyClient
): Promise<void> {
	const { rotated, keys } = await reporter.phase('Rotating signing key', () =>
		client.rotate()
	);

	reporter.result({
		kind: 'key-rotation',
		data: { rotated, keys },
		rows: [
			{ label: 'New key', value: rotated.id },
			{ label: 'Public key', value: rotated.publicKey },
			{ label: 'Published keys', value: String(keys.length) }
		]
	});
	reporter.info(
		'Add the new public key to trusted-public-keys on every client, then ' +
			'`cupboard key retire <id>` the old key once they have updated.'
	);
}

export async function runKeyRetire(
	id: string,
	ui: CliUi,
	client: KeyClient
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Retire signing key ${id}?`,
		detail:
			'A signing key stops signing; a published key is then removed. ' +
			'Clients still trusting a removed key reject its signatures.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('The key was left in place.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase('Retiring signing key', () =>
		client.retire({ id })
	);

	reporter.result({
		kind: 'key',
		data: result,
		rows: [
			{ label: 'Key', value: result.id },
			{ label: 'Stage', value: describeStage(result.stage) }
		]
	});

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
