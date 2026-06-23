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
	it('matches the workflow file at any ref when the value carries no @ref', () => {
		expect(
			jobWorkflowReferenceClaim('acme/infra/.github/workflows/publish.yml')
		).toStrictEqual({
			pattern: String.raw`^acme/infra/\.github/workflows/publish\.yml@.+$`
		});
	});

	it('matches exactly when the value carries an @ref', () => {
		const value = 'acme/infra/.github/workflows/publish.yml@refs/heads/main';

		expect(jobWorkflowReferenceClaim(value)).toBe(value);
	});
});

describe('expandAllow', () => {
	it('expands the shorthands into cache and root actions', () => {
		expect(expandAllow(['push', 'root', 'attest'])).toStrictEqual({
			cacheActions: [
				'upload:negotiate',
				'upload:prepare',
				'upload:status',
				'upload:commit',
				'attestation:negotiate',
				'attestation:prepare',
				'attestation:attach'
			],
			rootActions: ['root:set']
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
				'upload:prepare',
				'upload:status',
				'upload:commit',
				'root:set'
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
				'upload:prepare',
				'upload:status',
				'upload:commit'
			],
			resources: { cache: { exact: '_default', validate: 'cacheName' } }
		});
	});

	it('builds an exact cache grant', () => {
		expect(
			buildCacheGrant({ cache: 'acme-ci', allow: ['push'] })
		).toStrictEqual({
			type: 'cupboard_cache',
			actions: [
				'upload:negotiate',
				'upload:prepare',
				'upload:status',
				'upload:commit'
			],
			resources: { cache: { exact: 'acme-ci', validate: 'cacheName' } }
		});
	});

	it('drops a template variable the cache does not reference', () => {
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
