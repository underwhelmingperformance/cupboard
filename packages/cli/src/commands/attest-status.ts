import { env } from 'node:process';

import {
	predicateTypeSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	readTokenBasicUser,
	readTokenPasswordPrefix
} from '@cupboard/protocol/read-access';
import { formatCount } from '@cupboard/reporter';
import { type ReadUser, readUserSchema } from '@cupboard/shared/http';
import { type Command } from 'commander';

import { readAttestationInfo } from '../attest/status.ts';
import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import { fetchGithubOidcToken } from '../auth/github-oidc.ts';
import { cacheTargetFromUrl } from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { CupboardClient } from '../client/client.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { CliError, CliUsageError } from '../errors.ts';
import { parseReadUser } from '../read-user.ts';
import { tenantUrlArgument } from '../url-argument.ts';

import { appendPathFile } from './attest.ts';
import { resolvePushPath } from './push.ts';
import { readCredentials } from './read-credentials.ts';

interface StatusOptions {
	readonly pathsFile?: string;
	readonly predicateType: readonly string[];
	readonly requireAll?: boolean;
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
}

class StatusOptionsError extends CliUsageError {
	constructor(
		message: string,
		override readonly cause?: unknown
	) {
		super(message, { cause });
		this.name = 'StatusOptionsError';
	}
}

class AttestationCoverageIncompleteError extends CliError {
	constructor(uncovered: number) {
		super(
			`${String(uncovered)} requested paths have no matching stored attestation.`
		);
		this.name = 'AttestationCoverageIncompleteError';
	}
}

export function registerAttestStatusCommand(
	attest: Command,
	program: Command,
	programOptions: ProgramOptions
): void {
	attest
		.command('status')
		.description(
			'Discover stored attestation metadata for published paths. Use attest verify to verify bundles.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[paths...]', 'published store paths to inspect')
		.option(
			'--paths-file <path>',
			'read additional store paths from this file, one per line'
		)
		.option(
			'--predicate-type <uri>',
			'match this exact predicate type (repeatable; omitted means all types)',
			(value: string, previous: readonly string[]) => [...previous, value],
			[]
		)
		.option(
			'--require-all',
			'exit one when any requested path has no matching evidence'
		)
		.option(
			'--read-user <user>',
			'private cache read user (default: $CUPBOARD_READ_USER)',
			parseReadUser
		)
		.option(
			'--read-password <password>',
			'private cache read password (default: $CUPBOARD_READ_PASSWORD)'
		)
		.option(
			'--github-oidc',
			'acquire private cache read access with GitHub Actions OIDC'
		)
		.option(
			'--audience <audience>',
			'OIDC audience (default: the tenant URL)',
			parseAudience
		)
		.action(async (url: URL, paths: string[], options: StatusOptions) => {
			const requested = await statusPaths(paths, options.pathsFile);
			const hashes = [
				...new Set(
					requested.map((path) => {
						const resolved = storePathSchema.safeParse(resolvePushPath(path));
						if (!resolved.success) {
							throw new StatusOptionsError(`Invalid store path: ${path}`);
						}
						return StorePath.hash(resolved.data);
					})
				)
			];
			if (hashes.length === 0) {
				throw new StatusOptionsError(
					'Pass at least one store path or --paths-file.'
				);
			}
			const predicateTypes =
				options.predicateType.length === 0
					? undefined
					: options.predicateType.map((value) => {
							const parsed = predicateTypeSchema.safeParse(value);
							if (!parsed.success || !URL.canParse(value)) {
								throw new StatusOptionsError(
									'Pass a valid predicate URI to --predicate-type.'
								);
							}
							return parsed.data;
						});
			const target = cacheTargetFromUrl(url);
			let credential = readCredentials({
				readUser: options.readUser ?? parseReadUser(env.CUPBOARD_READ_USER),
				readPassword: options.readPassword ?? env.CUPBOARD_READ_PASSWORD
			});
			if (credential !== undefined && options.githubOidc === true) {
				throw new StatusOptionsError(
					'--github-oidc cannot be combined with static read credentials. Remove the read credential options and environment variables.'
				);
			}
			if (options.audience !== undefined && options.githubOidc !== true) {
				throw new StatusOptionsError('--audience requires --github-oidc.');
			}
			if (options.githubOidc === true) {
				const client = CupboardClient.fromUrl(target.tenantUrl, {
					cache: target.cache,
					signal: programOptions.signal
				});
				const subject = await fetchGithubOidcToken({
					audience: options.audience ?? audienceSchema.parse(target.tenantUrl),
					signal: programOptions.signal,
					fetcher: client.fetcher,
					environment: {
						requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL,
						requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
					}
				});
				const access = await client.acquireReadAccess(subject, [
					{ type: 'cupboard_cache', cache: target.cache, mode: 'content' }
				]);
				credential = {
					user: readUserSchema.parse(readTokenBasicUser),
					password: `${readTokenPasswordPrefix}${access.access_token}`
				};
			}
			const reporter = commandUi(program, programOptions).reporter();
			const entries = await reporter.phase(
				'Reading stored attestation coverage',
				() =>
					readAttestationInfo({
						url: target.tenantUrl,
						cache: target.cache,
						storePathHashes: hashes,
						predicateTypes,
						readUser: credential?.user,
						readPassword: credential?.password,
						signal: programOptions.signal
					})
			);
			const covered = entries.filter(
				(entry) => entry.status === 'found' && entry.attestations.length > 0
			);
			const withoutEvidence = entries.filter(
				(entry) => entry.status === 'found' && entry.attestations.length === 0
			);
			const missing = entries.filter((entry) => entry.status === 'missing');
			reporter.result({
				kind: 'attestation-status',
				data: {
					entries,
					covered: covered.map((entry) => entry.storePathHash),
					withoutEvidence: withoutEvidence.map((entry) => entry.storePathHash),
					missing: missing.map((entry) => entry.storePathHash)
				},
				rows: [
					{ label: 'Covered paths', value: formatCount(covered.length) },
					{
						label: 'Paths without matching evidence',
						value: formatCount(withoutEvidence.length)
					},
					{ label: 'Missing paths', value: formatCount(missing.length) },
					...entries.map((entry) => ({
						label:
							requested.find((path) => path.includes(entry.storePathHash)) ??
							entry.storePathHash,
						value:
							entry.status === 'missing'
								? 'Missing published path'
								: entry.attestations.length === 0
									? 'No matching stored evidence'
									: `${formatCount(entry.attestations.length)} matching stored attestations`
					}))
				]
			});
			if (options.requireAll === true && covered.length !== entries.length) {
				throw new AttestationCoverageIncompleteError(
					entries.length - covered.length
				);
			}
		});
}

async function statusPaths(
	paths: readonly string[],
	pathsFile?: string
): Promise<readonly string[]> {
	try {
		return await appendPathFile(paths, pathsFile);
	} catch (error) {
		throw new StatusOptionsError(
			`Cannot read --paths-file ${pathsFile ?? ''}. Check that the file exists and is readable.`,
			error
		);
	}
}
