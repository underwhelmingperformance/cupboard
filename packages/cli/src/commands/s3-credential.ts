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
import { tenantRpc } from '../client/orpc.ts';
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
 * The settings for emitting ready-to-paste nixbuild.net configuration after a
 * credential is created. The endpoint and bucket cannot be derived from the
 * admin URL alone, so the caller supplies them.
 */
export interface NixbuildTarget {
	readonly endpoint: string;
	readonly bucket: string;
	readonly region: string;
}

/**
 * The slice of the derived client the S3 credential commands consume, in the
 * contract's input and output shapes; the real `tenantRpc(...).s3Credentials`
 * satisfies it by construction.
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
		.description(
			'Manage the S3-compatible endpoint credentials a cache accepts.'
		);

	credential
		.command('create')
		.description(
			'Provision an S3 credential; the secret access key is shown only once.'
		)
		.argument('<url>', tenantUrlArgument)
		.requiredOption('--label <label>', 'a name to identify the credential by')
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
		.action(async (url: string, options: CreateOptions) => {
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
					cache: options.cache,
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
		.argument('<url>', tenantUrlArgument)
		.action(async (url: string) => {
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
		.argument('<url>', tenantUrlArgument)
		.argument('<access-key-id>', 'the credential access key id')
		.option('-y, --yes', 'revoke without the confirmation prompt')
		.action(
			async (url: string, accessKeyId: string, options: RevokeOptions) => {
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
			}
		);
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

	reporter.info('The secret access key is shown only here; store it now.');

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
		detail: 'Requests signed with this credential are refused once it is gone.'
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
 * The two nixbuild.net `settings` lines for a credential: one registering the
 * cache as an S3 target, one supplying its access token. The endpoint is left
 * unencoded so the value pastes straight into nixbuild's settings.
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

function tenantSlugFromUrl(url: string): string {
	const segments = new URL(url).pathname.split('/').filter(Boolean);
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
