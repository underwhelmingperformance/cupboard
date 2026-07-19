import {
	WorkflowReferenceMalformedError,
	WorkflowReferenceMutableError,
	WorkflowReferenceUnpinnedError
} from '../../errors.ts';

// The reuse-view name and per-PR cache prefix the quickstart uses. Setup
// writes them and check verifies them, so the one spelling lives here.
export const pullRequestViewName = 'pull-requests';
export const pullRequestPrefix = 'pr-';

// The grace below which the plan-to-target span of a busy run is at real
// risk of outliving its intermediates' deadlines. Setup refuses to store
// less and check fails a stored policy under it, so the two cannot drift.
export const minimumGraceSeconds = 3600;

// A mutable ref (a branch, a pull-request merge ref, an abbreviation)
// follows whatever it later names, so a trust rule pinning one would trust
// future edits to the workflow file. Setup refuses to store such a pin and
// check refuses to verify against one. The generic oidc-trust commands keep
// the bare-path pattern shape, which a reusable workflow's deliberately
// ref-agnostic rule needs.
const immutableReferencePattern = /^(?:refs\/tags\/.+|[0-9a-f]{40})$/;
const workflowPathPattern = /^\.github\/workflows\/[^/]+\.ya?ml$/;

export interface PinnedWorkflowReference {
	readonly reference: string;
	readonly owner: string;
	readonly repo: string;
	readonly path: string;
	readonly pin:
		| { readonly kind: 'commit'; readonly value: string }
		| { readonly kind: 'tag'; readonly value: string; readonly tag: string };
}

export function requirePinnedWorkflowReference(reference: string): string {
	parsePinnedWorkflowReference(reference);

	return reference;
}

export function parsePinnedWorkflowReference(
	reference: string
): PinnedWorkflowReference {
	const separator = reference.lastIndexOf('@');

	if (separator === -1) {
		throw new WorkflowReferenceUnpinnedError(reference);
	}

	const pin = reference.slice(separator + 1);

	if (!immutableReferencePattern.test(pin)) {
		throw new WorkflowReferenceMutableError(reference, pin);
	}

	const [owner, repo, ...pathParts] = reference.slice(0, separator).split('/');

	if (owner === undefined || repo === undefined || pathParts.length === 0) {
		throw new WorkflowReferenceMalformedError(reference);
	}

	const path = pathParts.join('/');

	if (owner === '' || repo === '' || !workflowPathPattern.test(path)) {
		throw new WorkflowReferenceMalformedError(reference);
	}

	return {
		reference,
		owner,
		repo,
		path,
		pin: pin.startsWith('refs/tags/')
			? { kind: 'tag', value: pin, tag: pin.slice('refs/tags/'.length) }
			: { kind: 'commit', value: pin }
	};
}
