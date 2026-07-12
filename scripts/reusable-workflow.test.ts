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
});

describe('cupboard flake publish output records', () => {
	it('chooses delimiters that cannot collide with installable records', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');

		expect({
			fixedDelimiters: contents.match(/value<<EOF/gu) ?? [],
			collisionChecks:
				contents.match(
					/for record in "\$\{(?:candidates|attrs)\[@\]\}"; do/gu
				) ?? []
		}).toStrictEqual({
			fixedDelimiters: [],
			collisionChecks: [
				'for record in "${candidates[@]}"; do',
				'for record in "${attrs[@]}"; do'
			]
		});
	});
});
