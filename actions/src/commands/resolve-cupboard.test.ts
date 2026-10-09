import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ResolvedCupboard } from '../cupboard-resolution.ts';
import { recordingGithubReporter } from '../reporter-testing.ts';

import { resolveCupboardAction } from './resolve-cupboard.ts';

describe('resolveCupboardAction', () => {
	it('writes the resolved release to the cupboard job output', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-resolve-'));
		const outputFile = path.join(directory, 'output');
		const cupboard: ResolvedCupboard = {
			kind: 'release',
			repository: 'owner/cupboard',
			tag: 'v1.2.3',
			sourceCommit: 'a'.repeat(40)
		};
		const resolve = vi.fn(() => Promise.resolve(cupboard));
		const { reporter } = recordingGithubReporter();

		await resolveCupboardAction(
			{
				cupboardVersion: '1.2.3',
				workflowRepository: 'owner/cupboard',
				workflowRef:
					'owner/cupboard/.github/workflows/publish.yml@0123456789abcdef',
				workflowSha: 'b'.repeat(40),
				githubToken: 'token',
				githubApiUrl: 'https://github.example/api/v3',
				githubGraphqlUrl: 'https://github.example/api/graphql'
			},
			{ GITHUB_OUTPUT: outputFile },
			{ resolve, reporter }
		);

		expect({
			calls: resolve.mock.calls,
			output: await readFile(outputFile, 'utf8')
		}).toStrictEqual({
			calls: [
				[
					{
						cupboardVersion: '1.2.3',
						includePrereleases: true,
						releaseRepository: 'owner/cupboard',
						githubToken: 'token',
						workflowSha: 'b'.repeat(40),
						workflowRef:
							'owner/cupboard/.github/workflows/publish.yml@0123456789abcdef',
						githubApiUrl: 'https://github.example/api/v3',
						githubGraphqlUrl: 'https://github.example/api/graphql'
					}
				]
			],
			output: `cupboard={"kind":"release","repository":"owner/cupboard","tag":"v1.2.3","sourceCommit":"${'a'.repeat(40)}"}\n`
		});
	});

	it.each([
		{
			name: 'release',
			cupboard: {
				kind: 'release',
				repository: 'owner/cupboard',
				tag: 'vX.Y.Z',
				sourceCommit: 'a'.repeat(40)
			},
			log: [
				'Resolved cupboard',
				'Cupboard: release vX.Y.Z',
				'Repository: owner/cupboard',
				`Commit: ${'a'.repeat(40)}`
			]
		},
		{
			name: 'source commit',
			cupboard: {
				kind: 'source',
				repository: 'owner/cupboard',
				sourceCommit: 'b'.repeat(40)
			},
			log: [
				'Resolved cupboard',
				'Cupboard: built from source',
				'Repository: owner/cupboard',
				`Commit: ${'b'.repeat(40)}`
			]
		}
	] satisfies readonly {
		readonly name: string;
		readonly cupboard: ResolvedCupboard;
		readonly log: readonly string[];
	}[])('prints the resolved $name', async ({ cupboard, log }) => {
		const { reporter, log: written, summary } = recordingGithubReporter();

		await resolveCupboardAction(
			{
				workflowRepository: 'owner/cupboard',
				workflowRef:
					'owner/cupboard/.github/workflows/publish.yml@0123456789abcdef',
				workflowSha: 'b'.repeat(40)
			},
			{},
			{ resolve: () => Promise.resolve(cupboard), reporter }
		);

		expect({ log: written(), summary }).toStrictEqual({
			log: `${log.join('\n')}\n`,
			summary: []
		});
	});
});
