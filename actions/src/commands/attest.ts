import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { Nix, type NixValidPathInfo } from '@cupboard/nix';
import { workflowCommands } from '@cupboard/shared/github-actions';

import { InvalidInputError } from '../errors.ts';
import {
	type Environment,
	input,
	parseLines,
	requireInput,
	setOutput
} from '../inputs.ts';

const githubActions = workflowCommands();

interface StorePathDigest {
	readonly storePath: string;
	readonly sha256: string;
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

export function attestInputs(environment: Environment): AttestInputs {
	const paths = parseLines(input(environment, 'PATHS'));

	if (paths.length === 0) {
		throw new InvalidInputError(
			'paths',
			'paths is required and must contain at least one path'
		);
	}

	const checksumsFile = input(environment, 'CHECKSUMS_FILE', () =>
		path.join(
			requireInput(environment.RUNNER_TEMP, 'RUNNER_TEMP'),
			'cupboard-attestations',
			'subjects.txt'
		)
	);

	return { paths, checksumsFile };
}

export async function attestAction(
	environment: Environment = env
): Promise<void> {
	const inputs = attestInputs(environment);
	const nix = Nix.open();
	const infos = await Promise.all(
		inputs.paths.map((storePath) => nix.queryPathInfo(storePath))
	);
	const { subjects, skipped } = attestationSubjects(infos);

	for (const storePath of skipped) {
		githubActions.warning(
			`Not attesting ${storePath}: this machine did not build it, so this run cannot claim its provenance`
		);
	}

	const checksumsFile = path.resolve(inputs.checksumsFile);

	await mkdir(path.dirname(checksumsFile), { recursive: true });
	await writeFile(checksumsFile, renderChecksums(subjects));

	await setOutput(environment, 'checksums-file', checksumsFile);
	await setOutput(environment, 'subject-count', String(subjects.length));
}
