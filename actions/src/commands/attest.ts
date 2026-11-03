import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import type { CacheScope } from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	type BuildReceipt,
	buildReceiptSchema,
	type BuildReceiptV2Input,
	type BuildReceiptV3Input
} from '@cupboard/protocol/build';
import { scaiPredicateType } from '@cupboard/protocol/scai';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import { discardResponseBody } from '@cupboard/shared/cleanup';
import { fetchWithProbeRetries } from '@cupboard/shared/paging';
import { retryingFetcher } from '@cupboard/shared/retry';
import type { Command } from 'commander';
import { StatusCodes } from 'http-status-codes';

import type { DestinationAccess } from '../attestation-signing.ts';
import { CacheAccessProbeError, MissingInputError } from '../errors.ts';
import { type Environment, requireEnvironment, setOutput } from '../inputs.ts';
import { provided, providedCacheSelection, providedUrl } from '../options.ts';
import {
	type ReproducedSubject,
	reproductionReport
} from '../reproduction-report.ts';
import { cacheUrlFor } from '../substituters.ts';

interface StorePathDigest {
	readonly storePath: string;
	readonly sha256: string;
}

export interface AttestOptions {
	readonly receiptFile?: string;
	readonly checksumsFile?: string;
	readonly builtChecksumsFile?: string;
	readonly predicateFile?: string;
	readonly url?: string;
	readonly cache?: string;
}

export interface AttestInputs {
	readonly receiptFile: string;
	readonly checksumsFile: string;
	readonly builtChecksumsFile: string;
	readonly predicateFile: string;
	readonly url: URL;
	readonly cache: CacheScope;
}

interface AttestationSubjects {
	readonly subjects: readonly StorePathDigest[];
	readonly built: readonly StorePathDigest[];
	readonly reproduced: readonly ReproducedSubject[];
	readonly skipped: readonly string[];
}

export async function cacheAccess(
	fetcher: typeof fetch,
	cacheUrl: URL
): Promise<DestinationAccess> {
	const target = `${canonicalHref(cacheUrl)}/nix-cache-info`;

	return fetchWithProbeRetries(fetcher, target, undefined, async (response) => {
		await discardResponseBody(response);
		const status: StatusCodes = response.status;

		if (status === StatusCodes.OK) {
			return 'public';
		}

		if (status === StatusCodes.UNAUTHORIZED) {
			return 'private';
		}

		throw new CacheAccessProbeError(target, response.status);
	});
}

/**
For a version 2 receipt, treats every accepted subject as built by this run.
Version 2 did not distinguish other origins.
*/
export function attestationSubjects(
	receipt: BuildReceiptV2Input
): AttestationSubjects {
	const subjects: StorePathDigest[] = [];
	const receiptSubjects = new Map(
		receipt.subjects.map((subject) => [subject.storePath, subject])
	);
	const skipped = receipt.paths.filter(
		(storePath) => !receiptSubjects.has(storePath)
	);

	for (const storePath of receipt.paths) {
		const subject = receiptSubjects.get(storePath);
		if (subject === undefined) {
			continue;
		}

		subjects.push({ storePath, sha256: subject.narHash });
	}

	return { subjects, built: subjects, reproduced: [], skipped };
}

export function provenancedSubjects(
	receipt: BuildReceiptV3Input
): AttestationSubjects {
	const subjects: StorePathDigest[] = [];
	const built: StorePathDigest[] = [];
	const reproduced: ReproducedSubject[] = [];
	const named = new Set(receipt.subjects.map((subject) => subject.storePath));
	const skipped = receipt.paths.filter((storePath) => !named.has(storePath));

	for (const subject of receipt.subjects) {
		const digest = {
			storePath: subject.storePath,
			sha256: subject.narHash
		};

		subjects.push(digest);

		// Build provenance covers the executions this run supervised on the
		// coordinating machine. A verification rebuild counts: the run
		// re-executed the derivation here and Nix matched the stored output.
		// A remote builder's execution and a path attributed to the store's
		// records describe builds this run cannot report on.
		if (!(
			subject.origin === 'built' &&
			subject.verification === 'local' &&
			(subject.machine ?? '') === ''
		)) {
			continue;
		}

		built.push(digest);

		if (subject.reproduced === true) {
			reproduced.push({ ...digest, derivation: subject.derivation });
		}
	}

	return { subjects, built, reproduced, skipped };
}

export function renderChecksums(digests: readonly StorePathDigest[]): string {
	return digests
		.map((digest) => `${digest.sha256}  ${path.basename(digest.storePath)}`)
		.join('\n')
		.concat('\n');
}

export function registerAttestCommand(
	program: Command,
	environment: Environment = env
): void {
	program
		.command('attest')
		.description(
			'Resolve attestation subjects from a current-run build receipt and identify the paths built by this run.'
		)
		.requiredOption(
			'--receipt-file <path>',
			'Resolve the subjects from a current-run receipt produced by the build action.'
		)
		.option(
			'--checksums-file <path>',
			'Write the checksums for all accepted receipt subjects here. Defaults to a unique directory under RUNNER_TEMP.'
		)
		.option(
			'--built-checksums-file <path>',
			'Write the checksums for the accepted subjects this run built here. Defaults to a file beside the checksums file.'
		)
		.option(
			'--predicate-file <path>',
			'Write the SCAI attribute report for reproduced subjects here. Defaults to a file beside the checksums file.'
		)
		.requiredOption(
			'--url <url>',
			"Tenant URL of the destination. The destination cache's access selects the signing defaults."
		)
		.option('--cache <name>', 'Named destination cache.')
		.action((options: AttestOptions) => attestAction(options, environment));
}

export function resolveAttestInputs(
	options: AttestOptions,
	environment: Environment
): AttestInputs {
	const receiptFile = provided(options.receiptFile);
	if (receiptFile === undefined) {
		throw new MissingInputError('receipt-file');
	}
	const url = providedUrl('url', options.url);

	if (url === undefined) {
		throw new MissingInputError('url');
	}

	const checksumsFile =
		provided(options.checksumsFile) ??
		path.join(
			requireEnvironment(environment, 'RUNNER_TEMP'),
			'cupboard-attestations',
			randomUUID(),
			'subjects.txt'
		);

	return {
		receiptFile,
		url,
		cache: providedCacheSelection(options.cache),
		checksumsFile,
		builtChecksumsFile:
			provided(options.builtChecksumsFile) ??
			path.join(path.dirname(checksumsFile), 'built-subjects.txt'),
		predicateFile:
			provided(options.predicateFile) ??
			path.join(path.dirname(checksumsFile), 'attribute-report.json')
	};
}

export interface AttestDependencies {
	readonly fetch?: typeof fetch;
}

function resolveAttestation(receipt: BuildReceipt): AttestationSubjects {
	return receipt.version === 3
		? provenancedSubjects(receipt)
		: attestationSubjects(receipt);
}

export async function attestAction(
	options: AttestOptions,
	environment: Environment = env,
	reporter: Reporter = createGithubReporter(),
	dependencies: AttestDependencies = {}
): Promise<void> {
	const inputs = resolveAttestInputs(options, environment);
	const receipt = buildReceiptSchema.parse(
		JSON.parse(await readFile(inputs.receiptFile, 'utf8'))
	);
	const destinationAccess = await cacheAccess(
		retryingFetcher(dependencies.fetch ?? fetch, 'replay-safe', {
			trustedOrigin: inputs.url.origin
		}),
		cacheUrlFor(inputs.url, inputs.cache)
	);
	const { subjects, built, reproduced, skipped } = resolveAttestation(receipt);

	for (const storePath of skipped) {
		reporter.warn(
			`Not attesting ${storePath}: the receipt records no origin for it`
		);
	}

	const checksumsFile = path.resolve(inputs.checksumsFile);
	const builtChecksumsFile = path.resolve(inputs.builtChecksumsFile);
	const predicateFile = path.resolve(inputs.predicateFile);
	const report =
		reproduced.length === 0
			? undefined
			: reproductionReport(reproduced, subjects.length === 1);

	await mkdir(path.dirname(checksumsFile), { recursive: true });
	await writeFile(checksumsFile, renderChecksums(subjects));
	await mkdir(path.dirname(builtChecksumsFile), { recursive: true });
	await writeFile(builtChecksumsFile, renderChecksums(built));

	if (report !== undefined) {
		await mkdir(path.dirname(predicateFile), { recursive: true });
		await writeFile(predicateFile, `${JSON.stringify(report)}\n`);
	}

	await setOutput(environment, 'checksums-file', checksumsFile);
	await setOutput(environment, 'subject-count', String(subjects.length));
	await setOutput(environment, 'built-checksums-file', builtChecksumsFile);
	await setOutput(environment, 'built-subject-count', String(built.length));
	await setOutput(
		environment,
		'predicate-file',
		report === undefined ? '' : predicateFile
	);
	await setOutput(
		environment,
		'predicate-type',
		report === undefined ? '' : scaiPredicateType
	);
	await setOutput(environment, 'destination-access', destinationAccess);
}
