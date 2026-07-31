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
			[
				...Array.from({ length: 2 }, () => ({
					uses: '- uses: ./.cupboard/actions/setup',
					expectedSourceCommit:
						'expected-source-commit: ${{ job.workflow_sha }}'
				})),
				...Array.from({ length: 1 }, () => ({
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
			...Array.from({ length: 1 }, () => ({
				file: 'cupboard-flake-publish.yml',
				receipt: 'receipt-file: ${{ steps.build.outputs.receipt-file }}'
			})),
			{
				file: 'cupboard-publish.yml',
				receipt: 'receipt-file: ${{ steps.build.outputs.receipt-file }}'
			}
		]);
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
