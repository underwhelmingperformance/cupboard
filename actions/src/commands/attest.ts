import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { Nix, type NixValidPathInfo } from '@cupboard/nix';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import type { Command } from 'commander';

import { InvalidInputError } from '../errors.ts';
import { type Environment, requireEnvironment, setOutput } from '../inputs.ts';
import { collectLines, provided } from '../options.ts';

interface StorePathDigest {
	readonly storePath: string;
	readonly sha256: string;
}

export interface AttestOptions {
	readonly paths: readonly string[];
	readonly checksumsFile?: string;
}

export interface AttestInputs {
	readonly paths: readonly string[];
	readonly checksumsFile: string;
}

interface AttestationSubjects {
	readonly subjects: readonly StorePathDigest[];
	readonly skipped: readonly string[];
}

/**
 * Partition resolved path infos into attestation subjects and skipped store
 * paths. Only a path the local store registered as ultimately trusted was
 * built by this machine; attesting a substituted or copied path would claim
 * build provenance for bytes the machine merely downloaded, so it is skipped.
 */
export function attestationSubjects(
	infos: readonly NixValidPathInfo[]
): AttestationSubjects {
	const subjects: StorePathDigest[] = [];
	const skipped: string[] = [];

	for (const info of infos) {
		if (!info.ultimate) {
			skipped.push(info.storePath);
			continue;
		}

		subjects.push({
			storePath: info.storePath,
			sha256: info.narHash.digestHex()
		});
	}

	return { subjects, skipped };
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
			'Resolve the attestation subjects for the given store paths this machine built.'
		)
		.option(
			'--paths <path>',
			'local Nix store path, derivation or installable to attest (repeatable, or newline-delimited)',
			collectLines,
			[]
		)
		.option(
			'--checksums-file <path>',
			'where to write the generated subject checksums file'
		)
		.action((options: AttestOptions) => attestAction(options, environment));
}

export function resolveAttestInputs(
	options: AttestOptions,
	environment: Environment
): AttestInputs {
	if (options.paths.length === 0) {
		throw new InvalidInputError(
			'paths',
			'paths is required and must contain at least one path'
		);
	}

	return {
		paths: options.paths,
		checksumsFile:
			provided(options.checksumsFile) ??
			path.join(
				requireEnvironment(environment, 'RUNNER_TEMP'),
				'cupboard-attestations',
				'subjects.txt'
			)
	};
}

export async function attestAction(
	options: AttestOptions,
	environment: Environment = env,
	reporter: Reporter = createGithubReporter()
): Promise<void> {
	const inputs = resolveAttestInputs(options, environment);
	const nix = Nix.open();
	const infos = await Promise.all(
		inputs.paths.map((storePath) => nix.queryPathInfo(storePath))
	);
	const { subjects, skipped } = attestationSubjects(infos);

	for (const storePath of skipped) {
		reporter.warn(
			`Not attesting ${storePath}: this machine did not build it, so this run cannot claim its provenance`
		);
	}

	const checksumsFile = path.resolve(inputs.checksumsFile);

	await mkdir(path.dirname(checksumsFile), { recursive: true });
	await writeFile(checksumsFile, renderChecksums(subjects));

	await setOutput(environment, 'checksums-file', checksumsFile);
	await setOutput(environment, 'subject-count', String(subjects.length));
}
