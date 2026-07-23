import { describe, expect, it } from 'vitest';

import {
	WorkflowReferenceExactRequiredError,
	WorkflowReferenceMalformedError,
	WorkflowReferenceMutableError,
	WorkflowReferenceTagPatternError,
	WorkflowReferenceUnpinnedError
} from '../../errors.ts';

import {
	parseExactWorkflowReference,
	parseWorkflowReference,
	type WorkflowReference,
	workflowReferenceClaim,
	workflowReferenceClaimsOverlap
} from './convention.ts';

const workflowPath = 'acme/app/.github/workflows/publish.yml';

function workflowPatternClaim(glob: string) {
	return workflowReferenceClaim(
		parseWorkflowReference(`${workflowPath}@refs/tags/${glob}`)
	);
}

describe('parseWorkflowReference', () => {
	it.each<[string, string, WorkflowReference]>([
		[
			'a release tag',
			`${workflowPath}@refs/tags/v1.2.3`,
			{
				reference: `${workflowPath}@refs/tags/v1.2.3`,
				owner: 'acme',
				repo: 'app',
				path: '.github/workflows/publish.yml',
				pin: { kind: 'tag', value: 'refs/tags/v1.2.3', tag: 'v1.2.3' }
			}
		],
		[
			'a commit id',
			`${workflowPath}@${'a'.repeat(40)}`,
			{
				reference: `${workflowPath}@${'a'.repeat(40)}`,
				owner: 'acme',
				repo: 'app',
				path: '.github/workflows/publish.yml',
				pin: { kind: 'commit', value: 'a'.repeat(40) }
			}
		],
		[
			'a YAML workflow extension',
			`acme/app/.github/workflows/publish.yaml@${'a'.repeat(40)}`,
			{
				reference: `acme/app/.github/workflows/publish.yaml@${'a'.repeat(40)}`,
				owner: 'acme',
				repo: 'app',
				path: '.github/workflows/publish.yaml',
				pin: { kind: 'commit', value: 'a'.repeat(40) }
			}
		],
		[
			'a tag pattern',
			`${workflowPath}@refs/tags/v*`,
			{
				reference: `${workflowPath}@refs/tags/v*`,
				owner: 'acme',
				repo: 'app',
				path: '.github/workflows/publish.yml',
				pin: { kind: 'tag-pattern', value: 'refs/tags/v*', glob: 'v*' }
			}
		],
		[
			'a tag pattern with a literal suffix',
			`${workflowPath}@refs/tags/v1.*-release`,
			{
				reference: `${workflowPath}@refs/tags/v1.*-release`,
				owner: 'acme',
				repo: 'app',
				path: '.github/workflows/publish.yml',
				pin: {
					kind: 'tag-pattern',
					value: 'refs/tags/v1.*-release',
					glob: 'v1.*-release'
				}
			}
		]
	])('accepts %s', (_name, reference, expected) => {
		expect(parseWorkflowReference(reference)).toStrictEqual(expected);
	});

	it('refuses a bare workflow path', () => {
		let failure: unknown;
		try {
			parseWorkflowReference(workflowPath);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(WorkflowReferenceUnpinnedError);
		expect((failure as WorkflowReferenceUnpinnedError).reference).toBe(
			workflowPath
		);
	});

	it('refuses a pin without an owner, repository and workflow path', () => {
		expect(() => parseWorkflowReference(`cupboard@${'a'.repeat(40)}`)).toThrow(
			WorkflowReferenceMalformedError
		);
	});

	it.each([
		['a repository file', 'README.md'],
		['a workflow in another directory', '.github/actions/publish.yml'],
		['a nested workflow path', '.github/workflows/release/publish.yml'],
		['a non-YAML workflow file', '.github/workflows/publish.json']
	])('refuses %s', (_name, path) => {
		const reference = `acme/app/${path}@${'a'.repeat(40)}`;

		expect(() => parseWorkflowReference(reference)).toThrow(
			WorkflowReferenceMalformedError
		);
	});

	it.each([
		['the owner', `*/app/.github/workflows/publish.yml@refs/tags/v1.2.3`],
		['the repository', `acme/*/.github/workflows/publish.yml@refs/tags/v1.2.3`],
		['the path', `acme/app/.github/workflows/*.yml@refs/tags/v1.2.3`]
	])('refuses a wildcard in %s', (_name, reference) => {
		expect(() => parseWorkflowReference(reference)).toThrow(
			WorkflowReferenceMalformedError
		);
	});

	it.each([
		['a branch ref', 'refs/heads/main'],
		['a pull-request ref', 'refs/pull/7/merge'],
		['an abbreviated commit id', 'aaaaaaa'],
		['an empty ref', '']
	])('refuses %s as mutable', (_name, pin) => {
		const reference = `${workflowPath}@${pin}`;

		let failure: unknown;
		try {
			parseWorkflowReference(reference);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(WorkflowReferenceMutableError);
		expect({
			reference: (failure as WorkflowReferenceMutableError).reference,
			pin: (failure as WorkflowReferenceMutableError).pin
		}).toStrictEqual({ reference, pin });
	});

	it.each([
		['a branch pattern', 'refs/heads/v*'],
		['a bare glob without the tag prefix', 'v*'],
		['a recursive wildcard', 'refs/tags/v**'],
		['a glob with pattern metacharacters', String.raw`refs/tags/v(\d)*`]
	])('refuses %s as a tag pattern', (_name, pin) => {
		const reference = `${workflowPath}@${pin}`;

		let failure: unknown;
		try {
			parseWorkflowReference(reference);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(WorkflowReferenceTagPatternError);
		expect({
			reference: (failure as WorkflowReferenceTagPatternError).reference,
			pin: (failure as WorkflowReferenceTagPatternError).pin
		}).toStrictEqual({ reference, pin });
	});
});

describe('parseExactWorkflowReference', () => {
	it('accepts an immutable release tag', () => {
		expect(
			parseExactWorkflowReference(`${workflowPath}@refs/tags/v1.2.3`)
		).toStrictEqual({
			reference: `${workflowPath}@refs/tags/v1.2.3`,
			owner: 'acme',
			repo: 'app',
			path: '.github/workflows/publish.yml',
			pin: { kind: 'tag', value: 'refs/tags/v1.2.3', tag: 'v1.2.3' }
		});
	});

	it('refuses a tag pattern', () => {
		const reference = `${workflowPath}@refs/tags/v*`;

		expect(() => parseExactWorkflowReference(reference)).toThrow(
			new WorkflowReferenceExactRequiredError(reference)
		);
	});
});

describe('workflowReferenceClaim', () => {
	it.each([
		['a tag pin', `${workflowPath}@refs/tags/v1.2.3`],
		['a commit pin', `${workflowPath}@${'a'.repeat(40)}`]
	])('pins %s exactly', (_name, reference) => {
		expect(workflowReferenceClaim(parseWorkflowReference(reference))).toBe(
			reference
		);
	});

	it('renders a tag pattern with a literal prefix and segment-bound wildcards', () => {
		const parsed = parseWorkflowReference(`${workflowPath}@refs/tags/v1.*`);

		expect(workflowReferenceClaim(parsed)).toStrictEqual({
			pattern: String.raw`^acme/app/\.github/workflows/publish\.yml@refs/tags/v1\.[^/]*$`
		});
	});
});

describe('workflowReferenceClaimsOverlap', () => {
	it.each([
		['a broader left pattern', 'v*', 'v2*', true],
		['a broader right pattern', 'v2*', 'v*', true],
		['disjoint tag namespaces', 'v1*', 'v2*', false],
		[
			'compatible literals around wildcards',
			'release-*-x',
			'release-y-*',
			true
		],
		['incompatible literal suffixes', '*-stable', '*-preview', false],
		[
			'a path separator against a segment wildcard',
			'release*',
			'release/v*',
			false
		]
	])('%s', (_name, left, right, expected) => {
		expect(
			workflowReferenceClaimsOverlap(
				workflowPatternClaim(left),
				workflowPatternClaim(right)
			)
		).toBe(expected);
	});

	it('compares an exact reference with a tag pattern', () => {
		expect(
			workflowReferenceClaimsOverlap(
				`${workflowPath}@refs/tags/v2.1.0`,
				workflowPatternClaim('v2*')
			)
		).toBe(true);
		expect(
			workflowReferenceClaimsOverlap(
				`${workflowPath}@refs/tags/v1.9.0`,
				workflowPatternClaim('v2*')
			)
		).toBe(false);
	});

	it('reports an unknown result for a non-canonical pattern', () => {
		expect(
			workflowReferenceClaimsOverlap(
				{ pattern: '^.*$' },
				workflowPatternClaim('v2*')
			)
		).toBeUndefined();
	});
});
