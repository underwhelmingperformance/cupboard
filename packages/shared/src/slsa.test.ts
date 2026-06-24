import { describe, expect, it } from 'vitest';

import { slsaSourceCommit } from './slsa.ts';

function provenance(dependencies: readonly unknown[]): Record<string, unknown> {
	return { buildDefinition: { resolvedDependencies: dependencies } };
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
	])('reads the commit from the dependency matching %s', (_name, uri) => {
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
