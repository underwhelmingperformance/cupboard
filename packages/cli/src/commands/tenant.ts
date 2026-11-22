import type { CliUi } from '@cupboard/cli-ui';
import {
	type CacheAccessMode,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import {
	type TenantCreateBody,
	tenantCreateBodySchema,
	type TenantListResponse,
	type TenantMutateResponse,
	type TenantQuota,
	type TenantQuotaResponse,
	type TenantStatus,
	type TenantSummary
} from '@cupboard/protocol/tenants';
import {
	formatBytes,
	type Reporter,
	type ResultRow,
	shouldShowDebug
} from '@cupboard/reporter';
import { collectProgressively } from '@cupboard/shared/collections';
import { keepAliveFetch } from '@cupboard/shared/keep-alive-fetch';
import { abortableSleep } from '@cupboard/shared/retry';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { parseCacheAccess } from '../cache-access.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { listingLimits, tenantPages } from '../client/listings.ts';
import { type CallOptions, controlRpc } from '../client/orpc.ts';
import { tenantMembershipUnpublishedErrorOf } from '../client/rpc-errors.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import {
	CliUsageError,
	TenantCreateIncompleteError,
	type TenantMembershipUnpublishedError
} from '../errors.ts';
import { deploymentUrlArgument } from '../url-argument.ts';

export interface TenantClient {
	list(
		input?: { readonly cursor?: string; readonly limit?: number },
		options?: CallOptions
	): Promise<TenantListResponse>;
	create(input: TenantCreateBody): Promise<TenantSummary>;
	suspend(input: { id: TenantId }): Promise<TenantMutateResponse>;
	resume(input: { id: TenantId }): Promise<TenantMutateResponse>;
	getQuota(input: { id: TenantId }): Promise<TenantQuotaResponse>;
	setQuota(input: {
		id: TenantId;
		quota: TenantQuota;
	}): Promise<TenantQuotaResponse>;
	remove(input: { id: TenantId }): Promise<TenantMutateResponse>;
}

interface ConfirmableOptions {
	readonly yes?: boolean;
}

interface CreateOptions {
	readonly ownerIssuer: string;
	readonly ownerSubject: string;
	readonly ownerAudience: string;
	readonly access: CacheAccessMode;
	readonly quotaBytes?: number;
}

interface SetQuotaOptions {
	readonly quotaBytes?: number;
}

class QuotaBytesSelectionError extends CliUsageError {
	constructor(readonly selection: 'missing' | 'multiple') {
		super(
			selection === 'missing'
				? 'Pass a quota in bytes as the positional argument or with --quota-bytes.'
				: 'Pass the quota once: use either the positional bytes argument or --quota-bytes.'
		);
		this.name = 'QuotaBytesSelectionError';
	}
}

export class InvalidQuotaBytesError extends CliUsageError {
	constructor(public readonly value: string) {
		super(
			`Invalid quota bytes: ${value}. Pass a non-negative integer in bytes, such as 1048576 (at most ${String(Number.MAX_SAFE_INTEGER)}).`
		);
		this.name = 'InvalidQuotaBytesError';
	}
}

export function parseQuotaBytes(value: string): number {
	if (!/^\d+$/u.test(value)) {
		throw new InvalidQuotaBytesError(value);
	}

	const parsed = Number(value);

	if (!Number.isSafeInteger(parsed)) {
		throw new InvalidQuotaBytesError(value);
	}

	return parsed;
}

export function registerTenantCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const tenant = program
		.command('tenant')
		.description(
			'Create, suspend and remove tenants, and manage their quotas (operator only).'
		);

	tenant
		.command('create')
		.description('Create a tenant.')
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<id>', 'tenant slug')
		.requiredOption(
			'--owner-issuer <issuer>',
			"the OIDC issuer of the owner's identity"
		)
		.requiredOption(
			'--owner-subject <subject>',
			"the OIDC subject of the owner's identity"
		)
		.requiredOption(
			'--owner-audience <audience>',
			"the OIDC audience (client ID) of the owner's identity"
		)
		.requiredOption(
			'--access <mode>',
			"read access for the tenant's default cache: public or private",
			parseCacheAccess
		)
		.option(
			'--quota-bytes <bytes>',
			'storage quota in bytes (unlimited by default); tenant set-quota accepts the same option',
			parseQuotaBytes
		)
		.action(async (url: URL, id: string, options: CreateOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal,
				fetcher: keepAliveFetch
			});
			const body = tenantCreateBodySchema.parse({
				id,
				defaultCacheAccess: options.access,
				ownerIssuer: options.ownerIssuer,
				ownerSubject: options.ownerSubject,
				ownerAudience: options.ownerAudience,
				...(options.quotaBytes !== undefined && {
					quotaBytes: options.quotaBytes
				})
			});

			await runTenantCreate(body, reporter, rpc.tenants, {
				sleep: (ms) => abortableSleep(ms, programOptions.signal)
			});
		});

	tenant
		.command('list')
		.description('List every tenant and its state, including removed tenants.')
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const reporter = commandUi(program, programOptions).reporter();
			await runTenantList(reporter, tenantClient(url, programOptions));
		});

	tenant
		.command('suspend')
		.description(
			'Suspend a tenant. Its reads, pushes, sign-in and maintenance stop immediately.'
		)
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<id>', 'tenant slug')
		.option('-y, --yes', 'suspend without the confirmation prompt')
		.action(async (url: URL, id: string, options: ConfirmableOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			await runTenantSuspend(
				tenantIdSchema.parse(id),
				ui,
				tenantClient(url, programOptions)
			);
		});

	tenant
		.command('resume')
		.description('Resume a suspended tenant.')
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<id>', 'tenant slug')
		.action(async (url: URL, id: string) => {
			const reporter = commandUi(program, programOptions).reporter();
			await runTenantResume(
				tenantIdSchema.parse(id),
				reporter,
				tenantClient(url, programOptions)
			);
		});

	tenant
		.command('quota')
		.description("Show a tenant's storage quota and storage usage.")
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<id>', 'tenant slug')
		.action(async (url: URL, id: string) => {
			const reporter = commandUi(program, programOptions).reporter();
			await runTenantQuota(
				tenantIdSchema.parse(id),
				reporter,
				tenantClient(url, programOptions)
			);
		});

	tenant
		.command('set-quota')
		.description(
			"Set a tenant's storage quota. It can't be less than the tenant already stores."
		)
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<id>', 'tenant slug')
		.argument(
			'[bytes]',
			'storage quota in bytes; alternatively use --quota-bytes',
			parseQuotaBytes
		)
		.option(
			'--quota-bytes <bytes>',
			'storage quota in bytes, as on tenant create; cannot be combined with positional bytes',
			parseQuotaBytes
		)
		.action(
			async (
				url: URL,
				id: string,
				bytes: number | undefined,
				options: SetQuotaOptions
			) => {
				if (bytes !== undefined && options.quotaBytes !== undefined) {
					throw new QuotaBytesSelectionError('multiple');
				}

				const selectedBytes = bytes ?? options.quotaBytes;

				if (selectedBytes === undefined) {
					throw new QuotaBytesSelectionError('missing');
				}

				const reporter = commandUi(program, programOptions).reporter();
				await runTenantSetQuota(
					tenantIdSchema.parse(id),
					{ kind: 'limited', bytes: selectedBytes },
					reporter,
					tenantClient(url, programOptions)
				);
			}
		);

	tenant
		.command('clear-quota')
		.description("Remove a tenant's storage quota, leaving it unlimited.")
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<id>', 'tenant slug')
		.action(async (url: URL, id: string) => {
			const reporter = commandUi(program, programOptions).reporter();
			await runTenantSetQuota(
				tenantIdSchema.parse(id),
				{ kind: 'unlimited' },
				reporter,
				tenantClient(url, programOptions)
			);
		});

	tenant
		.command('remove')
		.alias('delete')
		.description(
			'Remove a tenant. Reads and writes stop immediately, and its data is deleted over the following hours.'
		)
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<id>', 'tenant slug')
		.option('-y, --yes', 'remove without the confirmation prompt')
		.action(async (url: URL, id: string, options: ConfirmableOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			await runTenantRemove(
				tenantIdSchema.parse(id),
				ui,
				tenantClient(url, programOptions)
			);
		});
}

function tenantClient(url: URL, options: ProgramOptions): TenantClient {
	return controlRpc(url, {
		credential: cachedOwnerProvider(url, { signal: options.signal }),
		signal: options.signal
	}).tenants;
}

// The most create requests, and the longest wait between two of them, when the
// deployment creates the tenant but cannot publish its membership.
const maxCreateAttempts = 3;
const maxCreateRetryWaitSeconds = 10;

export interface TenantCreateOptions {
	readonly sleep?: (ms: number) => Promise<void>;
}

/**
Creates the tenant and reports it. When the deployment answers that it created
the tenant but could not publish its membership, the function repeats the
identical request after the delay that the deployment asks for, up to
`maxCreateAttempts` requests. The create is idempotent for an identical
request. When every request gets that answer, or a later request fails in
another way, the function throws `TenantCreateIncompleteError`. Its cause is
the last failure.
*/
export async function runTenantCreate(
	body: TenantCreateBody,
	reporter: Reporter,
	client: Pick<TenantClient, 'create'>,
	options: TenantCreateOptions = {}
): Promise<void> {
	const { sleep = (ms) => abortableSleep(ms) } = options;
	const progress: CreateProgress = { wasUnpublished: false };
	const summary = await reporter.phase('Creating tenant', () =>
		createRepeatingUnpublished(body, client, sleep, progress)
	);

	const rows: ResultRow[] = [
		{ label: 'Tenant', value: summary.id },
		{ label: 'Status', value: tenantStatusLabel(summary.status) },
		{ label: 'Default cache access', value: body.defaultCacheAccess }
	];

	reporter.result({
		kind: 'tenant',
		title: 'Tenant',
		data: summary,
		rows
	});
}

/**
Whether a request of `createRepeatingUnpublished` got the answer that the
deployment created the tenant but could not publish its membership.
*/
interface CreateProgress {
	wasUnpublished: boolean;
}

async function createRepeatingUnpublished(
	body: TenantCreateBody,
	client: Pick<TenantClient, 'create'>,
	sleep: (ms: number) => Promise<void>,
	progress: CreateProgress
): Promise<TenantSummary> {
	let unpublished: TenantMembershipUnpublishedError | undefined;

	for (let attempt = 1; attempt <= maxCreateAttempts; attempt += 1) {
		if (unpublished !== undefined) {
			const seconds = Math.min(
				unpublished.retryAfterSeconds,
				maxCreateRetryWaitSeconds
			);
			await sleep(seconds * 1000);
		}

		try {
			return await client.create(body);
		} catch (error) {
			const answer = tenantMembershipUnpublishedErrorOf(error);

			if (answer === undefined && progress.wasUnpublished) {
				throw new TenantCreateIncompleteError(body.id, attempt, {
					cause: error
				});
			}

			if (answer === undefined) {
				throw error;
			}

			unpublished = answer;
			progress.wasUnpublished = true;
		}
	}

	throw new TenantCreateIncompleteError(body.id, maxCreateAttempts, {
		cause: unpublished
	});
}

export async function runTenantList(
	reporter: Reporter,
	client: Pick<TenantClient, 'list'>
): Promise<void> {
	const tenants = await reporter.phase('Listing tenants', async () =>
		collectProgressively(
			await tenantPages(client),
			listingLimits('The tenant listing')
		)
	);

	reporter.result({
		kind: 'tenants',
		title: 'Tenants',
		data: tenants,
		rows: tenants.map((summary) => tenantRow(summary, reporter)),
		empty: 'No tenants.'
	});
}

export async function runTenantSuspend(
	id: TenantId,
	ui: CliUi,
	client: Pick<TenantClient, 'suspend'>
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Suspend tenant ${id}?`,
		detail: 'New reads and writes stop as soon as the suspension is recorded.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('The tenant was left running.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase('Suspending tenant', () =>
		client.suspend({ id })
	);

	reporter.result({
		kind: 'tenant',
		title: 'Tenant',
		data: result,
		rows: [{ label: result.id, value: tenantStatusLabel(result.status) }]
	});
}

export async function runTenantResume(
	id: TenantId,
	reporter: Reporter,
	client: Pick<TenantClient, 'resume'>
): Promise<void> {
	const result = await reporter.phase('Resuming tenant', () =>
		client.resume({ id })
	);

	reporter.result({
		kind: 'tenant',
		title: 'Tenant',
		data: result,
		rows: [{ label: result.id, value: tenantStatusLabel(result.status) }]
	});
}

/**
Sets or removes a tenant's quota, then prints it alongside how much the
tenant is charged for now. The new quota applies from the next upload.
*/
export async function runTenantSetQuota(
	id: TenantId,
	quota: TenantQuota,
	reporter: Reporter,
	client: Pick<TenantClient, 'setQuota'>
): Promise<void> {
	const phase =
		quota.kind === 'limited' ? 'Setting tenant quota' : 'Clearing tenant quota';
	const result = await reporter.phase(phase, () =>
		client.setQuota({ id, quota })
	);

	reportTenantQuota(reporter, result);
}

export async function runTenantQuota(
	id: TenantId,
	reporter: Reporter,
	client: Pick<TenantClient, 'getQuota'>
): Promise<void> {
	const result = await reporter.phase('Reading tenant quota', () =>
		client.getQuota({ id })
	);

	reportTenantQuota(reporter, result);
}

function reportTenantQuota(
	reporter: Reporter,
	result: TenantQuotaResponse
): void {
	reporter.result({
		kind: 'tenant-quota',
		title: 'Tenant storage quota',
		data: result,
		rows: [
			{ label: 'Tenant', value: result.id },
			{ label: 'Quota', value: quotaLabel(result.quota) },
			{ label: 'Used', value: formatBytes(result.usedBytes) }
		]
	});
}

function quotaLabel(quota: TenantQuota): string {
	return quota.kind === 'limited' ? formatBytes(quota.bytes) : 'unlimited';
}

export async function runTenantRemove(
	id: TenantId,
	ui: CliUi,
	client: Pick<TenantClient, 'remove'>
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Remove tenant ${id}?`,
		detail:
			"New reads and writes stop immediately. The tenant's data is deleted over the following hours. Removal cannot be undone."
	});

	if (outcome !== 'yes') {
		ui.cancelled('The tenant was left in place.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase(
		'Offboarding tenant',
		() => client.remove({ id }),
		{ humanLabel: 'Removing tenant' }
	);

	reporter.result({
		kind: 'tenant',
		title: 'Tenant',
		data: result,
		rows: [{ label: result.id, value: tenantStatusLabel(result.status) }]
	});
}

function tenantRow(summary: TenantSummary, reporter: Reporter): ResultRow {
	return {
		label: summary.id,
		value:
			tenantStatusLabel(summary.status) +
			(shouldShowDebug(reporter)
				? `; config v${String(summary.configVersion)}`
				: '')
	};
}

function tenantStatusLabel(status: TenantStatus): string {
	const labels: Record<TenantStatus, string> = {
		active: 'Active',
		suspended: 'Suspended',
		offboarding: 'Removal in progress',
		offboarded: 'Removed'
	};

	return labels[status];
}
