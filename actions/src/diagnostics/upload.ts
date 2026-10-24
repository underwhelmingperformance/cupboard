import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { DefaultArtifactClient } from '@actions/artifact';
import { getState } from '@actions/core';
import { configureLogging, rootLogger } from '@cupboard/logger';

import { diagnosticsOwnerState } from './logging.ts';

/**
Uploads once from the first action's post step, after later post steps finish.
*/
export async function uploadDiagnostics(): Promise<void> {
	configureLogging();

	const directory = getState(diagnosticsOwnerState);

	if (directory === '') {
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
			{ compressionLevel: 0 }
		);
	} catch (error) {
		rootLogger().warn('could not upload diagnostic logs', { error });
	}
}
