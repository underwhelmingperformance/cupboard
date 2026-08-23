import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ResolvedCupboard } from '../cupboard-resolution.ts';

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
			{ resolve }
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
});
