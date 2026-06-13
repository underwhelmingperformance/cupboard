import { randomBytes } from 'node:crypto';

import { type CliUi, createCliUi } from '@cupboard/cli-ui';
import {
	defaultReadUser,
	type TenantCreateBody,
	tenantCreateBodySchema,
	type TenantListResponse,
	type TenantMutateResponse,
	type TenantReadModeResponse,
	tenantReadModeSchema,
	type TenantSummary
} from '@cupboard/protocol/tenants';
import { type Reporter, type ResultRow } from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { type ProgramOptions, reporterModeFromGlobals } from '../cli.ts';
import { controlRpc } from '../client/orpc.ts';

/**
 * The slice of the derived control client the tenant commands consume, in the
 * contract's input and output shapes; the real `controlRpc(...).tenants`
 * satisfies it by construction.
 */
export interface TenantClient {
	list(): Promise<TenantListResponse>;
	create(input: TenantCreateBody): Promise<TenantSummary>;
	suspend(input: { id: string }): Promise<TenantMutateResponse>;
	resume(input: { id: string }): Promise<TenantMutateResponse>;
	setReadMode(input: {
		id: string;
		readMode: 'public' | 'private';
	}): Promise<TenantReadModeResponse>;
	rotateReadCredential(input: {
		id: string;
		read: { user: string; password: string };
	}): Promise<TenantReadModeResponse>;
	clearReadCredential(input: { id: string }): Promise<TenantReadModeResponse>;
	remove(input: { id: string }): Promise<TenantMutateResponse>;
}

interface RotateCredentialOptions {
	readonly readUser?: string;
	readonly readPassword?: string;
}

interface ConfirmableOptions {
	readonly yes?: boolean;
}

interface CreateOptions {
	readonly ownerIssuer: string;
	readonly ownerSubject: string;
	readonly ownerAudience: string;
	readonly public?: boolean;
	readonly readUser?: string;
	readonly readPassword?: string | false;
	readonly quotaBytes?: number;
}

export class ReadCredentialIncompleteError extends Error {
	constructor() {
		super('--read-user requires --read-password');
		this.name = 'ReadCredentialIncompleteError';
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
		| { readonly user: string; readonly password: string }
		| undefined;
	readonly generatedPassword: string | undefined;
}

export function generateReadPassword(): string {
	return randomBytes(32).toString('base64url');
}

// The read credential a private cache needs. Private tenants get a generated
// password by default; `--no-read-password` keeps the existing fails-closed mode.
export function readCredentialFromOptions(options: {
	readonly public?: boolean;
	readonly readUser?: string;
	readonly readPassword?: string | false;
}): ReadCredentialSelection {
	if (options.readPassword === false) {
		if (options.readUser !== undefined) {
			throw new ReadCredentialIncompleteError();
		}

		return { read: undefined, generatedPassword: undefined };
	}

	if (options.public === true && options.readPassword === undefined) {
		return { read: undefined, generatedPassword: undefined };
	}

	const user = options.readUser ?? defaultReadUser;
	const generated =
		options.readPassword === undefined || options.readPassword === 'auto'
			? generateReadPassword()
			: undefined;

	if (generated !== undefined) {
		return {
			read: { user, password: generated },
			generatedPassword: generated
		};
	}

	const explicitPassword = options.readPassword;

	if (explicitPassword === undefined) {
		throw new ReadCredentialIncompleteError();
	}

	return {
		read: { user, password: explicitPassword },
		generatedPassword: undefined
	};
}

const urlArgument =
	'deployment URL (e.g. https://cupboard.example.workers.dev)';

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
		.argument('<url>', urlArgument)
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
			'the Basic-auth user a private cache requires from readers'
		)
		.option(
			'--read-password <password>',
			'the Basic-auth password a private cache requires from readers (default: auto)'
		)
		.option(
			'--no-read-password',
			'create a private cache with no read password'
		)
		.option(
			'--quota-bytes <bytes>',
			'the storage quota in bytes (unlimited by default)',
			parseQuotaBytes
		)
		.action(async (url: string, id: string, options: CreateOptions) => {
			const reporter = createCliUi({
				mode: reporterModeFromGlobals(program)
			}).reporter();
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
				...(readSelection.read === undefined
					? {}
					: { read: readSelection.read }),
				...(options.quotaBytes === undefined
					? {}
					: { quotaBytes: options.quotaBytes })
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
		.argument('<url>', urlArgument)
		.action(async (url: string) => {
			const reporter = createCliUi({
				mode: reporterModeFromGlobals(program)
			}).reporter();
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runTenantList(reporter, rpc.tenants);
		});

	tenant
		.command('suspend')
		.description('Suspend a tenant: new writes stop, reads stop after the TTL.')
		.argument('<url>', urlArgument)
		.argument('<id>', 'tenant slug')
		.option('-y, --yes', 'suspend without the confirmation prompt')
		.action(async (url: string, id: string, options: ConfirmableOptions) => {
			const ui = createCliUi({
				mode: reporterModeFromGlobals(program),
				assumeYes: options.yes
			});
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runTenantSuspend(id, ui, rpc.tenants);
		});

	tenant
		.command('resume')
		.description(
			'Resume a suspended tenant: reads and writes are allowed again.'
		)
		.argument('<url>', urlArgument)
		.argument('<id>', 'tenant slug')
		.action(async (url: string, id: string) => {
			const reporter = createCliUi({
				mode: reporterModeFromGlobals(program)
			}).reporter();
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runTenantResume(id, reporter, rpc.tenants);
		});

	tenant
		.command('read-mode')
		.description("Set a tenant's read mode.")
		.argument('<url>', urlArgument)
		.argument('<id>', 'tenant slug')
		.argument('<mode>', 'public or private')
		.action(async (url: string, id: string, mode: string) => {
			const reporter = createCliUi({
				mode: reporterModeFromGlobals(program)
			}).reporter();
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runTenantReadMode(
				id,
				tenantReadModeSchema.parse(mode),
				reporter,
				rpc.tenants
			);
		});

	tenant
		.command('rotate-credential')
		.description(
			"Set a private cache's read credential, generating a password by default."
		)
		.argument('<url>', urlArgument)
		.argument('<id>', 'tenant slug')
		.option(
			'--read-user <user>',
			'the Basic-auth user a private cache requires from readers'
		)
		.option(
			'--read-password <password>',
			'the Basic-auth password a private cache requires from readers (default: auto)'
		)
		.action(
			async (url: string, id: string, options: RotateCredentialOptions) => {
				const reporter = createCliUi({
					mode: reporterModeFromGlobals(program)
				}).reporter();
				const rpc = controlRpc(url, {
					credential: cachedOwnerProvider(url, {
						signal: programOptions.signal
					}),
					signal: programOptions.signal
				});

				await runTenantRotateCredential(id, options, reporter, rpc.tenants);
			}
		);

	tenant
		.command('clear-credential')
		.description(
			"Clear a tenant's read credential; a private cache then fails closed."
		)
		.argument('<url>', urlArgument)
		.argument('<id>', 'tenant slug')
		.action(async (url: string, id: string) => {
			const reporter = createCliUi({
				mode: reporterModeFromGlobals(program)
			}).reporter();
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runTenantClearCredential(id, reporter, rpc.tenants);
		});

	tenant
		.command('remove')
		.alias('delete')
		.description('Begin offboarding a tenant.')
		.argument('<url>', urlArgument)
		.argument('<id>', 'tenant slug')
		.option('-y, --yes', 'offboard without the confirmation prompt')
		.action(async (url: string, id: string, options: ConfirmableOptions) => {
			const ui = createCliUi({
				mode: reporterModeFromGlobals(program),
				assumeYes: options.yes
			});
			const rpc = controlRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runTenantRemove(id, ui, rpc.tenants);
		});
}

export async function runTenantCreate(
	body: TenantCreateBody,
	reporter: Reporter,
	client: TenantClient,
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

	// A private cache with no read credential fails closed, so flag it: the operator
	// must recreate it with --read-user/--read-password before any reader can use it.
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
	client: TenantClient
): Promise<void> {
	const { tenants } = await reporter.phase('Listing tenants', () =>
		client.list()
	);

	reporter.result({
		kind: 'tenants',
		data: tenants,
		rows: tenants.map((summary) => tenantRow(summary))
	});
}

export async function runTenantSuspend(
	id: string,
	ui: CliUi,
	client: TenantClient
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Suspend tenant ${id}?`,
		detail: 'New writes stop at once; reads stop after the read TTL.'
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
	id: string,
	reporter: Reporter,
	client: TenantClient
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
	id: string,
	readMode: 'public' | 'private',
	reporter: Reporter,
	client: TenantClient
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
	id: string,
	options: RotateCredentialOptions,
	reporter: Reporter,
	client: TenantClient
): Promise<void> {
	const user = options.readUser ?? defaultReadUser;
	const password = options.readPassword ?? generateReadPassword();
	const generated = options.readPassword === undefined ? password : undefined;

	const result = await reporter.phase('Rotating read credential', () =>
		client.rotateReadCredential({ id, read: { user, password } })
	);

	const rows: ResultRow[] = [
		{ label: 'Tenant', value: result.id },
		{ label: 'Read mode', value: result.readMode },
		{ label: 'Read user', value: user }
	];

	if (generated !== undefined) {
		rows.push({ label: 'Read password', value: generated });
	}

	// A read credential only gates a private cache; flag the public case so the
	// operator is not left thinking reads are now authenticated.
	if (result.readMode === 'public') {
		rows.push({
			label: 'Warning',
			value:
				'tenant is public; the read credential is unused until it is private'
		});
	}

	reporter.result({
		kind: 'tenant',
		data: { ...result, readUser: user, generatedReadPassword: generated },
		rows
	});
}

export async function runTenantClearCredential(
	id: string,
	reporter: Reporter,
	client: TenantClient
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
	id: string,
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
