import { describe, expect, it } from 'vitest';

import {
	githubWorkflowBuildType,
	isSlsaProvenanceType,
	slsaProvenanceSummary,
	slsaSourceCommit
} from './slsa.ts';

function provenance(dependencies: readonly unknown[]): Record<string, unknown> {
	return {
		buildDefinition: {
			buildType: githubWorkflowBuildType,
			resolvedDependencies: dependencies
		}
	};
}

function fromJson(text: string): unknown {
	return JSON.parse(text);
}

describe('slsaSourceCommit', () => {
	const sourceRepository = 'owner/repo';

	it.each([
		['the source repository exactly', 'git+https://github.com/owner/repo'],
		[
			'the source repository with a ref',
			'git+https://github.com/owner/repo@refs/heads/main'
		]
	])('returns the commit when the dependency identifies %s', (_name, uri) => {
		expect(
			slsaSourceCommit(
				provenance([
					{
						uri: 'git+https://github.com/other/dep',
						digest: { gitCommit: 'wrong' }
					},
					{ uri, digest: { gitCommit: 'abc123' } }
				]),
				sourceRepository
			)
		).toBe('abc123');
	});

	it.each([
		{ name: 'an empty predicate', predicate: {} },
		{ name: 'a non-object predicate', predicate: 'nope' },
		{
			name: 'no dependency matches the source repository',
			predicate: provenance([
				{
					uri: 'git+https://github.com/other/dep',
					digest: { gitCommit: 'abc123' }
				}
			])
		},
		{
			name: 'a dependency shares a prefix but is a different repository',
			predicate: provenance([
				{
					uri: 'git+https://github.com/owner/repository',
					digest: { gitCommit: 'abc123' }
				}
			])
		},
		{
			name: 'more than one dependency matches',
			predicate: provenance([
				{
					uri: 'git+https://github.com/owner/repo@refs/heads/main',
					digest: { gitCommit: 'abc123' }
				},
				{
					uri: 'git+https://github.com/owner/repo@refs/tags/v1',
					digest: { gitCommit: 'def456' }
				}
			])
		},
		{
			name: 'the matching dependency records no commit',
			predicate: provenance([
				{ uri: 'git+https://github.com/owner/repo', digest: {} }
			])
		},
		{
			name: 'the build definition is null',
			predicate: fromJson('{ "buildDefinition": null }')
		},
		{
			name: 'the resolved dependencies are null',
			predicate: fromJson(
				'{ "buildDefinition": { "resolvedDependencies": null } }'
			)
		},
		{
			name: 'the matching dependency has a null digest',
			predicate: fromJson(
				'{ "buildDefinition": { "resolvedDependencies": [{ "uri": "git+https://github.com/owner/repo", "digest": null }] } }'
			)
		},
		{
			name: 'the matching dependency records a null commit',
			predicate: fromJson(
				'{ "buildDefinition": { "resolvedDependencies": [{ "uri": "git+https://github.com/owner/repo", "digest": { "gitCommit": null } }] } }'
			)
		}
	])('returns undefined when $name', ({ predicate }) => {
		expect(slsaSourceCommit(predicate, sourceRepository)).toBeUndefined();
	});
});

describe('isSlsaProvenanceType', () => {
	it.each([
		['the v1 type', 'https://slsa.dev/provenance/v1', true],
		['an arbitrary suffix', 'https://slsa.dev/provenance/made-up', false],
		['a lookalike prefix', 'https://slsa.dev/provenance/v1/extra', false]
	])('classifies %s', (_name, predicateType, expected) => {
		expect(isSlsaProvenanceType(predicateType)).toBe(expected);
	});
});

describe('slsaProvenanceSummary', () => {
	const fullPredicate = {
		buildDefinition: {
			buildType: githubWorkflowBuildType,
			externalParameters: {
				workflow: {
					ref: 'refs/heads/main',
					repository: 'https://github.com/owner/repo',
					path: '.github/workflows/build.yml'
				}
			},
			internalParameters: { github: { event_name: 'push' } },
			resolvedDependencies: [
				{
					uri: 'git+https://github.com/owner/repo@refs/heads/main',
					digest: { gitCommit: 'abc123' }
				}
			]
		},
		runDetails: {
			builder: { id: 'https://github.com/actions/runner/github-hosted' },
			metadata: {
				invocationId: 'https://github.com/owner/repo/actions/runs/42/attempts/1'
			}
		}
	};

	it('summarises the build identity of a full provenance predicate', () => {
		expect(slsaProvenanceSummary(fullPredicate)).toStrictEqual({
			builder: 'https://github.com/actions/runner/github-hosted',
			sourceRepository: 'https://github.com/owner/repo',
			sourceRef: 'refs/heads/main',
			sourceRevision: 'abc123',
			workflow: '.github/workflows/build.yml',
			buildTrigger: 'push',
			invocationId: 'https://github.com/owner/repo/actions/runs/42/attempts/1'
		});
	});

	it('omits fields the predicate does not record', () => {
		expect(
			slsaProvenanceSummary({
				buildDefinition: {
					buildType: githubWorkflowBuildType,
					externalParameters: {
						workflow: { repository: 'https://github.com/owner/repo' }
					}
				}
			})
		).toStrictEqual({ sourceRepository: 'https://github.com/owner/repo' });
	});

	it('does not project GitHub fields from another build type', () => {
		expect(
			slsaProvenanceSummary({
				...fullPredicate,
				buildDefinition: {
					...fullPredicate.buildDefinition,
					buildType: 'https://example.test/build/v1'
				}
			})
		).toBeUndefined();
	});

	it.each([
		{ name: 'an empty predicate', predicate: {} },
		{ name: 'a non-object predicate', predicate: 'nope' },
		{
			name: 'a null build definition',
			predicate: fromJson('{ "buildDefinition": null }')
		}
	])('returns undefined for $name', ({ predicate }) => {
		expect(slsaProvenanceSummary(predicate)).toBeUndefined();
	});
});
