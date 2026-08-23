import { describe, expect, it } from 'vitest';

import {
	buildCacheGrant,
	collectSubstitutions,
	DuplicateCaptureVariableError,
	expandAllow,
	InvalidCaptureSpecError,
	jobWorkflowReferenceClaim,
	parseCapture,
	UnknownAllowError,
	UnknownTemplateSourceError
} from './rule-builder.ts';

describe('jobWorkflowReferenceClaim', () => {
	it('matches the workflow file at any ref when the value omits @ref', () => {
		expect(
			jobWorkflowReferenceClaim('acme/infra/.github/workflows/publish.yml')
		).toStrictEqual({
			pattern: String.raw`^acme/infra/\.github/workflows/publish\.yml@.+$`
		});
	});

	it('matches exactly when the value includes @ref', () => {
		const value = 'acme/infra/.github/workflows/publish.yml@refs/heads/main';

		expect(jobWorkflowReferenceClaim(value)).toBe(value);
	});

	it('matches the tag namespace when the ref is a tag pattern', () => {
		expect(
			jobWorkflowReferenceClaim(
				'acme/infra/.github/workflows/publish.yml@refs/tags/v*'
			)
		).toStrictEqual({
			pattern: String.raw`^acme/infra/\.github/workflows/publish\.yml@refs/tags/v[^/]*$`
		});
	});
});

describe('expandAllow', () => {
	it('expands the shorthands into cache and root actions', () => {
		expect(expandAllow(['push', 'root', 'attest', 'attach'])).toStrictEqual({
			cacheActions: [
				'upload:negotiate',
				'upload:status',
				'upload:commit',
				'upload:confirm',
				'attestation:negotiate',
				'attestation:attach'
			],
			rootActions: ['root:set', 'root:list', 'root:attach']
		});
	});

	it('rejects an unknown shorthand', () => {
		expect(() => expandAllow(['delete'])).toThrow(UnknownAllowError);
	});
});

describe('parseCapture', () => {
	it('binds each named group to the claim', () => {
		expect(parseCapture('ref=^refs/pull/(?<pr>[0-9]+)/merge$')).toStrictEqual({
			pr: {
				claim: 'ref',
				capture: { pattern: '^refs/pull/(?<pr>[0-9]+)/merge$', group: 'pr' }
			}
		});
	});

	it('rejects a spec with no separator', () => {
		expect(() => parseCapture('no-equals')).toThrow(InvalidCaptureSpecError);
	});
});

describe('collectSubstitutions', () => {
	it('injects a built-in template source', () => {
		expect(
			collectSubstitutions({ templateSource: 'github-pr', captures: [] })
		).toStrictEqual({
			pr: {
				claim: 'ref',
				capture: { pattern: '^refs/pull/(?<pr>[0-9]+)/merge$', group: 'pr' }
			}
		});
	});

	it('injects the github-tag template source', () => {
		expect(
			collectSubstitutions({ templateSource: 'github-tag', captures: [] })
		).toStrictEqual({
			tag: {
				claim: 'ref',
				capture: {
					pattern: '^refs/tags/(?<tag>[a-z0-9][a-z0-9._-]*)$',
					group: 'tag'
				}
			}
		});
	});

	it('rejects an unknown template source', () => {
		expect(() =>
			collectSubstitutions({ templateSource: 'gitlab-mr', captures: [] })
		).toThrow(UnknownTemplateSourceError);
	});

	it('rejects a variable defined by two captures', () => {
		expect(() =>
			collectSubstitutions({
				templateSource: 'github-pr',
				captures: ['head_ref=^(?<pr>.+)$']
			})
		).toThrow(DuplicateCaptureVariableError);
	});
});

describe('buildCacheGrant', () => {
	it('builds a per-PR cache grant with a same-as-cache root', () => {
		const substitutions = collectSubstitutions({
			templateSource: 'github-pr',
			captures: []
		});

		expect(
			buildCacheGrant({
				cacheTemplate: 'pr-{pr}',
				allow: ['push', 'root'],
				root: 'same-as-cache',
				substitutions
			})
		).toStrictEqual({
			type: 'cupboard_cache',
			actions: [
				'upload:negotiate',
				'upload:status',
				'upload:commit',
				'upload:confirm',
				'root:set',
				'root:list'
			],
			resources: {
				cache: {
					equalsTemplate: 'pr-{pr}',
					substitutions: {
						pr: {
							claim: 'ref',
							capture: {
								pattern: '^refs/pull/(?<pr>[0-9]+)/merge$',
								group: 'pr'
							}
						}
					},
					validate: 'cacheName'
				},
				root: { validate: 'rootName', equalsResource: 'cache' }
			}
		});
	});

	it('defaults to the tenant default cache when none is named', () => {
		expect(buildCacheGrant({ allow: ['push'] })).toStrictEqual({
			type: 'cupboard_cache',
			actions: [
				'upload:negotiate',
				'upload:status',
				'upload:commit',
				'upload:confirm'
			],
			resources: { cache: { exact: '_default', validate: 'cacheName' } }
		});
	});

	it('binds the named root for an attach allowance', () => {
		expect(
			buildCacheGrant({ allow: ['push', 'attach'], root: 'github:acme/ci/' })
		).toStrictEqual({
			type: 'cupboard_cache',
			actions: [
				'upload:negotiate',
				'upload:status',
				'upload:commit',
				'upload:confirm',
				'root:attach'
			],
			resources: {
				cache: { exact: '_default', validate: 'cacheName' },
				root: { validate: 'rootName', exact: 'github:acme/ci/' }
			}
		});
	});

	it('uses the cache binding as the root for an attach-only allowance', () => {
		expect(buildCacheGrant({ allow: ['attach'] })).toStrictEqual({
			type: 'cupboard_cache',
			actions: ['root:attach'],
			resources: {
				cache: { exact: '_default', validate: 'cacheName' },
				root: { validate: 'rootName', equalsResource: 'cache' }
			}
		});
	});

	it('builds an exact cache grant', () => {
		expect(
			buildCacheGrant({ cache: 'acme-ci', allow: ['push'] })
		).toStrictEqual({
			type: 'cupboard_cache',
			actions: [
				'upload:negotiate',
				'upload:status',
				'upload:commit',
				'upload:confirm'
			],
			resources: { cache: { exact: 'acme-ci', validate: 'cacheName' } }
		});
	});

	it('omits unused template substitutions from an exact cache binding', () => {
		const substitutions = collectSubstitutions({
			templateSource: 'github-pr',
			captures: []
		});

		const grant = buildCacheGrant({
			cache: 'fixed',
			allow: ['push'],
			substitutions
		});

		expect(
			grant.type === 'cupboard_cache' && grant.resources.cache
		).toStrictEqual({
			exact: 'fixed',
			validate: 'cacheName'
		});
	});
});
