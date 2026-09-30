import { createOctokitClient } from '@cupboard/shared/octokit';
import { z } from 'zod';

import { AttestationStoreWriteError, MissingInputError } from './errors.ts';
import type { Environment } from './inputs.ts';

const repositoryPattern = /^([\w.-]+)\/([\w.-]+)$/u;
const attestationStoreResponseSchema = z.looseObject({
	id: z.union([z.number(), z.string()])
});
const attestationBundleSchema = z.looseObject({
	mediaType: z.string().optional(),
	verificationMaterial: z.looseObject({}).optional(),
	dsseEnvelope: z.looseObject({}).optional()
});

export interface AttestationStoreWrite {
	readonly bundle: string;
	readonly githubToken: string;
	readonly environment: Environment;
}

export type AttestationStoreWriter = (
	write: AttestationStoreWrite
) => Promise<string>;

function repositoryFrom(environment: Environment): readonly [string, string] {
	const value = environment.GITHUB_REPOSITORY;

	if (value === undefined || value === '') {
		throw new MissingInputError('GITHUB_REPOSITORY');
	}

	const match = repositoryPattern.exec(value);
	const owner = match?.[1];
	const repo = match?.[2];

	if (owner === undefined || repo === undefined) {
		throw new AttestationStoreWriteError(value);
	}

	return [owner, repo];
}

export async function writeToAttestationStore(
	write: AttestationStoreWrite
): Promise<string> {
	const [owner, repo] = repositoryFrom(write.environment);
	const octokit = createOctokitClient({
		replaySafety: 'replay-safe',
		auth: write.githubToken,
		...(write.environment.GITHUB_API_URL !== undefined && {
			baseUrl: write.environment.GITHUB_API_URL
		})
	});

	const document = attestationBundleSchema.parse(JSON.parse(write.bundle));

	try {
		const response = await octokit.request(
			'POST /repos/{owner}/{repo}/attestations',
			{ owner, repo, bundle: document }
		);

		return String(attestationStoreResponseSchema.parse(response.data).id);
	} catch (error) {
		throw new AttestationStoreWriteError(`${owner}/${repo}`, { cause: error });
	}
}
