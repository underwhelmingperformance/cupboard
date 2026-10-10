import { env } from 'node:process';

import {
	predicateTypeSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import type { AttestationInfoEntry } from '@cupboard/protocol/attestations';
import {
	formatCount,
	type Reporter,
	type ResultPayload
} from '@cupboard/reporter';
import { type ReadUser } from '@cupboard/shared/http';
import { type Command } from 'commander';

import { readAttestationInfo } from '../attest/status.ts';
import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import { issueGithubReadCredential } from '../auth/github-read-credential.ts';
import {
	type ReadCredentialSessionOptions,
	withRenewingReadCredential
} from '../auth/read-credential-session.ts';
import { cacheTargetFromUrl } from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
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
	programOptions: ProgramOptions,
	renewal: Pick<ReadCredentialSessionOptions, 'now' | 'wait'> = {}
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
			const credential = readCredentials({
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
			const reporter = commandUi(program, programOptions).reporter();
			const discovery = {
				url: target.tenantUrl,
				cache: target.cache,
				storePathHashes: hashes,
				predicateTypes,
				signal: programOptions.signal
			};
			const entries = await reporter.phase(
				'Reading stored attestation coverage',
				async (phase) => {
					const coverage = await reporter.progress(
						'Checking stored attestation paths',
						{ total: hashes.length },
						async (handle) => {
							let completed = 0;
							const progress = {
								...discovery,
								onProgress: (count: number) => {
									if (count <= completed) {
										return;
									}
									handle.advance(count - completed);
									completed = count;
								}
							};
							return options.githubOidc === true
								? withRenewingReadCredential(
										{
											url: target.tenantUrl,
											...renewal,
											signal: programOptions.signal,
											issue: (signal) =>
												issueGithubReadCredential({
													tenantUrl: target.tenantUrl,
													cache: target.cache,
													audience:
														options.audience ??
														audienceSchema.parse(target.tenantUrl),
													resources: [
														{
															type: 'cupboard_cache',
															cache: target.cache,
															mode: 'content'
														}
													],
													now: renewal.now,
													signal
												})
										},
										({ netrcFile, signal }) =>
											readAttestationInfo({ ...progress, netrcFile, signal })
									)
								: readAttestationInfo({
										...progress,
										readUser: credential?.user,
										readPassword: credential?.password
									});
						}
					);
					await reportCoveragePaths(reporter, coverage, requested);
					phase.result(coverageResult(coverage));

					return coverage;
				}
			);

			const covered = entries.filter((entry) => isCovered(entry));
			if (options.requireAll === true && covered.length !== entries.length) {
				throw new AttestationCoverageIncompleteError(
					entries.length - covered.length
				);
			}
		});
}

function isCovered(entry: AttestationInfoEntry): boolean {
	return entry.status === 'found' && entry.attestations.length > 0;
}

function coverageResult(
	entries: readonly AttestationInfoEntry[]
): ResultPayload {
	const covered = entries.filter((entry) => isCovered(entry));
	const withoutEvidence = entries.filter(
		(entry) => entry.status === 'found' && entry.attestations.length === 0
	);
	const missing = entries.filter((entry) => entry.status === 'missing');

	return {
		kind: 'attestation-status',
		title: 'Stored attestations (not verified)',
		data: {
			entries,
			covered: covered.map((entry) => entry.storePathHash),
			withoutEvidence: withoutEvidence.map((entry) => entry.storePathHash),
			missing: missing.map((entry) => entry.storePathHash)
		},
		rows: [
			{
				label: 'Paths with matching stored attestations',
				value: formatCount(covered.length)
			},
			{
				label: 'Paths without matching evidence',
				value: formatCount(withoutEvidence.length)
			},
			{ label: 'Missing paths', value: formatCount(missing.length) }
		]
	};
}

async function reportCoveragePaths(
	reporter: Reporter,
	entries: readonly AttestationInfoEntry[],
	requested: readonly string[]
): Promise<void> {
	const rows = entries.map((entry) => ({
		label:
			requested.find((path) => path.includes(entry.storePathHash)) ??
			entry.storePathHash,
		value:
			entry.status === 'missing'
				? 'Missing published path'
				: entry.attestations.length === 0
					? 'No matching stored evidence'
					: `${formatCount(entry.attestations.length)} matching stored ${entry.attestations.length === 1 ? 'attestation' : 'attestations'}`
	}));
	await reporter.steps(
		'Stored attestation paths',
		(steps) => {
			for (const row of rows.slice(0, 20)) {
				steps.message(`${row.label}: ${row.value}`);
			}
			if (rows.length > 20) {
				steps.message(
					`${formatCount(rows.length - 20)} additional ${rows.length === 21 ? 'path' : 'paths'} in the machine result.`
				);
			}
		},
		{ showMessages: true }
	);
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
