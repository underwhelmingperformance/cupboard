import { randomBytes } from 'node:crypto';

import type { CliUi } from '@cupboard/cli-ui';
import {
	type CacheName,
	cacheNameSchema,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import {
	defaultReadUser,
	type ParsedCacheReadCredentialResponse,
	type ParsedTenantListResponse,
	type ParsedTenantMutateResponse,
	type ParsedTenantReadModeResponse,
	type ParsedTenantSummary,
	readPasswordByteLength,
	type TenantCreateBody,
	tenantCreateBodySchema,
	tenantReadModeSchema,
	type TenantSummary
} from '@cupboard/protocol/tenants';
import { type Reporter, type ResultRow } from '@cupboard/reporter';
import type { ReadUser } from '@cupboard/shared/http';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { controlRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { parseReadUser } from '../read-user.ts';
import { deploymentUrlArgument } from '../url-argument.ts';

export interface TenantClient {
	list(): Promise<ParsedTenantListResponse>;
	create(input: TenantCreateBody): Promise<ParsedTenantSummary>;
	suspend(input: { id: TenantId }): Promise<ParsedTenantMutateResponse>;
	resume(input: { id: TenantId }): Promise<ParsedTenantMutateResponse>;
	setReadMode(input: {
		id: TenantId;
		readMode: 'public' | 'private';
	}): Promise<ParsedTenantReadModeResponse>;
	rotateReadCredential(input: {
		id: TenantId;
		read: { user: ReadUser; password: string };
	}): Promise<ParsedTenantReadModeResponse>;
	clearReadCredential(input: {
		id: TenantId;
	}): Promise<ParsedTenantReadModeResponse>;
	rotateCacheReadCredential(input: {
		id: TenantId;
		cacheName: CacheName;
		read: { user: ReadUser; password: string };
	}): Promise<ParsedCacheReadCredentialResponse>;
	clearCacheReadCredential(input: {
		id: TenantId;
		cacheName: CacheName;
	}): Promise<ParsedCacheReadCredentialResponse>;
	remove(input: { id: TenantId }): Promise<ParsedTenantMutateResponse>;
}

interface RotateCredentialOptions {
	readonly readUser?: ReadUser;
}

interface ConfirmableOptions {
	readonly yes?: boolean;
}

interface CreateOptions {
	readonly ownerIssuer: string;
	readonly ownerSubject: string;
	readonly ownerAudience: string;
	readonly public?: boolean;
	readonly readUser?: ReadUser;
	readonly readPassword?: boolean;
	readonly quotaBytes?: number;
}

export class ReadUserWithoutCredentialError extends Error {
	constructor(public readonly readUser: string) {
		super('--read-user cannot be combined with --no-read-password');
		this.name = 'ReadUserWithoutCredentialError';
	}
}

export class InvalidQuotaBytesError extends Error {
	constructor(public readonly value: string) {
		super(`Invalid quota bytes: ${value}`);
		this.name = 'InvalidQuotaBytesError';
	}
}

export function parseQuotaBytes(value: string): number {
	if (!/^\d+$/.test(value)) {
		throw new InvalidQuotaBytesError(value);
	}

	const parsed = Number(value);

	if (!Number.isSafeInteger(parsed)) {
		throw new InvalidQuotaBytesError(value);
	}

	return parsed;
}

interface ReadCredentialSelection {
	readonly read:
		undefined | { readonly user: ReadUser; readonly password: string };
	readonly generatedPassword: string | undefined;
}

/**
 * Creates a read password. The control plane stores a salted digest of it, so
 * the strength of the credential is these 32 random bytes and no command
 * accepts a password from the caller.
 */
export function generateReadPassword(): string {
	return randomBytes(readPasswordByteLength).toString('base64url');
}

function readUserOrDefault(supplied: ReadUser | undefined): ReadUser {
	return supplied ?? defaultReadUser;
}

/**
 * Returns no credential for a public tenant or when `--no-read-password` is
 * set. Otherwise it generates one.
 */
export function readCredentialFromOptions(options: {
	readonly public?: boolean;
	readonly readUser?: ReadUser;
	readonly readPassword?: boolean;
}): ReadCredentialSelection {
	if (options.readPassword === false) {
		if (options.readUser !== undefined) {
			throw new ReadUserWithoutCredentialError(options.readUser);
		}

		return { read: undefined, generatedPassword: undefined };
	}

	if (options.public === true) {
		return { read: undefined, generatedPassword: undefined };
	}

	const password = generateReadPassword();

	return {
		read: { user: readUserOrDefault(options.readUser), password },
		generatedPassword: password
	};
}

export function registerTenantCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const tenant = program
		.command('tenant')
		.description('Provision and manage tenants (operator only).');

	tenant
		.command('create')
		.description('Provision a new tenant.')
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<id>', 'tenant slug')
		.requiredOption('--owner-issuer <issuer>', 'the owner OIDC issuer')
		.requiredOption('--owner-subject <subject>', 'the owner OIDC subject')
		.requiredOption(
			'--owner-audience <audience>',
			'the owner OIDC audience (client id)'
		)
		.option('--public', 'make the cache publicly readable (private by default)')
		.option(
			'--read-user <user>',
			'the Basic-auth user a private cache requires from readers',
			parseReadUser
		)
		.option(
			'--no-read-password',
			'do not create a read credential; private reads then fail closed'
		)
		.option(
			'--quota-bytes <bytes>',
			'the storage quota in bytes (unlimited by default)',
			parseQuotaBytes
		)
		.addHelpText(
			'after',
			[
				'',
				'Example:',
				'  # The owner triple is the OIDC identity that may administer the',
				'  # tenant: the same one it presents to `cupboard login`.',
				'  cupboard tenant create https://cupboard.example.workers.dev acme \\',
				'    --owner-issuer <issuer> --owner-subject <subject> \\',
				'    --owner-audience <audience>'
			].join('\n')
		)
		.action(async (url: URL, id: string, options: CreateOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});
			const readSelection = readCredentialFromOptions(options);
			const body = tenantCreateBodySchema.parse({
				id,
				readMode: options.public === true ? 'public' : 'private',
				ownerIssuer: options.ownerIssuer,
				ownerSubject: options.ownerSubject,
				ownerAudience: options.ownerAudience,
				...(readSelection.read !== undefined && { read: readSelection.read }),
				...(options.quotaBytes !== undefined && {
					quotaBytes: options.quotaBytes
				})
			});

			await runTenantCreate(
				body,
				reporter,
				rpc.tenants,
				readSelection.generatedPassword
			);
		});

	tenant
		.command('list')
		.description('List provisioned tenants.')
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runTenantList(reporter, rpc.tenants);
		});

	tenant
		.command('suspend')
		.description('Suspend a tenant: new reads and writes stop immediately.')
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<id>', 'tenant slug')
		.option('-y, --yes', 'suspend without the confirmation prompt')
		.action(async (url: URL, id: string, options: ConfirmableOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runTenantSuspend(tenantIdSchema.parse(id), ui, rpc.tenants);
		});

	tenant
		.command('resume')
		.description(
			'Resume a suspended tenant: reads and writes are allowed again.'
		)
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<id>', 'tenant slug')
		.action(async (url: URL, id: string) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runTenantResume(tenantIdSchema.parse(id), reporter, rpc.tenants);
		});

	tenant
		.command('read-mode')
		.description("Set a tenant's read mode.")
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<id>', 'tenant slug')
		.argument('<mode>', 'public or private')
		.action(async (url: URL, id: string, mode: string) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runTenantReadMode(
				tenantIdSchema.parse(id),
				tenantReadModeSchema.parse(mode),
				reporter,
				rpc.tenants
			);
		});

	tenant
		.command('rotate-credential')
		.description(
			"Set the tenant's read credential to a newly generated password."
		)
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<id>', 'tenant slug')
		.option(
			'--read-user <user>',
			'the Basic-auth user required for tenant reads',
			parseReadUser
		)
		.action(async (url: URL, id: string, options: RotateCredentialOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, {
					signal: programOptions.signal
				}),
				signal: programOptions.signal
			});

			await runTenantRotateCredential(
				tenantIdSchema.parse(id),
				options,
				reporter,
				rpc.tenants
			);
		});

	tenant
		.command('clear-credential')
		.description(
			"Clear a tenant's read credential; a private cache then fails closed."
		)
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<id>', 'tenant slug')
		.action(async (url: URL, id: string) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runTenantClearCredential(
				tenantIdSchema.parse(id),
				reporter,
				rpc.tenants
			);
		});

	tenant
		.command('rotate-cache-credential')
		.description(
			"Set one private cache's own read credential to a newly generated password."
		)
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<id>', 'tenant slug')
		.argument('<cache>', 'private cache name')
		.option(
			'--read-user <user>',
			'the Basic-auth user this cache requires from readers',
			parseReadUser
		)
		.action(
			async (
				url: URL,
				id: string,
				cache: string,
				options: RotateCredentialOptions
			) => {
				const reporter = commandUi(program, programOptions).reporter();
				const rpc = controlRpc(url, {
					credential: cachedOwnerProvider(url, {
						signal: programOptions.signal
					}),
					signal: programOptions.signal
				});

				await runTenantRotateCacheCredential(
					tenantIdSchema.parse(id),
					cacheNameSchema.parse(cache),
					options,
					reporter,
					rpc.tenants
				);
			}
		);

	tenant
		.command('clear-cache-credential')
		.description(
			"Clear one private cache's own read credential; readers then use the tenant credential."
		)
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<id>', 'tenant slug')
		.argument('<cache>', 'private cache name')
		.action(async (url: URL, id: string, cache: string) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runTenantClearCacheCredential(
				tenantIdSchema.parse(id),
				cacheNameSchema.parse(cache),
				reporter,
				rpc.tenants
			);
		});

	tenant
		.command('remove')
		.alias('delete')
		.description('Begin offboarding a tenant.')
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<id>', 'tenant slug')
		.option('-y, --yes', 'offboard without the confirmation prompt')
		.action(async (url: URL, id: string, options: ConfirmableOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runTenantRemove(tenantIdSchema.parse(id), ui, rpc.tenants);
		});
}

export async function runTenantCreate(
	body: TenantCreateBody,
	reporter: Reporter,
	client: Pick<TenantClient, 'create'>,
	generatedReadPassword?: string
): Promise<void> {
	const summary = await reporter.phase('Creating tenant', () =>
		client.create(body)
	);

	const rows: ResultRow[] = [
		{ label: 'Tenant', value: summary.id },
		{ label: 'Status', value: summary.status },
		{ label: 'Read mode', value: summary.readMode }
	];

	if (summary.readMode === 'private' && body.read === undefined) {
		rows.push({
			label: 'Warning',
			value:
				'private cache has no read credential; it rejects every read until one is set'
		});
	}

	if (generatedReadPassword !== undefined && body.read !== undefined) {
		rows.push(
			{ label: 'Read user', value: body.read.user },
			{ label: 'Read password', value: generatedReadPassword }
		);
	}

	reporter.result({
		kind: 'tenant',
		data: { ...summary, generatedReadPassword },
		rows
	});
}

export async function runTenantList(
	reporter: Reporter,
	client: Pick<TenantClient, 'list'>
): Promise<void> {
	const { tenants } = await reporter.phase('Listing tenants', () =>
		client.list()
	);

	reporter.result({
		kind: 'tenants',
		data: tenants,
		rows: tenants.map((summary) => tenantRow(summary)),
		empty: 'No tenants.'
	});
}

export async function runTenantSuspend(
	id: TenantId,
	ui: CliUi,
	client: TenantClient
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
		data: result,
		rows: [{ label: result.id, value: result.status }]
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
		data: result,
		rows: [{ label: result.id, value: result.status }]
	});
}

export async function runTenantReadMode(
	id: TenantId,
	readMode: 'public' | 'private',
	reporter: Reporter,
	client: Pick<TenantClient, 'setReadMode'>
): Promise<void> {
	const result = await reporter.phase('Setting read mode', () =>
		client.setReadMode({ id, readMode })
	);

	reporter.result({
		kind: 'tenant',
		data: result,
		rows: [{ label: result.id, value: result.readMode }]
	});
}

export async function runTenantRotateCredential(
	id: TenantId,
	options: RotateCredentialOptions,
	reporter: Reporter,
	client: Pick<TenantClient, 'rotateReadCredential'>
): Promise<void> {
	const user = readUserOrDefault(options.readUser);
	const password = generateReadPassword();

	const result = await reporter.phase('Rotating read credential', () =>
		client.rotateReadCredential({ id, read: { user, password } })
	);

	const rows: ResultRow[] = [
		{ label: 'Tenant', value: result.id },
		{ label: 'Read mode', value: result.readMode },
		{ label: 'Read user', value: user },
		{ label: 'Read password', value: password }
	];

	if (result.readMode === 'public') {
		rows.push({
			label: 'Warning',
			value:
				'tenant is public; the read credential is unused until it is private'
		});
	}

	reporter.result({
		kind: 'tenant',
		data: { ...result, readUser: user, generatedReadPassword: password },
		rows
	});
}

export async function runTenantRotateCacheCredential(
	id: TenantId,
	cacheName: CacheName,
	options: RotateCredentialOptions,
	reporter: Reporter,
	client: Pick<TenantClient, 'rotateCacheReadCredential'>
): Promise<void> {
	const user = readUserOrDefault(options.readUser);
	const password = generateReadPassword();

	const result = await reporter.phase('Rotating cache read credential', () =>
		client.rotateCacheReadCredential({
			id,
			cacheName,
			read: { user, password }
		})
	);

	reporter.result({
		kind: 'tenant',
		data: { ...result, readUser: user, generatedReadPassword: password },
		rows: [
			{ label: 'Tenant', value: result.id },
			{ label: 'Private cache', value: result.cacheName },
			{ label: 'Read user', value: user },
			{ label: 'Read password', value: password }
		]
	});
}

export async function runTenantClearCacheCredential(
	id: TenantId,
	cacheName: CacheName,
	reporter: Reporter,
	client: Pick<TenantClient, 'clearCacheReadCredential'>
): Promise<void> {
	const result = await reporter.phase('Clearing cache read credential', () =>
		client.clearCacheReadCredential({ id, cacheName })
	);

	reporter.result({
		kind: 'tenant',
		data: result,
		rows: [
			{ label: 'Tenant', value: result.id },
			{ label: 'Private cache', value: result.cacheName },
			{
				label: 'Read credential',
				value: 'cleared; readers now use the tenant credential'
			}
		]
	});
}

export async function runTenantClearCredential(
	id: TenantId,
	reporter: Reporter,
	client: Pick<TenantClient, 'clearReadCredential'>
): Promise<void> {
	const result = await reporter.phase('Clearing read credential', () =>
		client.clearReadCredential({ id })
	);

	reporter.result({
		kind: 'tenant',
		data: result,
		rows: [{ label: result.id, value: result.readMode }]
	});
}

export async function runTenantRemove(
	id: TenantId,
	ui: CliUi,
	client: TenantClient
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Begin offboarding tenant ${id}?`,
		detail:
			'Writes stop at once and the tenant drains its data in the background.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('The tenant was left in place.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase('Offboarding tenant', () =>
		client.remove({ id })
	);

	reporter.result({
		kind: 'tenant',
		data: result,
		rows: [{ label: result.id, value: result.status }]
	});
}

function tenantRow(summary: TenantSummary): ResultRow {
	return {
		label: summary.id,
		value: `${summary.status}; ${summary.readMode}; config v${String(summary.configVersion)}`
	};
}
