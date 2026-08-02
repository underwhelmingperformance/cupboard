import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const flakeWorkflow = new URL(
	'../.github/workflows/cupboard-flake-publish.yml',
	import.meta.url
);
const publishWorkflow = new URL(
	'../.github/workflows/cupboard-publish.yml',
	import.meta.url
);

function actionSteps(lines: readonly string[], action: RegExp): string[][] {
	const steps: string[][] = [];

	for (const [index, line] of lines.entries()) {
		if (!action.test(line)) {
			continue;
		}

		const end = lines.findIndex(
			(candidate, candidateIndex) =>
				candidateIndex > index && candidate.startsWith('      - ')
		);
		steps.push(lines.slice(index, end === -1 ? undefined : end));
	}

	return steps;
}

describe('cupboard flake publish release coordinates', () => {
	it('pins every installing action to the called workflow commit', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const lines = contents.split('\n');
		const installs = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard\/actions\/(?:setup|push)$/u
		);

		expect(
			installs
				.map((step) => ({
					uses: step[0]?.trim(),
					expectedSourceCommit: step
						.map((line) => line.trim())
						.find((line) => line.startsWith('expected-source-commit:'))
				}))
				.toSorted(
					(left, right) => left.uses?.localeCompare(right.uses ?? '') ?? 0
				)
		).toStrictEqual(
			Array.from({ length: 2 }, () => ({
				uses: '- uses: ./.cupboard/actions/setup',
				expectedSourceCommit: 'expected-source-commit: ${{ job.workflow_sha }}'
			}))
		);
	});

	it('configures remote builders before evaluating the target manifest', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const lines = contents.split('\n');
		const prepares = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard\/actions\/prepare$/u
		);
		const planPrepare = prepares[0]?.map((line) => line.trim());
		const input = (name: string) =>
			planPrepare?.find((line) => line.startsWith(`${name}:`));

		expect({
			remote: input('remote'),
			builders: input('builders'),
			builderSshKey: input('builder-ssh-key'),
			builderSshConfig: input('builder-ssh-config'),
			builderKnownHosts: input('builder-known-hosts')
		}).toStrictEqual({
			remote: "remote: ${{ inputs.builders != '' }}",
			builders: 'builders: ${{ inputs.builders }}',
			builderSshKey: 'builder-ssh-key: ${{ secrets.builder_ssh_key }}',
			builderSshConfig: 'builder-ssh-config: ${{ secrets.builder_ssh_config }}',
			builderKnownHosts:
				'builder-known-hosts: ${{ inputs.builder-known-hosts }}'
		});
	});
});

describe('cupboard flake publish cohort job', () => {
	it('replaces the target fan-out with a cohort job gated on the cohort matrix', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');

		expect({
			planOutputsCohortMatrix: contents.includes(
				'cohort-matrix: ${{ steps.plan.outputs.cohort-matrix }}'
			),
			planOutputsCohortCount: contents.includes(
				'cohort-count: ${{ steps.plan.outputs.cohort-count }}'
			),
			cohortJob: contents.includes('\n  cohort:\n'),
			gatedOnCohortCount: contents.includes(
				"if: ${{ needs.plan.outputs.cohort-count != '0' }}"
			),
			matrixFromCohortMatrix: contents.includes(
				'matrix: ${{ fromJSON(needs.plan.outputs.cohort-matrix) }}'
			),
			targetJobRemoved: !contents.includes('\n  target:\n'),
			targetMatrixOutputRemoved: !contents.includes('target-matrix:'),
			targetCountOutputRemoved: !contents.includes('target-count:')
		}).toStrictEqual({
			planOutputsCohortMatrix: true,
			planOutputsCohortCount: true,
			cohortJob: true,
			gatedOnCohortCount: true,
			matrixFromCohortMatrix: true,
			targetJobRemoved: true,
			targetMatrixOutputRemoved: true,
			targetCountOutputRemoved: true
		});
	});

	it('builds and publishes through build-cohort alone', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');

		expect({
			usesBuildCohort: contents.includes('./.cupboard/actions/build-cohort'),
			usesPush: contents.includes('./.cupboard/actions/push'),
			usesBuildPaths: contents.includes('./.cupboard/actions/build-paths'),
			rootGroupingStepRemoved: !contents.includes('root-groups')
		}).toStrictEqual({
			usesBuildCohort: true,
			usesPush: false,
			usesBuildPaths: false,
			rootGroupingStepRemoved: true
		});
	});

	it("tolerates a best-effort cohort's failure without failing the run", async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const lines = contents.split('\n');
		const cohortJob = lines.indexOf('  cohort:');
		const nextJob = lines.findIndex(
			(line, index) =>
				index > cohortJob && /^ {2}\S/u.test(line) && line.endsWith(':')
		);

		expect(
			lines
				.slice(cohortJob, nextJob === -1 ? undefined : nextJob)
				.map((line) => line.trim())
				.filter((line) => line.startsWith('continue-on-error:'))
		).toStrictEqual(['continue-on-error: ${{ matrix.bestEffort }}']);
	});

	it('carries no artifact upload or download steps', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');

		expect({
			uploadArtifact: contents.includes('actions/upload-artifact'),
			downloadArtifact: contents.includes('actions/download-artifact')
		}).toStrictEqual({
			uploadArtifact: false,
			downloadArtifact: false
		});
	});

	it('threads the packing opt-in and its capacity through to the plan action', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');

		expect({
			enablePackingWorkflowInput: contents.includes(
				'      enable-packing:\n        description:'
			),
			packCapacityWorkflowInput: contents.includes(
				'      pack-capacity:\n        description:'
			),
			enablePackingActionInput: contents.includes(
				'enable-packing: ${{ inputs.enable-packing }}'
			),
			packCapacityActionInput: contents.includes(
				'pack-capacity: ${{ inputs.pack-capacity }}'
			)
		}).toStrictEqual({
			enablePackingWorkflowInput: true,
			packCapacityWorkflowInput: true,
			enablePackingActionInput: true,
			packCapacityActionInput: true
		});
	});

	it('prices the packing measurement against the store the cohorts build against', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const lines = contents.split('\n');
		const [planStep] = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard\/actions\/plan$/u
		);
		const trimmed = new Set((planStep ?? []).map((line) => line.trim()));

		expect({
			storeThreadedIntoPlan: trimmed.has('store: ${{ inputs.store }}'),
			packingThreadedIntoPlan: trimmed.has(
				'enable-packing: ${{ inputs.enable-packing }}'
			)
		}).toStrictEqual({
			storeThreadedIntoPlan: true,
			packingThreadedIntoPlan: true
		});
	});

	it('threads the remote store into the cohort build', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const lines = contents.split('\n');
		const [buildCohortStep] = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard\/actions\/build-cohort$/u
		);
		const trimmed = (buildCohortStep ?? []).map((line) => line.trim());

		expect({
			storeWorkflowInput: contents.includes(
				'      store:\n        description:'
			),
			storeThreadedIntoBuildCohort: trimmed.includes(
				'store: ${{ inputs.store }}'
			)
		}).toStrictEqual({
			storeWorkflowInput: true,
			storeThreadedIntoBuildCohort: true
		});
	});

	it('threads publication and the shared run root into build-cohort', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');

		expect({
			pushThreaded: contents.includes('push: ${{ inputs.push }}'),
			gcThreaded: contents.includes(
				'gc-between-cohorts: ${{ inputs.gc-between-cohorts }}'
			),
			gcWorkflowInput: contents.includes(
				'      gc-between-cohorts:\n        description:'
			),
			runRootPerRun: contents.includes("format('{0}/_cupboard-run/{1}',"),
			runRootTtlInput: contents.includes(
				'run-root-ttl: ${{ inputs.run-root-ttl }}'
			),
			runRootTtlWorkflowInput: contents.includes(
				'      run-root-ttl:\n        description:'
			)
		}).toStrictEqual({
			pushThreaded: true,
			gcThreaded: true,
			gcWorkflowInput: true,
			runRootPerRun: true,
			runRootTtlInput: true,
			runRootTtlWorkflowInput: true
		});
	});
});

describe('cupboard cohort collection boundary', () => {
	it('collects the local store after the cohort has published and attested', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const lines = contents.split('\n');
		const collect = lines.indexOf('      - name: Collect the local store');
		const attach = lines.indexOf(
			'      - uses: ./.cupboard/actions/attest-attach'
		);
		const step = lines.slice(collect).map((line) => line.trim());
		const releases = step.indexOf('rm -rf -- "${OUT_LINK_DIRECTORY}"');
		const sweeps = step.indexOf('if ! nix store gc; then');

		expect({
			followsTheAttachStep: attach !== -1 && collect > attach,
			gatedOnTheInput: step.includes(
				'if: ${{ !cancelled() && inputs.gc-between-cohorts }}'
			),
			takesTheOutLinksFromBuildCohort: step.includes(
				'${{ steps.build-cohort.outputs.out-link-directory }}'
			),
			releasesTheOutLinksBeforeSweeping:
				releases !== -1 && sweeps !== -1 && releases < sweeps,
			warnsWithoutFailingTheJob: step.some((line) =>
				line.startsWith("echo '::warning::nix store gc failed")
			)
		}).toStrictEqual({
			followsTheAttachStep: true,
			gatedOnTheInput: true,
			takesTheOutLinksFromBuildCohort: true,
			releasesTheOutLinksBeforeSweeping: true,
			warnsWithoutFailingTheJob: true
		});
	});
});

describe('cupboard build provenance', () => {
	it('feeds every bundled attest action a current-run build receipt', async () => {
		const workflows = await Promise.all(
			[flakeWorkflow, publishWorkflow].map(async (file) => {
				const contents = await readFile(file, 'utf8');

				return {
					file: file.pathname.split('/').at(-1),
					lines: contents.split('\n')
				};
			})
		);
		const attestations = workflows.flatMap(({ file, lines }) =>
			actionSteps(
				lines,
				/^\s+(?:- )?uses: \.\/\.cupboard\/actions\/attest$/u
			).map((step) => ({ file, step }))
		);

		expect(
			attestations.map(({ file, step }) => ({
				file,
				receipt: step
					.map((line) => line.trim())
					.find((line) => line.startsWith('receipt-file:'))
			}))
		).toStrictEqual([
			{
				file: 'cupboard-flake-publish.yml',
				receipt: 'receipt-file: ${{ steps.build-cohort.outputs.receipt-file }}'
			},
			{
				file: 'cupboard-publish.yml',
				receipt: 'receipt-file: ${{ steps.build.outputs.receipt-file }}'
			}
		]);
	});

	it('attests the cohort job only when it streamed a build to publish', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');

		expect(
			contents.includes(
				"inputs.push && steps.build-cohort.outputs.receipt-file != ''"
			)
		).toBe(true);
	});

	it('attaches the signed bundle to the published paths after the attest step', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const lines = contents.split('\n');
		const [attachStep] = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard\/actions\/attest-attach$/u
		);
		const trimmed = (attachStep ?? []).map((line) => line.trim());
		const stepText = trimmed.join(' ');

		expect({
			attestStepNamed: contents.includes(
				'- uses: ./.cupboard/actions/attest\n        id: attest\n'
			),
			followsAttest:
				contents.indexOf('./.cupboard/actions/attest-attach') >
				contents.indexOf('./.cupboard/actions/attest\n'),
			gatedLikeAttestPlusBundle: stepText.includes(
				"if: ${{ inputs.push && steps.build-cohort.outputs.receipt-file != '' && steps.attest.outputs.bundle-path != '' }}"
			),
			url: trimmed.includes('url: ${{ inputs.url }}'),
			cupboardPath: trimmed.includes(
				'cupboard-path: ${{ steps.setup.outputs.cupboard-path }}'
			),
			cache: trimmed.includes('cache: ${{ needs.configure.outputs.cache }}'),
			receipt: trimmed.includes(
				'receipt-file: ${{ steps.build-cohort.outputs.receipt-file }}'
			),
			bundle: trimmed.includes(
				'bundle: ${{ steps.attest.outputs.bundle-path }}'
			)
		}).toStrictEqual({
			attestStepNamed: true,
			followsAttest: true,
			gatedLikeAttestPlusBundle: true,
			url: true,
			cupboardPath: true,
			cache: true,
			receipt: true,
			bundle: true
		});
	});
});

describe('cupboard flake publish event preset', () => {
	it('rejects line breaks before writing resolved outputs', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const validation =
			'for name in PRESET CACHE ROOT_PREFIX TTL REUSE_VIEW BRANCH; do';
		const outputWrite = 'echo "cache=${CACHE}"';

		expect({
			validation: contents.includes(validation),
			lineFeed: contents.includes(`"\${!name}" == *$'\\n'*`),
			carriageReturn: contents.includes(`"\${!name}" == *$'\\r'*`),
			beforeOutputs:
				contents.indexOf(validation) < contents.indexOf(outputWrite)
		}).toStrictEqual({
			validation: true,
			lineFeed: true,
			carriageReturn: true,
			beforeOutputs: true
		});
	});

	it('refuses non-pull-request runs outside the trusted branch', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');

		expect({
			branchInput: contents.includes('      branch:\n'),
			trustedRefCheck: contents.includes(
				'elif [ "${REF}" = "refs/heads/${BRANCH}" ]; then'
			),
			unsupportedRefError: contents.includes(
				"preset 'pull-request-and-branch' accepts pull_request runs or refs/heads/${BRANCH}"
			)
		}).toStrictEqual({
			branchInput: true,
			trustedRefCheck: true,
			unsupportedRefError: true
		});
	});
});
