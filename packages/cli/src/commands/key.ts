import type { CliUi } from '@cupboard/cli-ui';
import {
	backfillEntryDefectRecord,
	backfillEntryDefectText,
	type BackfillStatus,
	type KeyAbortResponse,
	type KeyListResponse,
	type KeyRetireResponse,
	type KeyRotateResponse,
	type SigningKeyEntry,
	type UnpublishableStorePaths
} from '@cupboard/protocol/keys';
import {
	type Reporter,
	type ResultRow,
	shouldShowDebug
} from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { cacheLabel } from '../client/client.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { SigningKeyNotFoundError } from '../errors.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface RetireOptions {
	readonly yes?: boolean;
}

export interface KeyClient {
	list(): Promise<KeyListResponse>;
	rotate(): Promise<KeyRotateResponse>;
	retire(input: { id: string }): Promise<KeyRetireResponse>;
	abort(input: { id: string }): Promise<KeyAbortResponse>;
}

export function registerKeyCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const key = program
		.command('key')
		.description(
			"Manage and rotate the keys that sign the tenant's Nix cache metadata."
		);

	key
		.command('list')
		.description("List the tenant's signing keys and their states.")
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
		.description(
			'Start a signing key rotation: add a new key and update signatures for existing store paths.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runKeyRotate(reporter, rpc.keys.signing, url);
		});

	key
		.command('abort')
		.description(
			'Abandon a signing key rotation before its re-signing has finished, and remove the incoming key.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<id>', 'ID of the incoming key')
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
		.description(
			'Show signing keys and progress while signatures are updated for existing store paths.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[id]', 'show only the signing key with this ID')
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
		.description(
			'Retire a signing key. Run it once to stop signing with the key, and again to stop publishing it at /pubkey.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument(
			'<id>',
			"key ID: 'active' for the tenant's first key, or a later key's UUID"
		)
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
		title: 'Signing keys',
		data: keys,
		rows: keys.map((key) => keyRow(key)),
		empty: 'No signing keys.'
	});
}

export async function runKeyRotate(
	reporter: Reporter,
	client: Pick<KeyClient, 'rotate'>,
	tenantUrl?: URL
): Promise<void> {
	const { rotated, keys } = await reporter.phase('Rotating signing key', () =>
		client.rotate()
	);

	reporter.result({
		kind: 'key-rotation',
		title: 'Signing-key rotation',
		data: { rotated, keys },
		rows: [
			{ label: 'New key', value: rotated.key.id },
			{ label: 'Public key', raw: true, value: rotated.key.publicKey },
			{ label: 'Published keys', value: String(keys.length) }
		]
	});
	reporter.info(
		"Add the new public key to every client's `trusted-public-keys` now. " +
			'The server is re-signing existing narinfos in the background. Use ' +
			'`cupboard key status` to wait for completion before retiring the old ' +
			'key once to stop it signing.',
		{
			humanMessage:
				"Add the new public key to every client's `trusted-public-keys` now. " +
				'The server is updating signatures on existing store paths. Check ' +
				`\`cupboard key status ${tenantUrl?.href ?? '<tenant-url>'}\` before retiring the old key once to stop it signing.`
		}
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
		title: 'Signing-key status',
		data: selected,
		rows: selected.flatMap((entry) => keyStatusRows(entry, reporter)),
		empty: 'No signing keys.'
	});

	const notUpdated = selected.flatMap((entry) =>
		entry.state === 'signing'
			? (entry.backfill?.unpublishable?.storePaths ?? [])
			: []
	);

	if (notUpdated.length === 0) {
		return;
	}

	// The outgoing key can be retired only once the signature update has
	// finished, and only while it still signs beside the incoming key.
	const signingKeys = keys.filter((entry) => entry.state === 'signing');
	const isUpdateRunning = selected.some(
		(entry) =>
			entry.state === 'signing' &&
			entry.backfill !== undefined &&
			entry.backfill.state !== 'complete'
	);
	reporter.info(
		notUpdatedAdvice(notUpdated, signingKeys.length > 1 && !isUpdateRunning)
	);
}

// What the operator can do about the listed store paths. `canRetire` is true
// when the outgoing key can be retired now.
function notUpdatedAdvice(
	storePaths: readonly UnpublishableStorePaths['storePaths'][number][],
	canRetire: boolean
): string {
	const records = new Set(
		storePaths.map((path) => backfillEntryDefectRecord[path.defect])
	);

	return [
		'The signature update skipped the store paths listed as not updated, because their stored metadata is invalid or incomplete.',
		'They keep only the signatures that they had before the rotation, so Nix ignores them once a client stops trusting the keys that made those signatures.',
		...(records.has('narinfo')
			? [
					'To fix a path whose narinfo record is invalid, delete it with `cupboard delete` and push it again. The new upload is signed by every signing key.'
				]
			: []),
		...(records.has('either')
			? [
					'Deleting and pushing again also fixes a path with an unattributed defect, but only if the defect is in its narinfo record.'
				]
			: []),
		...(records.has('blob')
			? [
					"An invalid URL, compression, file hash or file size is stored in the deployment's shared record of the NAR, which a new push reuses, so no cupboard command fixes it."
				]
			: []),
		...(records.has('cache')
			? [
					'A path whose cache is missing from the cache registry cannot be deleted or pushed again, so no cupboard command fixes it.'
				]
			: []),
		...(records.has('missingBlob')
			? [
					'A path whose NAR record is missing from the deployment cannot be substituted from the cache with any key.'
				]
			: []),
		...(canRetire
			? [
					'You can retire the outgoing key without fixing them. `cupboard key retire` counts the paths that the key signed, because clients need a key that signed a path for as long as they should accept that path.'
				]
			: [])
	].join(' ');
}

export async function runKeyRetire(
	id: string,
	ui: CliUi,
	client: KeyClient
): Promise<void> {
	const reporter = ui.reporter();
	const { keys } = await reporter.phase('Reading signing keys', () =>
		client.list()
	);
	const notUpdated =
		keys.find((entry) => entry.key.id === id)?.unpublishableSigned ?? 0;
	const notUpdatedWarning =
		notUpdated === 0
			? ''
			: ` A signature update skipped ${storePathCount(notUpdated)} that this key signed, ` +
				`so ${notUpdated === 1 ? 'that path keeps' : 'those paths keep'} only the signatures from before that update. ` +
				`Clients need this key, or another key that signed ${notUpdated === 1 ? 'it' : 'them'}, in \`trusted-public-keys\` for as long as they should accept ` +
				`${notUpdated === 1 ? 'that path' : 'those paths'}, not only until their narinfo cache expires. ` +
				'`cupboard key status` lists the skipped paths.';
	const outcome = await ui.confirm({
		message: `Retire signing key ${id}?`,
		detail:
			'The first retirement stops the key signing. A client that trusts only ' +
			'this key will then reject newly published store paths. The second ' +
			"retirement removes the key from /pubkey. Keep the key in each client's " +
			'`trusted-public-keys` until its positive narinfo cache has expired.' +
			notUpdatedWarning
	});

	if (outcome !== 'yes') {
		ui.cancelled('The key was left in place.');
		return;
	}

	const result = await reporter.phase('Retiring signing key', () =>
		client.retire({ id })
	);

	reporter.result({
		kind: 'key',
		title: 'Signing key',
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
				'the key again removes it from /pubkey but does not change client trust.' +
				notUpdatedWarning
		);
	}
}

function storePathCount(count: number): string {
	return count === 1 ? '1 store path' : `${String(count)} store paths`;
}

export async function runKeyAbort(
	id: string,
	ui: CliUi,
	client: Pick<KeyClient, 'abort'>
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Abort signing-key rotation ${id}?`,
		detail:
			'The new key will be removed and its signature updates will stop. The previous signing key remains active.'
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
		title: 'Signing key',
		data: result,
		rows: [
			{ label: 'Key', value: result.id },
			{ label: 'State', value: describeState(result.state) }
		]
	});
}

function keyRow(entry: SigningKeyEntry): ResultRow {
	return {
		label: entry.key.id,
		raw: true,
		value: `${describeState(entry.state)}; ${entry.key.publicKey}`
	};
}

function keyStatusRows(
	entry: SigningKeyEntry,
	reporter: Reporter
): ResultRow[] {
	const backfill = entry.state === 'signing' ? entry.backfill : undefined;

	return [
		{ label: 'Key', value: entry.key.id },
		{ label: 'State', value: describeState(entry.state) },
		{ label: 'Public key', raw: true, value: entry.key.publicKey },
		...(backfill === undefined ? [] : signatureUpdateRows(backfill, reporter))
	];
}

function signatureUpdateRows(
	status: BackfillStatus,
	reporter: Reporter
): ResultRow[] {
	return [
		{
			label: 'Signature update',
			value:
				status.state === 'complete'
					? 'Signature update complete'
					: status.state === 'retrying'
						? 'Retrying signature updates'
						: 'Updating signatures'
		},
		{ label: 'Store paths updated', value: String(status.resigned) },
		...(status.state === 'complete'
			? []
			: [{ label: 'Remaining', value: String(status.remaining) }]),
		...(status.unpublishable === undefined
			? []
			: notUpdatedRows(status.unpublishable)),
		...(status.state === 'retrying' && shouldShowDebug(reporter)
			? [
					{ label: 'Failed operation', value: status.failure.operation },
					{ label: 'Server error', value: status.failure.message }
				]
			: [])
	];
}

function notUpdatedRows(unpublishable: UnpublishableStorePaths): ResultRow[] {
	const unlisted = unpublishable.total - unpublishable.storePaths.length;

	return [
		{ label: 'Store paths not updated', value: String(unpublishable.total) },
		...unpublishable.storePaths.map((path) => ({
			label: 'Not updated',
			raw: true,
			value: `${path.storePath} in ${
				path.cache === undefined
					? 'a cache missing from the registry'
					: cacheLabel(path.cache)
			}: ${backfillEntryDefectText[path.defect]}`
		})),
		...(unlisted > 0
			? [
					{
						label: 'Not updated',
						value:
							unlisted === 1
								? '1 more store path, not listed'
								: `${String(unlisted)} more store paths, not listed`
					}
				]
			: [])
	];
}

export function describeState(
	state: SigningKeyEntry['state'] | KeyRetireResponse['state']
): string {
	if (state === 'signing') {
		return 'signing and published';
	}

	if (state === 'published-only') {
		return 'published only';
	}

	return 'removed';
}
