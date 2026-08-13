import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { type StoredCache } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { canonicalHref } from '@cupboard/nix-store/url';
import { buildReceiptSchema } from '@cupboard/protocol/build';
import {
	attestationAttachSummaryResultKind,
	attestationAttachSummarySchema
} from '@cupboard/protocol/reports';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import type { Command } from 'commander';

import { runCupboard as defaultRunCupboard } from '../cupboard-run.ts';
import {
	AttestationAttachmentIncompleteError,
	AttestationAttachmentResultError,
	InvalidInputError,
	MissingInputError
} from '../errors.ts';
import { type Environment } from '../inputs.ts';
import {
	collectLines,
	provided,
	providedCache,
	providedReadUser,
	providedUrl
} from '../options.ts';
import { parseChecksums } from '../release-install.ts';

export interface AttestAttachOptions {
	readonly url?: string;
	readonly cupboardPath?: string;
	readonly cache?: string;
	readonly audience?: string;
	readonly readUser?: string;
	readonly readPassword?: string;
	readonly receiptFile?: string;
	readonly checksumsFile?: string;
	readonly bundle: readonly string[];
}

export interface AttestAttachInputs {
	readonly url: URL;
	readonly cupboardPath: string;
	readonly cache: StoredCache;
	readonly audience: string;
	readonly readUser: string;
	readonly readPassword: string;
	readonly receiptFile: string;
	readonly checksumsFile: string;
	readonly bundles: readonly string[];
}

export interface AttestAttachDependencies {
	readonly runCupboard?: typeof defaultRunCupboard;
}

export function registerAttestAttachCommand(
	program: Command,
	environment: Environment = env
): void {
	program
		.command('attest-attach')
		.description(
			'Attach a signed provenance bundle to the published paths a build receipt records.'
		)
		.requiredOption('--url <url>', 'cupboard Worker URL')
		.requiredOption(
			'--cupboard-path <path>',
			'path to the cupboard binary installed by actions/setup'
		)
		.option('--cache <name>', 'named cache the paths were published to')
		.option('--audience <audience>', 'GitHub OIDC audience (defaults to url)')
		.option('--read-user <user>', 'private-read username')
		.option('--read-password <password>', 'private-read password')
		.requiredOption(
			'--receipt-file <path>',
			'current-run receipt produced by the build action'
		)
		.requiredOption(
			'--checksums-file <path>',
			'subject checksums passed to the signing action'
		)
		.option(
			'--bundle <path>',
			'Sigstore attestation bundle to attach (repeatable, or newline-delimited)',
			collectLines,
			[]
		)
		.action((options: AttestAttachOptions) =>
			attestAttachAction(options, environment)
		);
}

export function resolveAttestAttachInputs(
	options: AttestAttachOptions
): AttestAttachInputs {
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
	const checksumsFile = provided(options.checksumsFile);

	if (checksumsFile === undefined) {
		throw new MissingInputError('checksums-file');
	}

	if (options.bundle.length === 0) {
		throw new InvalidInputError(
			'bundle',
			'bundle is required and must name at least one attestation bundle'
		);
	}

	const readUser = providedReadUser(options.readUser);
	const readPassword = options.readPassword ?? '';

	if (readUser !== '' && readPassword === '') {
		throw new InvalidInputError(
			'read-password',
			'read-password is required when read-user is supplied'
		);
	}

	if (readPassword !== '' && readUser === '') {
		throw new InvalidInputError(
			'read-user',
			'read-user is required when read-password is supplied'
		);
	}

	return {
		url,
		cupboardPath,
		cache: providedCache(options.cache),
		audience: provided(options.audience) ?? '',
		readUser,
		readPassword,
		receiptFile,
		checksumsFile,
		bundles: options.bundle
	};
}

/**
 * The `cupboard attest attach` argv for one receipt's paths: the bundles
 * attach to the already-published paths over GitHub OIDC, so no upload or
 * retention flag travels with it.
 */
export function attestAttachArguments(
	inputs: AttestAttachInputs,
	paths: readonly string[]
): readonly string[] {
	const arguments_ = [
		'--no-colour',
		'attest',
		'attach',
		canonicalHref(inputs.url),
		...paths,
		'--github-oidc'
	];

	if (inputs.audience !== '') {
		arguments_.push('--audience', inputs.audience);
	}

	if (inputs.cache !== '') {
		arguments_.push('--cache', inputs.cache);
	}

	if (inputs.readUser !== '') {
		arguments_.push(
			'--read-user',
			inputs.readUser,
			'--read-password',
			inputs.readPassword
		);
	}

	for (const bundle of inputs.bundles) {
		arguments_.push('--attestation', bundle);
	}

	return arguments_;
}

function requireSettledAttachment(
	results: Awaited<ReturnType<typeof defaultRunCupboard>>,
	paths: readonly string[]
): void {
	const event = results.findLast(
		(result) => result.kind === attestationAttachSummaryResultKind
	);

	if (event === undefined) {
		throw new AttestationAttachmentResultError(
			'The installed cupboard recorded no attestation attachment result'
		);
	}

	const parsed = attestationAttachSummarySchema.safeParse(event.data);
	if (!parsed.success) {
		throw new AttestationAttachmentResultError(
			'The installed cupboard recorded an invalid attestation attachment result',
			{ cause: parsed.error }
		);
	}

	const outcomes = new Map(
		parsed.data.paths.map((item) => [item.storePathHash, item.outcome])
	);
	const unsettled = paths.filter((storePath) => {
		const outcome = outcomes.get(StorePath.hash(storePath));

		return outcome !== 'attached' && outcome !== 'reused';
	});

	if (unsettled.length > 0) {
		throw new AttestationAttachmentIncompleteError(unsettled);
	}
}

export async function attestAttachAction(
	options: AttestAttachOptions,
	environment: Environment = env,
	reporter: Reporter = createGithubReporter(),
	dependencies: AttestAttachDependencies = {}
): Promise<void> {
	const inputs = resolveAttestAttachInputs(options);
	const receipt = buildReceiptSchema.parse(
		JSON.parse(await readFile(inputs.receiptFile, 'utf8'))
	);
	const checksums = parseChecksums(
		await readFile(inputs.checksumsFile, 'utf8')
	);
	const subjectPaths = receipt.subjects.flatMap((subject) =>
		checksums.get(path.basename(subject.storePath)) === subject.narHash
			? [subject.storePath]
			: []
	);

	if (subjectPaths.length === 0) {
		reporter.warn(
			'The build receipt records no provenance subjects; nothing to attach'
		);
		return;
	}

	const runCupboard = dependencies.runCupboard ?? defaultRunCupboard;

	const results = await runCupboard(
		inputs.cupboardPath,
		attestAttachArguments(inputs, subjectPaths),
		environment
	);
	requireSettledAttachment(results, subjectPaths);
}
