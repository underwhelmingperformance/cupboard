import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env } from 'node:process';

import { type CacheScope } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { canonicalHref } from '@cupboard/nix-store/url';
import { type AccessKeySecret } from '@cupboard/protocol/access-keys';
import { buildReceiptSchema } from '@cupboard/protocol/build';
import {
	attestationAttachSummaryResultKind,
	attestationAttachSummarySchema
} from '@cupboard/protocol/reports';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import type { Command } from 'commander';

import {
	accessKeyInvocation,
	type CacheSelectionSyntax,
	cacheSelectionSyntax,
	type CupboardInvocation,
	detectCacheSelectionSyntax,
	inspectCommandOptions,
	inspectCupboardVersion,
	requireAccessKeySupport,
	resolveAccessKey,
	runCupboard as defaultRunCupboard
} from '../cupboard-run.ts';
import {
	AttestationAttachmentCapabilitiesError,
	AttestationAttachmentIncompleteError,
	AttestationAttachmentResultError,
	AttestationBundlesMissingError,
	AttestationChecksumsMismatchError,
	MissingInputError
} from '../errors.ts';
import { type Environment, parseLines } from '../inputs.ts';
import {
	collectLines,
	provided,
	providedAccessKey,
	providedCacheSelection,
	providedUrl
} from '../options.ts';
import { parseChecksums } from '../release-install.ts';
import { assertReleasePlatformSupported } from '../release-platform.ts';
import { cacheUrlFor } from '../substituters.ts';

export interface AttestAttachOptions {
	readonly url?: string;
	readonly cupboardPath?: string;
	readonly cache?: string;
	readonly audience?: string;
	readonly receiptFile?: string;
	readonly checksumsFile?: string;
	readonly bundle: readonly string[];
	readonly bundlesFile?: string;
}

export interface AttestAttachInputs {
	readonly url: URL;
	readonly cupboardPath: string;
	readonly cache: CacheScope;
	readonly audience: string;
	readonly accessKey: AccessKeySecret | '';
	readonly receiptFile: string;
	readonly checksumsFile: string;
	readonly bundles: readonly string[];
	readonly bundlesFile: string;
}

export interface AttestAttachDependencies {
	readonly detectCacheSelectionSyntax?: typeof detectCacheSelectionSyntax;
	readonly inspectCommandOptions?: typeof inspectCommandOptions;
	readonly inspectVersion?: typeof inspectCupboardVersion;
	readonly runCupboard?: typeof defaultRunCupboard;
	readonly signal?: AbortSignal;
}

interface AttestationManifests {
	readonly pathsFile: string;
	readonly bundlesFile: string;
}

export function registerAttestAttachCommand(
	program: Command,
	environment: Environment = env,
	signal?: AbortSignal
): void {
	program
		.command('attest-attach')
		.description(
			'Attach signed attestation bundles to the published subjects in a build receipt.'
		)
		.requiredOption('--url <url>', 'cupboard Worker URL')
		.requiredOption(
			'--cupboard-path <path>',
			'path to the cupboard binary installed by actions/setup'
		)
		.option('--cache <name>', 'named cache that received the paths')
		.option('--audience <audience>', 'GitHub OIDC audience (defaults to url)')
		.requiredOption(
			'--receipt-file <path>',
			'receipt for paths published by this run'
		)
		.requiredOption(
			'--checksums-file <path>',
			'checksums for the receipt subjects selected for signing'
		)
		.option(
			'--bundle <path>',
			'Sigstore attestation bundle to attach (repeatable, or newline-delimited)',
			collectLines,
			[]
		)
		.option(
			'--bundles-file <path>',
			'Read bundle paths from this file, one per line'
		)
		.action((options: AttestAttachOptions) =>
			attestAttachAction(options, environment, undefined, {
				...(signal !== undefined && { signal })
			})
		);
}

export function resolveAttestAttachInputs(
	options: AttestAttachOptions,
	environment: Environment = {}
): AttestAttachInputs {
	const url = providedUrl('url', options.url);

	if (url === undefined) {
		throw new MissingInputError('url');
	}

	const cupboardPath = provided(options.cupboardPath);

	if (cupboardPath === undefined) {
		throw new MissingInputError('cupboard-path');
	}

	assertReleasePlatformSupported();

	const receiptFile = provided(options.receiptFile);
	if (receiptFile === undefined) {
		throw new MissingInputError('receipt-file');
	}

	const checksumsFile = provided(options.checksumsFile);

	if (checksumsFile === undefined) {
		throw new MissingInputError('checksums-file');
	}

	const bundlesFile = provided(options.bundlesFile) ?? '';

	if (bundlesFile === '' && options.bundle.length === 0) {
		throw new AttestationBundlesMissingError();
	}

	return {
		url,
		cupboardPath,
		cache: providedCacheSelection(options.cache),
		audience: provided(options.audience) ?? '',
		accessKey: resolveAccessKey(
			providedAccessKey('access-key', environment.ACCESS_KEY),
			environment,
			'cache'
		),
		receiptFile,
		checksumsFile,
		bundles: options.bundle,
		bundlesFile
	};
}

/**
Attaching uses the access key when the action has one, and GitHub OIDC
otherwise. It operates on paths already published by the run, so the command
must not include upload or retention flags.
*/
export function attestAttachInvocation(
	inputs: AttestAttachInputs,
	paths: readonly string[],
	cacheSyntax: CacheSelectionSyntax,
	manifests?: AttestationManifests
): CupboardInvocation {
	const credential = accessKeyInvocation(inputs.accessKey);
	const arguments_ = [
		'--no-colour',
		'attest',
		'attach',
		canonicalHref(
			cacheSyntax === 'flag'
				? inputs.url
				: cacheUrlFor(inputs.url, inputs.cache)
		),
		...(manifests === undefined
			? paths
			: ['--paths-file', manifests.pathsFile]),
		...(inputs.accessKey === ''
			? [
					'--github-oidc',
					...(inputs.audience === '' ? [] : ['--audience', inputs.audience])
				]
			: []),
		...(cacheSyntax === 'flag' && inputs.cache.kind === 'named'
			? ['--cache', inputs.cache.name]
			: []),
		...credential.arguments,
		...(manifests === undefined
			? inputs.bundles.flatMap((bundle) => ['--attestation', bundle])
			: ['--attestations-file', manifests.bundlesFile])
	];

	return { arguments: arguments_, environment: credential.environment };
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
			'The installed cupboard emitted no attestation attachment result'
		);
	}

	const parsed = attestationAttachSummarySchema.safeParse(event.data);
	if (!parsed.success) {
		throw new AttestationAttachmentResultError(
			'The installed cupboard emitted an invalid attestation attachment result',
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
	dependencies.signal?.throwIfAborted();

	const inputs = resolveAttestAttachInputs(options, environment);

	if (inputs.accessKey !== '') {
		await requireAccessKeySupport(
			inputs.cupboardPath,
			dependencies.inspectVersion ?? inspectCupboardVersion,
			dependencies.signal
		);
	}

	const receipt = buildReceiptSchema.parse(
		JSON.parse(await readFile(inputs.receiptFile, 'utf8'))
	);
	const eligible = receipt.subjects;
	const checksums = parseChecksums(
		await readFile(inputs.checksumsFile, 'utf8')
	);
	const selected = eligible.filter((subject) =>
		checksums.has(path.basename(subject.storePath))
	);
	const mismatched = selected
		.filter(
			(subject) =>
				checksums.get(path.basename(subject.storePath)) !== subject.narHash
		)
		.map((subject) => subject.storePath);
	const eligibleNames = new Set(
		eligible.map((subject) => path.basename(subject.storePath))
	);
	const unexpectedNames = checksums
		.keys()
		.filter((name) => !eligibleNames.has(name))
		.toArray();

	const missing =
		receipt.version === 2
			? eligible
					.filter((subject) => !checksums.has(path.basename(subject.storePath)))
					.map((subject) => subject.storePath)
			: [];

	if (
		mismatched.length > 0 ||
		missing.length > 0 ||
		unexpectedNames.length > 0
	) {
		throw new AttestationChecksumsMismatchError(
			[...mismatched, ...missing],
			unexpectedNames
		);
	}

	const subjectPaths = selected.map((subject) => subject.storePath);

	if (subjectPaths.length === 0) {
		reporter.warn(
			'The checksums file selects no receipt subjects; skipping attestation attachment'
		);
		return;
	}

	const runCupboard = dependencies.runCupboard ?? defaultRunCupboard;
	const bundles = [
		...inputs.bundles,
		...(inputs.bundlesFile === ''
			? []
			: parseLines(await readFile(inputs.bundlesFile, 'utf8')))
	];
	if (bundles.length === 0) {
		throw new AttestationBundlesMissingError();
	}

	const directArguments = attestAttachInvocation(
		inputs,
		subjectPaths,
		'flag'
	).arguments;
	const canUseLegacyArguments =
		inputs.bundlesFile === '' &&
		subjectPaths.length === 1 &&
		Buffer.byteLength(directArguments.join('\0')) <= 64 * 1024;

	if (canUseLegacyArguments) {
		const syntax =
			inputs.cache.kind === 'default'
				? 'url'
				: await (
						dependencies.detectCacheSelectionSyntax ??
						detectCacheSelectionSyntax
					)(inputs.cupboardPath, ['attest', 'attach'], dependencies.signal);
		const invocation = attestAttachInvocation(inputs, subjectPaths, syntax);
		const results = await runCupboard(
			inputs.cupboardPath,
			invocation.arguments,
			{ ...environment, ...invocation.environment },
			dependencies.signal === undefined ? {} : { signal: dependencies.signal }
		);
		requireSettledAttachment(results, subjectPaths);
		return;
	}

	const commandOptions = await (
		dependencies.inspectCommandOptions ?? inspectCommandOptions
	)(inputs.cupboardPath, ['attest', 'attach'], dependencies.signal);
	const missingOptions = ['--paths-file', '--attestations-file'].filter(
		(option) => !commandOptions.has(option)
	);
	if (missingOptions.length > 0) {
		throw new AttestationAttachmentCapabilitiesError(missingOptions);
	}
	const syntax = cacheSelectionSyntax(commandOptions);
	const directory = await mkdtemp(
		path.join(environment.RUNNER_TEMP ?? tmpdir(), 'cupboard-attach-')
	);
	const manifests = {
		pathsFile: path.join(directory, 'paths.txt'),
		bundlesFile: path.join(directory, 'bundles.txt')
	};

	try {
		await writeFile(manifests.pathsFile, `${subjectPaths.join('\n')}\n`);
		await writeFile(manifests.bundlesFile, `${bundles.join('\n')}\n`);
		dependencies.signal?.throwIfAborted();
		const invocation = attestAttachInvocation(inputs, [], syntax, manifests);
		const results = await runCupboard(
			inputs.cupboardPath,
			invocation.arguments,
			{ ...environment, ...invocation.environment },
			dependencies.signal === undefined ? {} : { signal: dependencies.signal }
		);
		requireSettledAttachment(results, subjectPaths);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
