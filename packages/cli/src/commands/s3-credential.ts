import type { CliUi } from '@cupboard/cli-ui';
import { DEFAULT_CACHE } from '@cupboard/nix-store/scalars';
import type {
	S3CredentialCreated,
	S3CredentialListResponse,
	S3CredentialRevokeResponse,
	S3CredentialSummary
} from '@cupboard/protocol/s3-credentials';
import {
	formatTimestamp,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { storedCacheFor } from '../client/client.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface CreateOptions {
	readonly label: string;
	readonly cache?: string;
	readonly readOnly?: boolean;
	readonly expiresAt?: string;
	readonly endpoint?: string;
	readonly bucket?: string;
	// Always set: the `--region` option carries the default, so callers never
	// observe it absent.
	readonly region: string;
}

interface RevokeOptions {
	readonly yes?: boolean;
}

/**
 * Connection settings used to generate nixbuild.net configuration for a new
 * credential.
 */
export interface NixbuildTarget {
	readonly endpoint: string;
	readonly bucket: string;
	readonly region: string;
}

/**
 * The credential operations used by the CLI.
 */
export interface S3CredentialClient {
	create(input: {
		cache?: string;
		label: string;
		writable?: boolean;
		expiresAt?: string;
	}): Promise<S3CredentialCreated>;
	list(): Promise<S3CredentialListResponse>;
	revoke(input: { accessKeyId: string }): Promise<S3CredentialRevokeResponse>;
}

const defaultRegion = 'auto';

export function registerS3CredentialCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const credential = program
		.command('s3-credential')
		.description("Manage credentials for a cache's S3-compatible endpoint.");

	credential
		.command('create')
		.description(
			'Create an S3 credential. The command shows its secret access key only once.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.requiredOption('--label <label>', 'a label for the credential')
		.option('--cache <name>', 'scope the credential to a named cache')
		.option('--read-only', 'allow substitution but not uploads')
		.option('--expires-at <iso>', 'an ISO 8601 expiry instant')
		.option(
			'--endpoint <url>',
			'also print nixbuild.net settings for this S3 endpoint URL'
		)
		.option(
			'--bucket <slug>',
			'the bucket (tenant slug) for the nixbuild settings; defaults to the tenant in the URL'
		)
		.option(
			'--region <region>',
			`the region for the nixbuild settings (default ${defaultRegion})`,
			defaultRegion
		)
		.action(async (url: URL, options: CreateOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			const nixbuild =
				options.endpoint === undefined
					? undefined
					: {
							endpoint: options.endpoint,
							bucket: options.bucket ?? tenantSlugFromUrl(url),
							region: options.region
						};

			await runS3CredentialCreate(
				{
					cache: storedCacheFor(options.cache),
					label: options.label,
					writable: options.readOnly !== true,
					expiresAt: options.expiresAt
				},
				nixbuild,
				reporter,
				rpc.s3Credentials
			);
		});

	credential
		.command('list')
		.description('List the S3 credentials and their scope.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runS3CredentialList(reporter, rpc.s3Credentials);
		});

	credential
		.command('revoke')
		.description('Revoke an S3 credential by its access key id.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<access-key-id>', 'the credential access key id')
		.option('-y, --yes', 'revoke without the confirmation prompt')
		.action(async (url: URL, accessKeyId: string, options: RevokeOptions) => {
			const ui = commandUi(program, programOptions, {
				assumeYes: options.yes
			});
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, {
					signal: programOptions.signal
				}),
				signal: programOptions.signal
			});

			await runS3CredentialRevoke(accessKeyId, ui, rpc.s3Credentials);
		});
}

export async function runS3CredentialCreate(
	body: {
		cache?: string;
		label: string;
		writable: boolean;
		expiresAt?: string;
	},
	nixbuild: NixbuildTarget | undefined,
	reporter: Reporter,
	client: Pick<S3CredentialClient, 'create'>
): Promise<void> {
	const created = await reporter.phase('Creating S3 credential', () =>
		client.create(body)
	);

	reporter.result({
		kind: 's3-credential',
		data: created,
		rows: [
			{ label: 'Credential', value: created.credentialId },
			{ label: 'Access key id', value: created.accessKeyId },
			{ label: 'Secret access key', value: created.secretAccessKey },
			{ label: 'Cache', value: cacheLabel(created.cache) },
			{ label: 'Label', value: created.label },
			{ label: 'Uploads', value: created.writable ? 'yes' : 'no' },
			...(created.expiresAt === undefined
				? []
				: [{ label: 'Expires', value: formatTimestamp(created.expiresAt) }])
		]
	});

	reporter.info(
		'This secret access key will not be shown again. Store it now.'
	);

	if (nixbuild === undefined) {
		return;
	}

	reporter.info(
		[
			'# Configure nixbuild.net to push to this cache:',
			...nixbuildSettingsLines(nixbuild, created)
		].join('\n')
	);
}

export async function runS3CredentialList(
	reporter: Reporter,
	client: Pick<S3CredentialClient, 'list'>
): Promise<void> {
	const { credentials } = await reporter.phase('Listing S3 credentials', () =>
		client.list()
	);

	reporter.result({
		kind: 's3-credentials',
		data: credentials,
		rows: credentials.map((summary) => summaryRow(summary)),
		empty: 'No S3 credentials.'
	});
}

export async function runS3CredentialRevoke(
	accessKeyId: string,
	ui: CliUi,
	client: Pick<S3CredentialClient, 'revoke'>
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Revoke S3 credential ${accessKeyId}?`,
		detail:
			'After revocation, the server refuses requests signed with this credential.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('The credential was left in place.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase('Revoking S3 credential', () =>
		client.revoke({ accessKeyId })
	);

	reporter.result({
		kind: 's3-credential',
		data: result,
		rows: [
			{ label: 'Access key id', value: accessKeyId },
			{ label: 'Revoked', value: result.revoked ? 'yes' : 'not present' }
		]
	});
}

/**
 * Returns the two `settings` commands that configure nixbuild.net to use this
 * credential. The endpoint remains a URL in the query parameter, as
 * nixbuild.net expects.
 */
export function nixbuildSettingsLines(
	target: NixbuildTarget,
	credential: Pick<
		S3CredentialCreated,
		'accessKeyId' | 'secretAccessKey' | 'cache'
	>
): string[] {
	const bucketUrl =
		credential.cache === DEFAULT_CACHE
			? `s3://${target.bucket}`
			: `s3://${target.bucket}/${credential.cache}`;
	const query = `region=${target.region}&endpoint=${target.endpoint}&addressing-style=path`;

	return [
		`settings caches --add '${bucketUrl}?${query}'`,
		`settings access-tokens --add '${bucketUrl}=${credential.accessKeyId}:${credential.secretAccessKey}'`
	];
}

function tenantSlugFromUrl(url: URL): string {
	const segments = url.pathname.split('/').filter(Boolean);
	const tenantIndex = segments.indexOf('t');
	const slug = tenantIndex === -1 ? undefined : segments[tenantIndex + 1];

	return slug ?? segments.at(-1) ?? '';
}

function summaryRow(summary: S3CredentialSummary): ResultRow {
	const expiry =
		summary.expiresAt === undefined
			? ''
			: `; expires ${formatTimestamp(summary.expiresAt)}`;

	const access = summary.writable ? 'writable' : 'read-only';

	return {
		label: summary.accessKeyId,
		value: `${cacheLabel(summary.cache)}; ${summary.label}; ${access}; created ${formatTimestamp(summary.createdAt)}${expiry}`
	};
}

function cacheLabel(name: string): string {
	return name === DEFAULT_CACHE ? '(default)' : name;
}
