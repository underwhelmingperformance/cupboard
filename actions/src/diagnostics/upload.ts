import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { DefaultArtifactClient } from '@actions/artifact';
import { getState } from '@actions/core';
import { configureLogging, rootLogger } from '@cupboard/logger';

import { diagnosticsOwnerState } from './logging.ts';

const uploadChoiceKey = 'CUPBOARD_DIAGNOSTICS_ARTIFACT';
const maximumRetentionDays = 5;

/**
Returns five days, or the repository's artifact retention from
`GITHUB_RETENTION_DAYS` when that is shorter. The artifact client applies a
shorter repository setting itself, but it also emits a warning annotation, so
the shorter value is passed here.
*/
function artifactRetentionDays(): number {
	const repositoryDays = Math.trunc(
		Number(process.env.GITHUB_RETENTION_DAYS ?? '')
	);

	if (
		Number.isNaN(repositoryDays) ||
		repositoryDays <= 0 ||
		repositoryDays >= maximumRetentionDays
	) {
		return maximumRetentionDays;
	}

	rootLogger().debug('using the repository artifact retention', {
		retentionDays: repositoryDays
	});

	return repositoryDays;
}

/**
Uploads once from the first action's post step, after later post steps finish.
The upload happens when `CUPBOARD_DIAGNOSTICS_ARTIFACT` is unset or `true`.
`false` turns it off. Any other value, including an empty one, also skips the
upload, with a warning.
*/
export async function uploadDiagnostics(): Promise<void> {
	configureLogging();

	const directory = getState(diagnosticsOwnerState);

	if (directory === '') {
		return;
	}

	const choice = process.env[uploadChoiceKey];

	if (choice === 'false') {
		rootLogger().info('diagnostic artifact upload is turned off');
		return;
	}

	if (choice !== undefined && choice !== 'true') {
		rootLogger().warn(
			`not uploading diagnostic logs: ${uploadChoiceKey} must be true or false`
		);
		return;
	}

	try {
		const entries = await readdir(directory, { withFileTypes: true });
		const files = entries
			.filter((entry) => entry.isFile())
			.map((entry) => path.join(directory, entry.name));
		const suffix = path
			.basename(directory)
			.replace('cupboard-diagnostics-', '');
		const artifactName = `cupboard-diagnostics-${process.env.GITHUB_JOB ?? 'job'}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}-${suffix}`;

		rootLogger().info('uploading diagnostic artifact', { artifactName });

		await new DefaultArtifactClient().uploadArtifact(
			artifactName,
			files,
			directory,
			{ compressionLevel: 0, retentionDays: artifactRetentionDays() }
		);
	} catch (error) {
		rootLogger().warn('could not upload diagnostic logs', { error });
	}
}
