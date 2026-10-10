import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env } from 'node:process';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { StorePath } from '@cupboard/nix-store/store-path';
import { canonicalHref } from '@cupboard/nix-store/url';
import { attestationInfoEntrySchema } from '@cupboard/protocol/attestations';
import { buildReceiptSchema } from '@cupboard/protocol/build';
import {
	createGithubReporter,
	formatCount,
	type Reporter,
	ResultLink,
	ResultTable
} from '@cupboard/reporter';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { CodedError, UsageError } from '@cupboard/shared/errors';
import { type Command } from 'commander';
import { z } from 'zod';

import { runCupboard } from '../cupboard-run.ts';
import {
	MissingInputError,
	ReadPasswordRequiredError,
	ReadUserRequiredError,
	SubjectNarHashMovedError
} from '../errors.ts';
import { type Environment, parseLines } from '../inputs.ts';
import {
	provided,
	providedCacheSelection,
	providedReadUser,
	providedUrl
} from '../options.ts';
import { cacheUrlFor } from '../substituters.ts';

interface StatusOptions {
	readonly url?: string;
	readonly cache?: string;
	readonly cupboardPath?: string;
	readonly receiptFile?: string;
	readonly bundlesFile?: string;
	readonly readUser?: string;
	readonly readPassword?: string;
}

const statusResultSchema = z.object({
	entries: z.array(attestationInfoEntrySchema)
});

class AttestationCoverageReceiptError extends UsageError {
	constructor() {
		super(
			'The publication receipt contains conflicting path identities or subjects outside its path list.'
		);
		this.name = 'AttestationCoverageReceiptError';
	}
}

class AttestationCoverageResultError extends CodedError {
	constructor(options?: ErrorOptions) {
		super(
			'The installed cupboard returned an incomplete or invalid attestation coverage result.',
			options
		);
		this.name = 'AttestationCoverageResultError';
	}

	override get exitCode(): number {
		return 75;
	}
}

export function registerAttestStatusCommand(
	program: Command,
	environment: Environment = env,
	signal?: AbortSignal
): void {
	program
		.command('attest-status')
		.description(
			'Report stored attestation coverage for the published paths in a receipt.'
		)
		.requiredOption('--url <url>', 'destination tenant URL')
		.option('--cache <name>', 'named destination cache')
		.requiredOption('--cupboard-path <path>', 'path to the cupboard executable')
		.requiredOption(
			'--receipt-file <path>',
			'receipt for paths published by this run'
		)
		.option('--bundles-file <path>', 'manifest of bundles signed in this run')
		.option('--read-user <user>', 'destination cache read user')
		.option('--read-password <password>', 'destination cache read password')
		.action((options: StatusOptions) =>
			attestStatusAction(options, environment, createGithubReporter(), signal)
		);
}

async function attestStatusAction(
	options: StatusOptions,
	environment: Environment,
	reporter: Reporter,
	signal?: AbortSignal
): Promise<void> {
	signal?.throwIfAborted();
	const url = providedUrl('url', options.url);
	if (url === undefined) {
		throw new MissingInputError('url');
	}
	const cupboardPath = provided(options.cupboardPath);
	if (cupboardPath === undefined) {
		throw new MissingInputError('cupboard-path');
	}
	const receiptFile = provided(options.receiptFile);
	if (receiptFile === undefined) {
		throw new MissingInputError('receipt-file');
	}
	const readUser = providedReadUser(options.readUser);
	const readPassword = options.readPassword ?? '';
	if (readUser !== '' && readPassword === '') {
		throw new ReadPasswordRequiredError();
	}
	if (readPassword !== '' && readUser === '') {
		throw new ReadUserRequiredError();
	}

	const receipt = buildReceiptSchema.parse(
		JSON.parse(await readFile(receiptFile, 'utf8'))
	);
	const pathSet = new Set(receipt.paths);
	const paths = [...pathSet];
	const pathHashes = paths.map((storePath) => StorePath.hash(storePath));
	const subjects = new Map(
		receipt.subjects.map((subject) => [
			StorePath.hash(subject.storePath),
			subject
		])
	);
	const copiedPaths = new Set(
		receipt.version === 3
			? receipt.subjects
					.filter((subject) => subject.origin === 'copied')
					.map((subject) => StorePath.hash(subject.storePath))
			: []
	);
	if (
		new Set(pathHashes).size !== paths.length ||
		receipt.subjects.some(
			(subject) =>
				!pathSet.has(subject.storePath) ||
				subjects.get(StorePath.hash(subject.storePath))?.narHash !==
					subject.narHash
		)
	) {
		throw new AttestationCoverageReceiptError();
	}
	const freshlySignedDigests = await bundleDigests(
		provided(options.bundlesFile)
	);
	if (paths.length === 0) {
		reporter.warn(
			'The publication receipt contains no paths; skipping attestation coverage.'
		);
		return;
	}
	const destination = cacheUrlFor(url, providedCacheSelection(options.cache));
	const directory = await mkdtemp(
		path.join(environment.RUNNER_TEMP ?? tmpdir(), 'cupboard-coverage-')
	);
	const pathsFile = path.join(directory, 'paths.txt');
	try {
		await writeFile(pathsFile, `${paths.join('\n')}\n`);
		const results = await runCupboard(
			cupboardPath,
			[
				'--no-colour',
				'attest',
				'status',
				canonicalHref(destination),
				'--paths-file',
				pathsFile,
				...(readUser === ''
					? []
					: ['--read-user', readUser, '--read-password', readPassword])
			],
			environment,
			{ signal }
		);
		const event = results.findLast(
			(result) => result.kind === 'attestation-status'
		);
		const parsed = statusResultSchema.safeParse(event?.data);
		if (!parsed.success) {
			throw new AttestationCoverageResultError({ cause: parsed.error });
		}
		const { entries } = parsed.data;
		if (
			entries.length !== paths.length ||
			entries.some((entry, index) => entry.storePathHash !== pathHashes[index])
		) {
			throw new AttestationCoverageResultError();
		}
		for (const entry of entries) {
			const subject = subjects.get(entry.storePathHash);
			if (subject === undefined || entry.status !== 'found') {
				continue;
			}
			const servedHash = NixSha256Hash.parsePrefixed(entry.narHash).digestHex();
			if (servedHash !== subject.narHash) {
				throw new SubjectNarHashMovedError(
					subject.storePath,
					subject.narHash,
					servedHash
				);
			}
		}
		const freshlySigned = entries
			.filter(
				(entry) =>
					entry.status === 'found' &&
					entry.attestations.some((attestation) =>
						freshlySignedDigests.has(attestation.digest)
					)
			)
			.map((entry) => entry.storePathHash);
		const previouslyStored = entries
			.filter(
				(entry) =>
					entry.status === 'found' &&
					!freshlySigned.includes(entry.storePathHash) &&
					entry.attestations.some(
						(attestation) => !freshlySignedDigests.has(attestation.digest)
					)
			)
			.map((entry) => entry.storePathHash);
		const withoutEvidence = entries
			.filter(
				(entry) =>
					entry.status === 'found' &&
					entry.attestations.length === 0 &&
					!copiedPaths.has(entry.storePathHash)
			)
			.map((entry) => entry.storePathHash);
		const fetchedUpstream = entries
			.filter(
				(entry) =>
					entry.status === 'found' &&
					entry.attestations.length === 0 &&
					copiedPaths.has(entry.storePathHash)
			)
			.map((entry) => entry.storePathHash);
		const missing = entries
			.filter((entry) => entry.status === 'missing')
			.map((entry) => entry.storePathHash);
		const categories = [
			{ label: 'Signed this run', hashes: freshlySigned },
			{ label: 'Signed earlier', hashes: previouslyStored },
			{ label: 'Fetched upstream, not attested', hashes: fetchedUpstream },
			{ label: 'Other paths without stored evidence', hashes: withoutEvidence },
			{ label: 'Missing published paths', hashes: missing }
		];
		await reporter.steps('Attestation coverage by path', (steps) => {
			for (const category of categories) {
				if (category.hashes.length === 0) {
					continue;
				}
				const group = steps.group(
					`${category.label}: ${formatCount(category.hashes.length)}`
				);
				for (const hash of category.hashes.slice(0, 20)) {
					const storePath = paths[pathHashes.indexOf(hash)] ?? hash;
					group.message(storePath);
				}
				group.success(
					category.hashes.length > 20
						? `${formatCount(category.hashes.length - 20)} additional ${category.hashes.length === 21 ? 'path' : 'paths'} in the machine result.`
						: `${formatCount(category.hashes.length)} ${category.hashes.length === 1 ? 'path' : 'paths'} in this category.`
				);
			}
		});
		reporter.result({
			kind: 'publication-attestation-coverage',
			title: 'Published attestation coverage (not verified)',
			jobSummary: true,
			table: ResultTable.of(
				[
					{ key: 'path', label: 'Path' },
					{ key: 'evidence', label: 'Stored attestation' }
				],
				entries.slice(0, 20).map((entry, index) => {
					const digest =
						entry.status === 'found'
							? entry.attestations[0]?.digest
							: undefined;
					return {
						path: paths[index] ?? entry.storePathHash,
						evidence:
							digest === undefined
								? entry.status === 'missing'
									? 'Missing published path'
									: 'No stored evidence'
								: new ResultLink(
										'Bundle',
										new URL(
											`${canonicalHref(destination)}/attestation-bundles/${digest}`
										)
									)
					};
				})
			),
			...(entries.length > 20 && {
				note: [
					`Showing 20 of ${formatCount(entries.length)} paths. The machine result contains every path.`
				]
			}),
			data: {
				entries,
				freshlySigned,
				previouslyStored,
				withoutEvidence,
				fetchedUpstream,
				missing
			},
			rows: [
				{
					label: 'Freshly signed and stored paths',
					value: formatCount(freshlySigned.length)
				},
				{
					label: 'Paths with previously stored evidence',
					value: formatCount(previouslyStored.length)
				},
				{
					label: 'Fetched upstream, not attested',
					value: formatCount(fetchedUpstream.length)
				},
				{
					label: 'Other paths without stored evidence',
					value: formatCount(withoutEvidence.length)
				},
				{ label: 'Missing published paths', value: formatCount(missing.length) }
			]
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function bundleDigests(manifest?: string): Promise<ReadonlySet<string>> {
	if (manifest === undefined) {
		return new Set();
	}
	const files = parseLines(await readFile(manifest, 'utf8'));
	return new Set(
		await mapWithConcurrency(files, 6, async (file) =>
			createHash('sha256')
				.update(await readFile(file))
				.digest('hex')
		)
	);
}
