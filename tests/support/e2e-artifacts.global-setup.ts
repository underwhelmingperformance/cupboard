import type { TestProject } from 'vitest/node';

import { buildEmbeddedPayload } from '../../packages/cli/src/deploy/artifact.ts';
import { createEsbuildBundler } from '../../packages/cli/src/deploy/bundle.ts';

import { buildTestWorkerBundle } from './cupboard-server.ts';
import {
	createEndToEndArtifactRerun,
	EndToEndArtifactRun
} from './e2e-artifacts.ts';
import { buildPredecessorBundles } from './staged-deployment-server.ts';

export default async function setup(
	project: TestProject
): Promise<() => Promise<void>> {
	const run = new EndToEndArtifactRun(project.config.root, {
		currentPayload: (root) =>
			buildEmbeddedPayload(root, createEsbuildBundler()),
		workerBundle: buildTestWorkerBundle,
		predecessorBundles: buildPredecessorBundles
	});
	try {
		project.provide('cupboardEndToEndArtifacts', await run.prepare());
		project.onTestsRerun(
			createEndToEndArtifactRerun(run, (manifest) => {
				project.provide('cupboardEndToEndArtifacts', manifest);
			})
		);
	} catch (error) {
		await run.dispose();
		throw error;
	}

	return () => run.dispose();
}
