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
	it('checks out local actions at each called workflow commit', async () => {
		const workflows = await Promise.all(
			[flakeWorkflow, publishWorkflow].map(async (file) => {
				const contents = await readFile(file, 'utf8');
				const checkout = actionSteps(
					contents.split('\n'),
					/^ {6}- uses: actions\/checkout@/u
				)[1]?.map((line) => line.trim());

				return {
					file: file.pathname.split('/').at(-1),
					repository: checkout?.find((line) => line.startsWith('repository:')),
					ref: checkout?.find((line) => line.startsWith('ref:'))
				};
			})
		);

		expect(workflows).toStrictEqual([
			{
				file: 'cupboard-flake-publish.yml',
				repository: 'repository: ${{ job.workflow_repository }}',
				ref: 'ref: ${{ job.workflow_sha }}'
			},
			{
				file: 'cupboard-publish.yml',
				repository: 'repository: ${{ job.workflow_repository }}',
				ref: 'ref: ${{ job.workflow_sha }}'
			}
		]);
	});

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
			[
				...Array.from({ length: 4 }, () => ({
					uses: '- uses: ./.cupboard/actions/setup',
					expectedSourceCommit:
						'expected-source-commit: ${{ job.workflow_sha }}'
				})),
				...Array.from({ length: 3 }, () => ({
					uses: '- uses: ./.cupboard/actions/push',
					expectedSourceCommit:
						'expected-source-commit: ${{ job.workflow_sha }}'
				}))
			].toSorted((left, right) => left.uses.localeCompare(right.uses))
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
			...Array.from({ length: 3 }, () => ({
				file: 'cupboard-flake-publish.yml',
				receipt: 'receipt-file: ${{ steps.build.outputs.receipt-file }}'
			})),
			{
				file: 'cupboard-publish.yml',
				receipt: 'receipt-file: ${{ steps.build.outputs.receipt-file }}'
			}
		]);
	});

	it('attests partial seed and fallback publications', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const attestations = actionSteps(
			contents.split('\n'),
			/^\s+- uses: \.\/\.cupboard\/actions\/attest$/u
		)
			.slice(0, 2)
			.map((step) => step.map((line) => line.trim()))
			.map((step) =>
				step.slice(step.indexOf('if:') + 1, step.indexOf('with:')).join(' ')
			);

		expect(attestations).toStrictEqual([
			"${{ inputs.push && steps.installables.outputs.has-installables == 'true' && steps.build.outputs.publication-path-count != '0' }}",
			"${{ inputs.push && steps.build.outputs.publication-path-count != '0' }}"
		]);
	});

	it('publishes the build selection and threads the closure policy', async () => {
		const workflows = await Promise.all(
			[flakeWorkflow, publishWorkflow].map(async (file) => {
				const contents = await readFile(file, 'utf8');

				return {
					file: file.pathname.split('/').at(-1),
					lines: contents.split('\n')
				};
			})
		);
		const pushes = workflows.flatMap(({ file, lines }) =>
			actionSteps(
				lines,
				/^\s+(?:- )?uses: \.\/\.cupboard\/actions\/push$/u
			).map((step) => ({ file, step: step.map((line) => line.trim()) }))
		);

		expect(
			pushes.map(({ file, step }) => {
				const additionalPathsFile = step.findIndex((line) =>
					line.startsWith('additional-paths-file:')
				);

				return {
					file,
					additionalPathsFile: step.slice(
						additionalPathsFile,
						additionalPathsFile + 2
					),
					closure: step.find((line) => line.startsWith('closure:'))
				};
			})
		).toStrictEqual([
			...Array.from({ length: 3 }, () => ({
				file: 'cupboard-flake-publish.yml',
				additionalPathsFile: [
					'additional-paths-file:',
					'${{ steps.build.outputs.publication-paths-file }}'
				],
				closure: 'closure: ${{ inputs.closure }}'
			})),
			{
				file: 'cupboard-publish.yml',
				additionalPathsFile: [
					'additional-paths-file:',
					'${{ steps.build.outputs.publication-paths-file }}'
				],
				closure: 'closure: ${{ inputs.closure }}'
			}
		]);
	});

	it('retains additional-only outputs according to the intermediate policy', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const pushes = actionSteps(
			contents.split('\n'),
			/^\s+- uses: \.\/\.cupboard\/actions\/push$/u
		)
			.slice(0, 2)
			.map((step) => step.map((line) => line.trim()));

		expect(
			pushes.map((push) => ({
				condition: push
					.slice(push.indexOf('if:') + 1, push.indexOf('with:'))
					.join(' '),
				root: push.find((line) => line.startsWith('root:')),
				ttl: push.find((line) => line.startsWith('ttl:')),
				noRetain: push.find((line) => line.startsWith('no-retain:')),
				requireGrace: push.find((line) => line.startsWith('require-grace:'))
			}))
		).toStrictEqual([
			{
				condition:
					"${{ inputs.push && steps.installables.outputs.has-installables == 'true' && steps.build.outputs.publication-path-count != '0' }}",
				root: "root: ${{ !matrix.noRetain && matrix.root || '' }}",
				ttl: "ttl: ${{ !matrix.noRetain && matrix.ttl || '' }}",
				noRetain: 'no-retain: ${{ matrix.noRetain }}',
				requireGrace: 'require-grace: ${{ matrix.requireGrace }}'
			},
			{
				condition:
					"${{ inputs.push && steps.build.outputs.publication-path-count != '0' }}",
				root: "root: ${{ !matrix.noRetain && matrix.root || '' }}",
				ttl: "ttl: ${{ !matrix.noRetain && matrix.ttl || '' }}",
				noRetain: 'no-retain: ${{ matrix.noRetain }}',
				requireGrace: 'require-grace: ${{ matrix.requireGrace }}'
			}
		]);
	});
});

describe('cupboard flake publish output records', () => {
	it('threads an internally generated artifact name through plan consumers', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');

		expect({
			callerInput: contents.includes('      artifact-key:\n'),
			planOutput: contents.includes(
				'      plan-artifact-name: ${{ steps.plan.outputs.plan-artifact-name }}'
			),
			artifactNames:
				contents.match(
					/name: \$\{\{ needs\.plan\.outputs\.plan-artifact-name \}\}/gu
				) ?? [],
			uploadName: contents.includes(
				'name: ${{ steps.plan.outputs.plan-artifact-name }}'
			)
		}).toStrictEqual({
			callerInput: false,
			planOutput: true,
			artifactNames: Array.from(
				{ length: 2 },
				() => 'name: ${{ needs.plan.outputs.plan-artifact-name }}'
			),
			uploadName: true
		});
	});

	it('keeps generated installable lists in runner files', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');

		expect({
			fileOutputs:
				contents.match(/echo "file=\$\{installables_file\}"/gu) ?? [],
			fileInputs:
				contents.match(
					/installables-file: \$\{\{ steps\.installables\.outputs\.file \}\}/gu
				) ?? [],
			inlineOutputs: contents.match(/echo "value<</gu) ?? []
		}).toStrictEqual({
			fileOutputs: Array.from(
				{ length: 2 },
				() => 'echo "file=${installables_file}"'
			),
			fileInputs: Array.from(
				{ length: 2 },
				() => 'installables-file: ${{ steps.installables.outputs.file }}'
			),
			inlineOutputs: []
		});
	});

	it('reuses the seed derivation graph when attributing build outputs', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');

		expect({
			graphEvaluation: contents.includes(
				'if ! nix derivation show -r -- "${attrs[@]}" > "${graph_file}"; then'
			),
			graphOutput: contents.match(/echo "graph-file=\$\{graph_file\}"/gu) ?? [],
			graphInput:
				contents.match(
					/derivation-graph-file: \$\{\{ steps\.installables\.outputs\.graph-file \}\}/gu
				) ?? [],
			mergesWrappedGraphs: contents.includes(
				'derivations: (map(.derivations // .) | add)'
			),
			filtersUncoveredCandidates: contents.includes(
				"'(.derivations // .) | has($path) or has($name)'"
			),
			recordsEmptySelection: contents.includes(
				'echo "has-installables=false" >> "${GITHUB_OUTPUT}"'
			),
			skipsEmptyBuild: contents.includes(
				"if: ${{ steps.installables.outputs.has-installables == 'true' }}"
			)
		}).toStrictEqual({
			graphEvaluation: true,
			graphOutput: ['echo "graph-file=${graph_file}"'],
			graphInput: [
				'derivation-graph-file: ${{ steps.installables.outputs.graph-file }}'
			],
			mergesWrappedGraphs: true,
			filtersUncoveredCandidates: true,
			recordsEmptySelection: true,
			skipsEmptyBuild: true
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
