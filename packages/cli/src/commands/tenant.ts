import { randomBytes } from 'node:crypto';

import type { CliUi } from '@cupboard/cli-ui';
import {
	type CacheAccessMode,
	type CacheName,
	cacheNameSchema,
	type CacheScope,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import {
	type CacheReadCredentialResponse,
	defaultReadUser,
	readPasswordByteLength,
	type TenantCreateBody,
	tenantCreateBodySchema,
	type TenantListResponse,
	type TenantMutateResponse,
	type TenantReadCredentialResponse,
	type TenantSummary
} from '@cupboard/protocol/tenants';
import { type Reporter, type ResultRow } from '@cupboard/reporter';
import type { ReadUser } from '@cupboard/shared/http';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { parseCacheAccess } from '../cache-access.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { cacheLabel } from '../client/client.ts';
import { controlRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { parseReadUser } from '../read-user.ts';
import { deploymentUrlArgument } from '../url-argument.ts';

export interface TenantClient {
	list(): Promise<TenantListResponse>;
	create(input: TenantCreateBody): Promise<TenantSummary>;
	suspend(input: { id: TenantId }): Promise<TenantMutateResponse>;
	resume(input: { id: TenantId }): Promise<TenantMutateResponse>;
	rotateReadCredential(input: {
		id: TenantId;
		read: { user: ReadUser; password: string };
	}): Promise<TenantReadCredentialResponse>;
	clearReadCredential(input: {
		id: TenantId;
	}): Promise<TenantReadCredentialResponse>;
	rotateDefaultCacheReadCredential(input: {
		id: TenantId;
		read: { user: ReadUser; password: string };
	}): Promise<CacheReadCredentialResponse>;
	rotateNamedCacheReadCredential(input: {
		id: TenantId;
		cacheName: CacheName;
		read: { user: ReadUser; password: string };
	}): Promise<CacheReadCredentialResponse>;
	clearDefaultCacheReadCredential(input: {
		id: TenantId;
	}): Promise<CacheReadCredentialResponse>;
	clearNamedCacheReadCredential(input: {
		id: TenantId;
		cacheName: CacheName;
	}): Promise<CacheReadCredentialResponse>;
	remove(input: { id: TenantId }): Promise<TenantMutateResponse>;
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
	readonly defaultCacheAccess?: CacheAccessMode;
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
	if (!/^\d+$/u.test(value)) {
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

export function generateReadPassword(): string {
	return randomBytes(readPasswordByteLength).toString('base64url');
}

function readUserOrDefault(supplied: ReadUser | undefined): ReadUser {
	return supplied ?? defaultReadUser;
}

export function readCredentialFromOptions(options: {
	readonly readUser?: ReadUser;
	readonly readPassword?: boolean;
}): ReadCredentialSelection {
	if (options.readPassword === false) {
		if (options.readUser !== undefined) {
			throw new ReadUserWithoutCredentialError(options.readUser);
		}

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
		.option(
			'--default-cache-access <mode>',
			'the default cache read access: public or private (default: private)',
			parseCacheAccess
		)
		.option(
			'--read-user <user>',
			'the user for the tenant-wide fallback read credential',
			parseReadUser
		)
		.option('--no-read-password', 'do not create a fallback read credential')
		.option(
			'--quota-bytes <bytes>',
			'the storage quota in bytes (unlimited by default)',
			parseQuotaBytes
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
				defaultCacheAccess: options.defaultCacheAccess ?? 'private',
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
			await runTenantList(reporter, tenantClient(url, programOptions));
		});

	tenant
		.command('suspend')
		.description('Suspend a tenant: new reads and writes stop immediately.')
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
		.command('rotate-credential')
		.description('Replace the tenant-wide fallback read credential.')
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<id>', 'tenant slug')
		.option('--read-user <user>', 'the read user', parseReadUser)
		.action(async (url: URL, id: string, options: RotateCredentialOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			await runTenantRotateCredential(
				tenantIdSchema.parse(id),
				options,
				reporter,
				tenantClient(url, programOptions)
			);
		});

	tenant
		.command('clear-credential')
		.description('Clear the tenant-wide fallback read credential.')
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<id>', 'tenant slug')
		.action(async (url: URL, id: string) => {
			const reporter = commandUi(program, programOptions).reporter();
			await runTenantClearCredential(
				tenantIdSchema.parse(id),
				reporter,
				tenantClient(url, programOptions)
			);
		});

	tenant
		.command('rotate-cache-credential')
		.description(
			"Set one cache's own read credential to a newly generated password."
		)
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<id>', 'tenant slug')
		.argument('[cache]', 'named cache; omit it for the default cache')
		.option(
			'--read-user <user>',
			'the Basic-auth user this cache requires from readers',
			parseReadUser
		)
		.action(
			async (
				url: URL,
				id: string,
				cache: string | undefined,
				options: RotateCredentialOptions
			) => {
				const reporter = commandUi(program, programOptions).reporter();
				await runTenantRotateCacheCredential(
					tenantIdSchema.parse(id),
					cacheScopeFromName(cache),
					options,
					reporter,
					tenantClient(url, programOptions)
				);
			}
		);

	tenant
		.command('clear-cache-credential')
		.description(
			"Clear one cache's own read credential; readers then use the tenant credential."
		)
		.argument('<url>', deploymentUrlArgument, parseWorkerUrl)
		.argument('<id>', 'tenant slug')
		.argument('[cache]', 'named cache; omit it for the default cache')
		.action(async (url: URL, id: string, cache: string | undefined) => {
			const reporter = commandUi(program, programOptions).reporter();
			await runTenantClearCacheCredential(
				tenantIdSchema.parse(id),
				cacheScopeFromName(cache),
				reporter,
				tenantClient(url, programOptions)
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
			await runTenantRemove(
				tenantIdSchema.parse(id),
				ui,
				tenantClient(url, programOptions)
			);
		});
}

function cacheScopeFromName(name: string | undefined): CacheScope {
	return name === undefined
		? { kind: 'default' }
		: { kind: 'named', name: cacheNameSchema.parse(name) };
}

function tenantClient(url: URL, options: ProgramOptions): TenantClient {
	return controlRpc(url, {
		credential: cachedOwnerProvider(url, { signal: options.signal }),
		signal: options.signal
	}).tenants;
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
		{ label: 'Default cache access', value: body.defaultCacheAccess }
	];

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

	reporter.result({
		kind: 'tenant',
		data: { ...result, readUser: user, generatedReadPassword: password },
		rows: [
			{ label: 'Tenant', value: result.id },
			{ label: 'Read user', value: user },
			{ label: 'Read password', value: password }
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
		rows: [
			{ label: 'Tenant', value: result.id },
			{ label: 'Read credential', value: 'cleared' }
		]
	});
}

/**
 * Generates a read password for one cache, sets it as that cache's own read
 * credential, and prints it once. The deployment stores only a verifier, so
 * the password cannot be recovered later.
 */
export async function runTenantRotateCacheCredential(
	id: TenantId,
	cache: CacheScope,
	options: RotateCredentialOptions,
	reporter: Reporter,
	client: Pick<
		TenantClient,
		'rotateDefaultCacheReadCredential' | 'rotateNamedCacheReadCredential'
	>
): Promise<void> {
	const user = readUserOrDefault(options.readUser);
	const password = generateReadPassword();
	const read = { user, password };
	const result = await reporter.phase('Rotating cache read credential', () =>
		cache.kind === 'default'
			? client.rotateDefaultCacheReadCredential({ id, read })
			: client.rotateNamedCacheReadCredential({
					id,
					cacheName: cache.name,
					read
				})
	);

	reporter.result({
		kind: 'cache-credential',
		data: { ...result, readUser: user, generatedReadPassword: password },
		rows: [
			{ label: 'Tenant', value: result.id },
			{ label: 'Cache', value: cacheLabel(result.cache) },
			{ label: 'Read user', value: user },
			{ label: 'Read password', value: password }
		]
	});
}

export async function runTenantClearCacheCredential(
	id: TenantId,
	cache: CacheScope,
	reporter: Reporter,
	client: Pick<
		TenantClient,
		'clearDefaultCacheReadCredential' | 'clearNamedCacheReadCredential'
	>
): Promise<void> {
	const result = await reporter.phase('Clearing cache read credential', () =>
		cache.kind === 'default'
			? client.clearDefaultCacheReadCredential({ id })
			: client.clearNamedCacheReadCredential({ id, cacheName: cache.name })
	);

	reporter.result({
		kind: 'cache-credential',
		data: result,
		rows: [
			{ label: 'Tenant', value: result.id },
			{ label: 'Cache', value: cacheLabel(result.cache) },
			{
				label: 'Read credential',
				value: 'cleared; readers now use the tenant credential'
			}
		]
	});
}

export async function runTenantRemove(
	id: TenantId,
	ui: CliUi,
	client: Pick<TenantClient, 'remove'>
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
		value: `${summary.status}; config v${String(summary.configVersion)}`
	};
}
