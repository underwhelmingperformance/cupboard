import { readFile } from 'node:fs/promises';
import { env } from 'node:process';

import { type StoredCache } from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import { buildReceiptSchema } from '@cupboard/protocol/build';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import type { Command } from 'commander';

import { runCupboard as defaultRunCupboard } from '../cupboard-run.ts';
import { InvalidInputError, MissingInputError } from '../errors.ts';
import { type Environment } from '../inputs.ts';
import {
	collectLines,
	provided,
	providedCache,
	providedUrl
} from '../options.ts';

export interface AttestAttachOptions {
	readonly url?: string;
	readonly cupboardPath?: string;
	readonly cache?: string;
	readonly audience?: string;
	readonly receiptFile?: string;
	readonly bundle: readonly string[];
}

export interface AttestAttachInputs {
	readonly url: URL;
	readonly cupboardPath: string;
	readonly cache: StoredCache;
	readonly audience: string;
	readonly receiptFile: string;
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
		.requiredOption(
			'--receipt-file <path>',
			'current-run receipt produced by the build action'
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

	if (options.bundle.length === 0) {
		throw new InvalidInputError(
			'bundle',
			'bundle is required and must name at least one attestation bundle'
		);
	}

	return {
		url,
		cupboardPath,
		cache: providedCache(options.cache),
		audience: provided(options.audience) ?? '',
		receiptFile,
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

	for (const bundle of inputs.bundles) {
		arguments_.push('--attestation', bundle);
	}

	return arguments_;
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

	if (receipt.paths.length === 0) {
		reporter.warn(
			'The build receipt records no published paths; nothing to attach'
		);
		return;
	}

	const runCupboard = dependencies.runCupboard ?? defaultRunCupboard;

	await runCupboard(
		inputs.cupboardPath,
		attestAttachArguments(inputs, receipt.paths),
		environment
	);
}
