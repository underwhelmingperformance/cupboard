import type { CliUi } from '@cupboard/cli-ui';
import type {
	ParsedBackfillStatus,
	ParsedKeyAbortResponse,
	ParsedKeyListResponse,
	ParsedKeyRetireResponse,
	ParsedKeyRotateResponse,
	ParsedSigningKeyEntry
} from '@cupboard/protocol/keys';
import { type Reporter, type ResultRow } from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { SigningKeyNotFoundError } from '../errors.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface RetireOptions {
	readonly yes?: boolean;
}

export interface KeyClient {
	list(): Promise<ParsedKeyListResponse>;
	rotate(): Promise<ParsedKeyRotateResponse>;
	retire(input: { id: string }): Promise<ParsedKeyRetireResponse>;
	abort(input: { id: string }): Promise<ParsedKeyAbortResponse>;
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
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runKeyList(reporter, rpc.keys.signing);
		});

	key
		.command('rotate')
		.description('Add a new signing key, opening a rotation window.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runKeyRotate(reporter, rpc.keys.signing);
		});

	key
		.command('abort')
		.description('Abort an incomplete signing-key rotation.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<id>', 'id of the incomplete incoming key')
		.option('-y, --yes', 'abort without the confirmation prompt')
		.action(async (url: URL, id: string, options: RetireOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runKeyAbort(id, ui, rpc.keys.signing);
		});

	key
		.command('status')
		.description('Show signing-key and backfill status.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[id]', 'signing key id')
		.action(async (url: URL, id?: string) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runKeyStatus(reporter, rpc.keys.signing, id);
		});

	key
		.command('retire')
		.description('Retire a signing key one stage at a time.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<id>', "key id: a rotated key's UUID, or 'active'")
		.option('-y, --yes', 'retire without the confirmation prompt')
		.action(async (url: URL, id: string, options: RetireOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runKeyRetire(id, ui, rpc.keys.signing);
		});
}

export async function runKeyList(
	reporter: Reporter,
	client: Pick<KeyClient, 'list'>
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
	client: Pick<KeyClient, 'rotate'>
): Promise<void> {
	const { rotated, keys } = await reporter.phase('Rotating signing key', () =>
		client.rotate()
	);

	reporter.result({
		kind: 'key-rotation',
		data: { rotated, keys },
		rows: [
			{ label: 'New key', value: rotated.key.id },
			{ label: 'Public key', value: rotated.key.publicKey },
			{ label: 'Published keys', value: String(keys.length) }
		]
	});
	reporter.info(
		"Add the new public key to every client's `trusted-public-keys` now. " +
			'The server is re-signing existing narinfos in the background. Use ' +
			'`cupboard key status` to wait for completion before retiring the old ' +
			'key once to stop it signing.'
	);
}

export async function runKeyStatus(
	reporter: Reporter,
	client: Pick<KeyClient, 'list'>,
	id?: string
): Promise<void> {
	const { keys } = await reporter.phase('Reading signing-key status', () =>
		client.list()
	);
	const selected =
		id === undefined ? keys : keys.filter((entry) => entry.key.id === id);

	if (id !== undefined && selected.length === 0) {
		throw new SigningKeyNotFoundError(id);
	}

	reporter.result({
		kind: 'key-status',
		data: selected,
		rows: selected.map((entry) => keyStatusRow(entry)),
		empty: 'No signing keys.'
	});
}

export async function runKeyRetire(
	id: string,
	ui: CliUi,
	client: KeyClient
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Retire signing key ${id}?`,
		detail:
			'The first retirement stops the key signing. A client that trusts only ' +
			'this key will then reject newly committed narinfos. The second ' +
			"retirement removes the key from /pubkey. Keep the key in each client's " +
			'`trusted-public-keys` until its positive narinfo cache has expired.'
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
			{ label: 'State', value: describeState(result.state) }
		]
	});

	if (result.state === 'published-only') {
		reporter.info(
			'The key no longer signs but stays published. Nix caches narinfos and ' +
				'their signatures for `narinfo-cache-positive-ttl`, which defaults to 30 ' +
				"days. Keep this key in each client's `trusted-public-keys` until that " +
				"client's cache window has elapsed, or clear its narinfo cache. Retiring " +
				'the key again removes it from /pubkey but does not change client trust.'
		);
	}
}

export async function runKeyAbort(
	id: string,
	ui: CliUi,
	client: Pick<KeyClient, 'abort'>
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Abort signing-key rotation ${id}?`,
		detail:
			'The incomplete incoming key will be unpublished and its background ' +
			'work will be discarded. The previous signing key remains active.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('The rotation was left in place.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase('Aborting signing-key rotation', () =>
		client.abort({ id })
	);

	reporter.result({
		kind: 'key',
		data: result,
		rows: [
			{ label: 'Key', value: result.id },
			{ label: 'State', value: describeState(result.state) }
		]
	});
}

function keyRow(entry: ParsedSigningKeyEntry): ResultRow {
	return {
		label: entry.key.id,
		value: `${describeState(entry.state)}; ${entry.key.publicKey}`
	};
}

function keyStatusRow(entry: ParsedSigningKeyEntry): ResultRow {
	const backfill = entry.state === 'signing' ? entry.backfill : undefined;

	return {
		label: entry.key.id,
		value: [
			describeState(entry.state),
			entry.key.publicKey,
			...(backfill === undefined ? [] : [describeBackfill(backfill)])
		].join('; ')
	};
}

function describeBackfill(status: ParsedBackfillStatus): string {
	if (status.state === 'complete') {
		return `backfill complete (${String(status.resigned)} re-signed)`;
	}

	const progress = `${String(status.resigned)} re-signed, ${String(status.remaining)} remaining`;

	if (status.state === 'retrying') {
		return `backfill retrying ${status.failure.operation} (${progress}): ${status.failure.message}`;
	}

	return `backfill running (${progress})`;
}

export function describeState(
	state: ParsedSigningKeyEntry['state'] | ParsedKeyRetireResponse['state']
): string {
	if (state === 'signing') {
		return 'signing and published';
	}

	if (state === 'published-only') {
		return 'published only';
	}

	return 'removed';
}
