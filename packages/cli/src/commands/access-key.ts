import { readFile } from 'node:fs/promises';

import type { CliUi } from '@cupboard/cli-ui';
import {
	type CacheName,
	cacheNameSchema,
	type CacheScope
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type AccessKeyCreateRequest,
	type AccessKeyCreateResponse,
	type AccessKeyDeleteResponse,
	accessKeyExpirySchema,
	type AccessKeyId,
	accessKeyIdSchema,
	type AccessKeyListRequest,
	type AccessKeyListResponse,
	type AccessKeySummary,
	type UnreadableAccessKey
} from '@cupboard/protocol/access-keys';
import { tenantContract } from '@cupboard/protocol/contract';
import {
	type AuthorizationDetail,
	type AuthorizationDetails,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import {
	type ReuseViewName,
	reuseViewNameSchema
} from '@cupboard/protocol/reuse-views';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	formatTimestamp,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import { collectProgressively } from '@cupboard/shared/collections';
import { cursorPages } from '@cupboard/shared/paging';
import type { Command } from 'commander';

import {
	type AccessKeyOptions,
	parseAccessKey
} from '../access-key-options.ts';
import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { listingLimits } from '../client/listings.ts';
import {
	type CallOptions,
	procedureDeadline,
	tenantRpc
} from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { parseDurationSeconds } from '../duration.ts';
import { CliUsageError } from '../errors.ts';
import { humanOperation } from '../human-permissions.ts';
import { tenantUrlArgument } from '../url-argument.ts';

import {
	ContentReadRootSelectionError,
	expandAllow,
	RootBindingRequiredError
} from './oidc-trust/rule-builder.ts';

export interface AccessKeyClient {
	create(input: AccessKeyCreateRequest): Promise<AccessKeyCreateResponse>;
	list(
		input: AccessKeyListRequest,
		options?: CallOptions
	): Promise<AccessKeyListResponse>;
	delete(input: { id: AccessKeyId }): Promise<AccessKeyDeleteResponse>;
}

/**
The grant options of `access-key create`. `grants` is a JSON document of
authorization details; it replaces the other options.
*/
export interface AccessKeyGrantOptions {
	readonly allow: readonly string[];
	readonly cache?: string;
	readonly root?: string;
	readonly view?: string;
	readonly grants?: string;
}

/**
The expiry options of `access-key create`. Commander sets `expiry` to false
for `--no-expiry`.
*/
export interface AccessKeyExpiryOptions {
	readonly expiresIn?: string;
	readonly expiresAt?: string;
	readonly expiry: boolean;
}

interface AccessKeyCreateOptions
	extends AccessKeyGrantOptions, AccessKeyExpiryOptions, AccessKeyOptions {
	readonly grantsFile?: string;
}

interface AccessKeyDeleteOptions extends AccessKeyOptions {
	readonly yes?: boolean;
}

export class AccessKeyExpiryChoiceError extends CliUsageError {
	constructor() {
		super(
			'Choose exactly one of --expires-in, --expires-at and --no-expiry for the new access key.'
		);
		this.name = 'AccessKeyExpiryChoiceError';
	}
}

export class AccessKeyGrantsConflictError extends CliUsageError {
	constructor() {
		super(
			'Give the grants either with --grants-file or with --allow, --cache, --root and --view, not both.'
		);
		this.name = 'AccessKeyGrantsConflictError';
	}
}

export class AccessKeyGrantsRequiredError extends CliUsageError {
	constructor() {
		super(
			'Give the new access key at least one grant with --allow, --view or --grants-file.'
		);
		this.name = 'AccessKeyGrantsRequiredError';
	}
}

export class InvalidAccessKeyExpiryError extends CliUsageError {
	constructor(public readonly value: string) {
		super(
			`--expires-at must be an ISO 8601 date and time, such as 2026-12-31T00:00:00Z, got '${value}'.`
		);
		this.name = 'InvalidAccessKeyExpiryError';
	}
}

export class InvalidAccessKeyIdError extends CliUsageError {
	constructor(public readonly value: string) {
		super(
			`'${value}' is not an access key ID. Copy the ID from cupboard access-key list.`
		);
		this.name = 'InvalidAccessKeyIdError';
	}
}

export class InvalidAccessKeyResourceError extends CliUsageError {
	constructor(
		public readonly option: '--cache' | '--view',
		public readonly value: string
	) {
		super(
			`'${value}' is not a valid ${option === '--cache' ? 'cache' : 'reuse view'} name for ${option}.`
		);
		this.name = 'InvalidAccessKeyResourceError';
	}
}

export class InvalidAccessKeyGrantsError extends CliUsageError {
	constructor(options?: ErrorOptions) {
		super(
			'The grants file must contain a JSON array of authorization details.',
			options
		);
		this.name = 'InvalidAccessKeyGrantsError';
	}
}

/**
Parses the access key ID argument of `access-key delete`.
*/
export function parseAccessKeyId(value: string): AccessKeyId {
	const parsed = accessKeyIdSchema.safeParse(value);

	if (!parsed.success) {
		throw new InvalidAccessKeyIdError(value);
	}

	return parsed.data;
}

export function registerAccessKeyCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const accessKey = program
		.command('access-key')
		.description(
			'Create, list and delete access keys: long-lived secrets with a subset of your grants, for machines that cannot sign in.'
		);

	accessKey
		.command('create')
		.description(
			'Create an access key and print its secret once. Its grants must be a subset of yours.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.option(
			'--allow <action>',
			'a grant to give (repeatable): read, push, attest, root, attach, create, close, reopen, remove or build-inputs',
			collect,
			[]
		)
		.option(
			'--cache <name>',
			"the cache that the grants apply to (default: the tenant's default cache)"
		)
		.option(
			'--root <name>',
			'the root that publication grants cover, or a root prefix ending in /'
		)
		.option('--view <name>', 'also permit content reads from a reuse view')
		.option(
			'--grants-file <path>',
			'read the grants from a JSON file of authorization details, in place of --allow, --cache, --root and --view'
		)
		.option(
			'--expires-in <duration>',
			'expire the key after this long (e.g. 90d, 12h)'
		)
		.option(
			'--expires-at <time>',
			'expire the key at this ISO 8601 date and time'
		)
		.option(
			'--no-expiry',
			'create a key that does not expire; a credential that expires needs access-key:create for every resource in the grants'
		)
		.option(
			'--access-key <key>',
			'authenticate with this access key instead of your saved `cupboard login` session',
			parseAccessKey
		)
		.addHelpText(
			'after',
			[
				'',
				'Example:',
				'  # A key that lets a build machine read the default cache for 90 days',
				'  cupboard access-key create https://cupboard.example.workers.dev/t/acme \\',
				'    --allow read --expires-in 90d'
			].join('\n')
		)
		.action(async (url: URL, options: AccessKeyCreateOptions) => {
			const grants = accessKeyGrants({
				...options,
				...(options.grantsFile !== undefined && {
					grants: await readFile(options.grantsFile, 'utf8')
				})
			});
			const expiresAt = accessKeyExpiry(options, new Date());
			const reporter = commandUi(program, programOptions).reporter();

			await runAccessKeyCreate(
				{ grants, ...(expiresAt !== undefined && { expiresAt }) },
				reporter,
				accessKeyClientFor(url, programOptions, options)
			);
		});

	accessKey
		.command('list')
		.description(
			'List the access keys whose grants you can see, with their grants and expiry.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.option(
			'--access-key <key>',
			'authenticate with this access key instead of your saved `cupboard login` session',
			parseAccessKey
		)
		.action(async (url: URL, options: AccessKeyOptions) => {
			const reporter = commandUi(program, programOptions).reporter();

			await runAccessKeyList(
				reporter,
				accessKeyClientFor(url, programOptions, options)
			);
		});

	accessKey
		.command('delete')
		.description(
			'Delete an access key and every key created below it. Reads can accept a deleted key for up to five minutes, and work that it started can continue for up to 15 minutes.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument(
			'<id>',
			'access key ID, as `cupboard access-key list` shows it',
			parseAccessKeyId
		)
		.option('-y, --yes', 'delete without the confirmation prompt')
		.option(
			'--access-key <key>',
			'authenticate with this access key instead of your saved `cupboard login` session',
			parseAccessKey
		)
		.action(
			async (url: URL, id: AccessKeyId, options: AccessKeyDeleteOptions) => {
				const ui = commandUi(program, programOptions, {
					assumeYes: options.yes
				});

				await runAccessKeyDelete(
					id,
					ui,
					accessKeyClientFor(url, programOptions, options)
				);
			}
		);
}

function accessKeyClientFor(
	url: URL,
	programOptions: ProgramOptions,
	options: AccessKeyOptions
): AccessKeyClient {
	return tenantRpc(url, {
		credential:
			options.accessKey ??
			cachedOwnerProvider(url, { signal: programOptions.signal }),
		signal: programOptions.signal
	}).accessKeys;
}

/**
Builds the grants of a new access key from the same shorthands that the
trust-rule commands use, or parses them from a JSON document.
*/
export function accessKeyGrants(
	options: AccessKeyGrantOptions
): AuthorizationDetails {
	if (options.grants !== undefined) {
		if (
			options.allow.length > 0 ||
			options.cache !== undefined ||
			options.root !== undefined ||
			options.view !== undefined
		) {
			throw new AccessKeyGrantsConflictError();
		}

		return parseGrantsDocument(options.grants);
	}

	const isRead = options.allow.includes('read');
	const { cacheActions, rootActions } = expandAllow(
		options.allow.filter((value) => value !== 'read')
	);

	if (rootActions.length > 0 && options.root === undefined) {
		throw new RootBindingRequiredError();
	}

	const actions = [...cacheActions, ...rootActions];

	if (isRead && actions.length === 0 && options.root !== undefined) {
		throw new ContentReadRootSelectionError();
	}

	const cache: CacheScope =
		options.cache === undefined
			? { kind: 'default' }
			: { kind: 'named', name: cacheNameOption(options.cache) };
	const view =
		options.view === undefined ? undefined : viewNameOption(options.view);
	const grants: unknown[] = [
		...(actions.length === 0
			? []
			: [
					{
						type: 'cupboard_cache',
						actions,
						cache,
						...(options.root !== undefined && { root: options.root })
					}
				]),
		...(isRead
			? [{ type: 'cupboard_cache', actions: ['cache:content-read'], cache }]
			: []),
		...(view === undefined
			? []
			: [
					{
						type: 'cupboard_view',
						actions: ['view:content-read'],
						view
					}
				])
	];

	if (grants.length === 0) {
		throw new AccessKeyGrantsRequiredError();
	}

	return authorizationDetailsSchema.parse(grants);
}

/**
Returns the expiry of a new access key, or undefined for a key that does not
expire. The caller must choose one of the three expiry options, so a key
without an expiry is always a deliberate choice.
*/
export function accessKeyExpiry(
	options: AccessKeyExpiryOptions,
	now: Date
): IsoTimestamp | undefined {
	const choices = [
		options.expiresIn !== undefined,
		options.expiresAt !== undefined,
		!options.expiry
	].filter(Boolean).length;

	if (choices !== 1) {
		throw new AccessKeyExpiryChoiceError();
	}

	if (options.expiresIn !== undefined) {
		return isoTimestamp(
			new Date(now.getTime() + parseDurationSeconds(options.expiresIn) * 1000)
		);
	}

	if (options.expiresAt === undefined) {
		return undefined;
	}

	const parsed = accessKeyExpirySchema.safeParse(options.expiresAt);

	if (!parsed.success) {
		throw new InvalidAccessKeyExpiryError(options.expiresAt);
	}

	return parsed.data;
}

function cacheNameOption(value: string): CacheName {
	const parsed = cacheNameSchema.safeParse(value);

	if (!parsed.success) {
		throw new InvalidAccessKeyResourceError('--cache', value);
	}

	return parsed.data;
}

function viewNameOption(value: string): ReuseViewName {
	const parsed = reuseViewNameSchema.safeParse(value);

	if (!parsed.success) {
		throw new InvalidAccessKeyResourceError('--view', value);
	}

	return parsed.data;
}

function parseGrantsDocument(text: string): AuthorizationDetails {
	let document: unknown;

	try {
		document = JSON.parse(text);
	} catch (error) {
		throw new InvalidAccessKeyGrantsError({ cause: error });
	}

	const parsed = authorizationDetailsSchema.safeParse(document);

	if (!parsed.success) {
		throw new InvalidAccessKeyGrantsError({ cause: parsed.error });
	}

	return parsed.data;
}

export async function runAccessKeyCreate(
	request: AccessKeyCreateRequest,
	reporter: Reporter,
	client: Pick<AccessKeyClient, 'create'>
): Promise<void> {
	const created = await reporter.phase('Creating access key', () =>
		client.create(request)
	);

	reporter.result({
		kind: 'access-key',
		title: 'Access key',
		data: created,
		rows: [
			{ label: 'Access key', value: created.id },
			...created.grants.map((grant) => ({
				label: 'Grant',
				value: grantDescription(grant)
			})),
			{ label: 'Expires', value: expiryDescription(created) },
			{ label: 'Secret', value: created.secret, raw: true }
		]
	});
	reporter.info(
		'Save the secret now. cupboard does not store it and cannot show it again.'
	);
}

export async function runAccessKeyList(
	reporter: Reporter,
	client: Pick<AccessKeyClient, 'list'>
): Promise<void> {
	const listed = await reporter.phase('Listing access keys', async () =>
		collectProgressively(
			await cursorPages<ListedAccessKey, AccessKeyId>(
				async (cursor, signal) => {
					const page = await client.list(
						{ ...(cursor !== undefined && { cursor }) },
						{ signal }
					);

					return {
						items: [
							...page.accessKeys.map((key) => readableListed(key)),
							...page.unreadableAccessKeys.map((key) => unreadableListed(key))
						],
						next: page.cursor
					};
				},
				procedureDeadline('accessKeys.list', tenantContract.accessKeys.list)
			),
			listingLimits('The access key listing')
		)
	);
	const sorted = listed.toSorted(
		(left, right) =>
			byCodeUnit(left.key.createdAt, right.key.createdAt) ||
			byCodeUnit(left.key.id, right.key.id)
	);

	reporter.result({
		kind: 'access-keys',
		title: 'Access keys',
		data: {
			accessKeys: sorted.flatMap((entry) =>
				entry.kind === 'readable' ? [entry.key] : []
			),
			unreadableAccessKeys: sorted.flatMap((entry) =>
				entry.kind === 'unreadable' ? [entry.key] : []
			)
		},
		rows: sorted.map((entry) =>
			entry.kind === 'readable'
				? accessKeyRow(entry.key)
				: unreadableAccessKeyRow(entry.key)
		),
		empty: 'No access keys.'
	});
}

export async function runAccessKeyDelete(
	id: AccessKeyId,
	ui: CliUi,
	client: Pick<AccessKeyClient, 'delete'>
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Delete access key ${id} and the keys below it?`,
		detail:
			'New admin, upload and commit requests with these keys fail at once, and reads stop within five minutes. Work that the keys started can continue for up to 15 minutes.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('The access key was left in place.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase('Deleting access key', () =>
		client.delete({ id })
	);

	reporter.result({
		kind: 'access-key',
		title: 'Access key',
		data: result,
		rows: [
			{ label: 'Access key', value: result.id },
			{
				label: 'Outcome',
				value: result.deleted
					? 'access key and the keys below it deleted'
					: 'access key not found'
			}
		]
	});
}

/**
A key in a listing: one with grants that the server can read, or one that
only a wildcard holder sees because the server cannot read its grants.
*/
type ListedAccessKey =
	| { readonly kind: 'readable'; readonly key: AccessKeySummary }
	| { readonly kind: 'unreadable'; readonly key: UnreadableAccessKey };

function readableListed(key: AccessKeySummary): ListedAccessKey {
	return { kind: 'readable', key };
}

function unreadableListed(key: UnreadableAccessKey): ListedAccessKey {
	return { kind: 'unreadable', key };
}

function accessKeyRow(key: AccessKeySummary): ResultRow {
	return {
		label: key.id,
		value: [
			...key.grants.map((grant) => grantDescription(grant)),
			...keyDetails(key)
		].join('; ')
	};
}

function unreadableAccessKeyRow(key: UnreadableAccessKey): ResultRow {
	return {
		label: key.id,
		value: [
			'grants that this deployment cannot read; it refuses the key',
			...keyDetails(key)
		].join('; ')
	};
}

function keyDetails(key: UnreadableAccessKey): string[] {
	return [
		`subject ${key.subject}`,
		...(key.rule === undefined ? [] : [`rule ${key.rule}`]),
		...(key.parent === undefined
			? []
			: [
					key.parent.kind === 'access-key'
						? `created by access key ${key.parent.id}`
						: `created in sign-in session ${key.parent.id}`
				]),
		`created ${formatTimestamp(key.createdAt)}`,
		key.expiresAt === undefined
			? 'does not expire'
			: `expires ${formatTimestamp(key.expiresAt)}`
	];
}

function expiryDescription(key: AccessKeySummary): string {
	return key.expiresAt === undefined
		? 'does not expire'
		: formatTimestamp(key.expiresAt);
}

function grantDescription(grant: AuthorizationDetail): string {
	if (grant.type === 'cupboard_wildcard') {
		return 'Every operation on every resource';
	}

	const operations = grant.actions
		.map((operation) => humanOperation(operation))
		.join(', ');

	return `${grantResource(grant)}: ${operations}`;
}

function grantResource(
	grant: Exclude<AuthorizationDetail, { type: 'cupboard_wildcard' }>
): string {
	switch (grant.type) {
		case 'cupboard_cache': {
			const cache =
				grant.cache.kind === 'default'
					? "Tenant's default cache"
					: `Cache ${grant.cache.name}`;

			return grant.root === undefined ? cache : `${cache}, root ${grant.root}`;
		}
		case 'cupboard_view': {
			return `View ${grant.view}`;
		}
		case 'cupboard_tenant': {
			return `Tenant ${grant.tenant}`;
		}
		case 'cupboard_control': {
			return 'Deployment';
		}
		case 'cupboard_domain': {
			return 'Tenant';
		}
	}
}

function collect(value: string, previous: readonly string[]): string[] {
	return [...previous, value];
}
