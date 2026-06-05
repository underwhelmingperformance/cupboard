import { randomBytes } from 'node:crypto';

import {
	defaultReadUser,
	type TenantCreateBody,
	tenantCreateBodySchema,
	type TenantListResponse,
	type TenantMutateResponse,
	type TenantSummary
} from '@cupboard/protocol/tenants';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { reporterModeFromGlobals } from '../cli.ts';
import { type AccessCredential, CupboardClient } from '../client/client.ts';
import { createReporter, type Reporter, type ResultRow } from '../reporter.ts';

export interface TenantClient {
	createTenant(
		token: AccessCredential,
		body: TenantCreateBody
	): Promise<TenantSummary>;
	listTenants(token: AccessCredential): Promise<TenantListResponse>;
	suspendTenant(
		token: AccessCredential,
		id: string
	): Promise<TenantMutateResponse>;
	deleteTenant(
		token: AccessCredential,
		id: string
	): Promise<TenantMutateResponse>;
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

export function registerTenantCommands(program: Command): void {
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
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);
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
				cachedOwnerProvider(url),
				reporter,
				client,
				readSelection.generatedPassword
			);
		});

	tenant
		.command('list')
		.description('List provisioned tenants.')
		.argument('<url>', urlArgument)
		.action(async (url: string) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);

			await runTenantList(cachedOwnerProvider(url), reporter, client);
		});

	tenant
		.command('suspend')
		.description('Suspend a tenant: new writes stop, reads stop after the TTL.')
		.argument('<url>', urlArgument)
		.argument('<id>', 'tenant slug')
		.action(async (url: string, id: string) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);

			await runTenantSuspend(id, cachedOwnerProvider(url), reporter, client);
		});

	tenant
		.command('delete')
		.description('Begin offboarding a tenant.')
		.argument('<url>', urlArgument)
		.argument('<id>', 'tenant slug')
		.action(async (url: string, id: string) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);

			await runTenantDelete(id, cachedOwnerProvider(url), reporter, client);
		});
}

export async function runTenantCreate(
	body: TenantCreateBody,
	token: AccessCredential,
	reporter: Reporter,
	client: TenantClient,
	generatedReadPassword?: string
): Promise<void> {
	const summary = await reporter.phase('Creating tenant', () =>
		client.createTenant(token, body)
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

	reporter.result(rows);
}

export async function runTenantList(
	token: AccessCredential,
	reporter: Reporter,
	client: TenantClient
): Promise<void> {
	const { tenants } = await reporter.phase('Listing tenants', () =>
		client.listTenants(token)
	);

	reporter.result(tenants.map((summary) => tenantRow(summary)));
}

export async function runTenantSuspend(
	id: string,
	token: AccessCredential,
	reporter: Reporter,
	client: TenantClient
): Promise<void> {
	const result = await reporter.phase('Suspending tenant', () =>
		client.suspendTenant(token, id)
	);

	reporter.result([{ label: result.id, value: result.status }]);
}

export async function runTenantDelete(
	id: string,
	token: AccessCredential,
	reporter: Reporter,
	client: TenantClient
): Promise<void> {
	const result = await reporter.phase('Offboarding tenant', () =>
		client.deleteTenant(token, id)
	);

	reporter.result([{ label: result.id, value: result.status }]);
}

function tenantRow(summary: TenantSummary): ResultRow {
	return {
		label: summary.id,
		value: `${summary.status}; ${summary.readMode}; config v${String(summary.configVersion)}`
	};
}
