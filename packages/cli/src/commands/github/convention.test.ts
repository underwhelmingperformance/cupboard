import { describe, expect, it } from 'vitest';

import {
	WorkflowReferenceMalformedError,
	WorkflowReferenceMutableError,
	WorkflowReferenceUnpinnedError
} from '../../errors.ts';

import { requirePinnedWorkflowReference } from './convention.ts';

const workflowPath = 'acme/app/.github/workflows/publish.yml';

describe('requirePinnedWorkflowReference', () => {
	it.each([
		['a release tag', `${workflowPath}@refs/tags/v1.2.3`],
		['a commit id', `${workflowPath}@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`],
		[
			'a YAML workflow extension',
			`acme/app/.github/workflows/publish.yaml@${'a'.repeat(40)}`
		]
	])('accepts %s', (_name, reference) => {
		expect(requirePinnedWorkflowReference(reference)).toBe(reference);
	});

	it('refuses a bare workflow path', () => {
		let failure: unknown;
		try {
			requirePinnedWorkflowReference(workflowPath);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(WorkflowReferenceUnpinnedError);
		expect((failure as WorkflowReferenceUnpinnedError).reference).toBe(
			workflowPath
		);
	});

	it('refuses a pin without an owner, repository and workflow path', () => {
		expect(() =>
			requirePinnedWorkflowReference(`cupboard@${'a'.repeat(40)}`)
		).toThrow(WorkflowReferenceMalformedError);
	});

	it.each([
		['a repository file', 'README.md'],
		['a workflow in another directory', '.github/actions/publish.yml'],
		['a nested workflow path', '.github/workflows/release/publish.yml'],
		['a non-YAML workflow file', '.github/workflows/publish.json']
	])('refuses %s', (_name, path) => {
		const reference = `acme/app/${path}@${'a'.repeat(40)}`;

		expect(() => requirePinnedWorkflowReference(reference)).toThrow(
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
			requirePinnedWorkflowReference(reference);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(WorkflowReferenceMutableError);
		expect({
			reference: (failure as WorkflowReferenceMutableError).reference,
			pin: (failure as WorkflowReferenceMutableError).pin
		}).toStrictEqual({ reference, pin });
	});
});
