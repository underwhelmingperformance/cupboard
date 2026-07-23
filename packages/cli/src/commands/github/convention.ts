import {
	isPatternMatch,
	quotePatternLiteral
} from '@cupboard/protocol/capture';
import { type ClaimMatch } from '@cupboard/protocol/oidc';

import {
	WorkflowReferenceExactRequiredError,
	WorkflowReferenceMalformedError,
	WorkflowReferenceMutableError,
	WorkflowReferenceTagPatternError,
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

const tagReferencePrefix = 'refs/tags/';

// Tag patterns admit literal tag characters with `*` wildcards that stay
// within one path segment.
const tagGlobCharacters = /^[A-Za-z0-9._/+*-]+$/;

export type ExactWorkflowReferencePin =
	| { readonly kind: 'commit'; readonly value: string }
	| { readonly kind: 'tag'; readonly value: string; readonly tag: string };

export type WorkflowReferencePin =
	| ExactWorkflowReferencePin
	| {
			readonly kind: 'tag-pattern';
			readonly value: string;
			readonly glob: string;
	  };

export interface WorkflowReference {
	readonly reference: string;
	readonly owner: string;
	readonly repo: string;
	readonly path: string;
	readonly pin: WorkflowReferencePin;
}

export interface ExactWorkflowReference {
	readonly reference: string;
	readonly owner: string;
	readonly repo: string;
	readonly path: string;
	readonly pin: ExactWorkflowReferencePin;
}

interface TagPatternWorkflowReference {
	readonly owner: string;
	readonly repo: string;
	readonly path: string;
	readonly pin: Extract<WorkflowReferencePin, { readonly kind: 'tag-pattern' }>;
}

export function parseWorkflowReference(reference: string): WorkflowReference {
	const separator = reference.lastIndexOf('@');

	if (separator === -1) {
		throw new WorkflowReferenceUnpinnedError(reference);
	}

	const pin = workflowReferencePin(reference, reference.slice(separator + 1));
	const prefix = reference.slice(0, separator);

	if (prefix.includes('*')) {
		throw new WorkflowReferenceMalformedError(reference);
	}

	const [owner, repo, ...pathParts] = prefix.split('/');

	if (owner === undefined || repo === undefined || pathParts.length === 0) {
		throw new WorkflowReferenceMalformedError(reference);
	}

	const path = pathParts.join('/');

	if (owner === '' || repo === '' || !workflowPathPattern.test(path)) {
		throw new WorkflowReferenceMalformedError(reference);
	}

	return { reference, owner, repo, path, pin };
}

export function parseExactWorkflowReference(
	reference: string
): ExactWorkflowReference {
	const parsed = parseWorkflowReference(reference);

	if (parsed.pin.kind === 'tag-pattern') {
		throw new WorkflowReferenceExactRequiredError(reference);
	}

	return {
		reference: parsed.reference,
		owner: parsed.owner,
		repo: parsed.repo,
		path: parsed.path,
		pin: parsed.pin
	};
}

function workflowReferencePin(
	reference: string,
	pin: string
): WorkflowReferencePin {
	if (pin.includes('*')) {
		const glob = pin.startsWith(tagReferencePrefix)
			? pin.slice(tagReferencePrefix.length)
			: undefined;

		if (
			glob === undefined ||
			glob.includes('**') ||
			!tagGlobCharacters.test(glob)
		) {
			throw new WorkflowReferenceTagPatternError(reference, pin);
		}

		return { kind: 'tag-pattern', value: pin, glob };
	}

	if (!immutableReferencePattern.test(pin)) {
		throw new WorkflowReferenceMutableError(reference, pin);
	}

	return pin.startsWith(tagReferencePrefix)
		? {
				kind: 'tag',
				value: pin,
				tag: pin.slice(tagReferencePrefix.length)
			}
		: { kind: 'commit', value: pin };
}

/**
 * The `job_workflow_ref` claim a parsed reference pins: the exact reference
 * for a commit or tag pin, or for a tag pattern an anchored RE2 in which the
 * owner, repository and path stay literal and only the tag part admits the
 * pattern's namespace.
 */
export function workflowReferenceClaim(parsed: WorkflowReference): ClaimMatch {
	if (parsed.pin.kind !== 'tag-pattern') {
		return parsed.reference;
	}

	const literal = quotePatternLiteral(
		`${parsed.owner}/${parsed.repo}/${parsed.path}@${tagReferencePrefix}`
	);

	return { pattern: `^${literal}${tagGlobRe2(parsed.pin.glob)}$` };
}

/**
 * Whether two workflow-reference claims can admit the same exact reference.
 * Returns `undefined` when both claims are patterns and either is not in the
 * canonical form produced by {@link workflowReferenceClaim}.
 */
export function workflowReferenceClaimsOverlap(
	left: ClaimMatch,
	right: ClaimMatch
): boolean | undefined {
	if (typeof left === 'string') {
		if (typeof right === 'string') {
			return left === right;
		}

		return isPatternMatch(right.pattern, left);
	}

	if (typeof right === 'string') {
		return isPatternMatch(left.pattern, right);
	}

	const leftReference = parseCanonicalTagPatternClaim(left.pattern);
	const rightReference = parseCanonicalTagPatternClaim(right.pattern);

	if (leftReference === undefined || rightReference === undefined) {
		return undefined;
	}

	if (
		leftReference.owner !== rightReference.owner ||
		leftReference.repo !== rightReference.repo ||
		leftReference.path !== rightReference.path
	) {
		return false;
	}

	return canTagGlobsOverlap(leftReference.pin.glob, rightReference.pin.glob);
}

// Each `*` matches within one path segment; everything else is quoted
// literally.
function tagGlobRe2(glob: string): string {
	return glob
		.split('*')
		.map((part) => quotePatternLiteral(part))
		.join('[^/]*');
}

function parseCanonicalTagPatternClaim(
	pattern: string
): TagPatternWorkflowReference | undefined {
	const reference = decodeCanonicalWorkflowPattern(pattern);

	if (reference === undefined) {
		return undefined;
	}

	let parsed: WorkflowReference;

	try {
		parsed = parseWorkflowReference(reference);
	} catch {
		return undefined;
	}

	if (parsed.pin.kind !== 'tag-pattern') {
		return undefined;
	}

	const rendered = workflowReferenceClaim(parsed);

	if (typeof rendered === 'string' || rendered.pattern !== pattern) {
		return undefined;
	}

	return {
		owner: parsed.owner,
		repo: parsed.repo,
		path: parsed.path,
		pin: parsed.pin
	};
}

function decodeCanonicalWorkflowPattern(pattern: string): string | undefined {
	if (!pattern.startsWith('^') || !pattern.endsWith('$')) {
		return undefined;
	}

	const wildcard = '[^/]*';
	const metacharacters = new Set('.^$|?+()[]{}*\\');
	const body = pattern.slice(1, -1);
	let reference = '';

	for (let index = 0; index < body.length; index += 1) {
		if (body.startsWith(wildcard, index)) {
			reference += '*';
			index += wildcard.length - 1;
			continue;
		}

		const character = body[index];

		if (character === '\\') {
			const literal = body[index + 1];

			if (literal === undefined) {
				return undefined;
			}

			reference += literal;
			index += 1;
			continue;
		}

		if (character === undefined || metacharacters.has(character)) {
			return undefined;
		}

		reference += character;
	}

	return reference;
}

function canTagGlobsOverlap(left: string, right: string): boolean {
	const pending: [number, number][] = [[0, 0]];
	const visited = new Set<string>();

	while (pending.length > 0) {
		const state = pending.shift();

		if (state === undefined) {
			return false;
		}

		const [leftIndex, rightIndex] = state;
		const key = `${String(leftIndex)}:${String(rightIndex)}`;

		if (visited.has(key)) {
			continue;
		}

		visited.add(key);

		if (leftIndex === left.length && rightIndex === right.length) {
			return true;
		}

		const leftCharacter = left[leftIndex];
		const rightCharacter = right[rightIndex];

		if (leftCharacter === '*') {
			pending.push([leftIndex + 1, rightIndex]);
		}

		if (rightCharacter === '*') {
			pending.push([leftIndex, rightIndex + 1]);
		}

		if (leftCharacter === undefined || rightCharacter === undefined) {
			continue;
		}

		if (
			leftCharacter !== '*' &&
			rightCharacter !== '*' &&
			leftCharacter !== rightCharacter
		) {
			continue;
		}

		if (
			(leftCharacter === '*' && rightCharacter === '/') ||
			(leftCharacter === '/' && rightCharacter === '*')
		) {
			continue;
		}

		pending.push([
			leftCharacter === '*' ? leftIndex : leftIndex + 1,
			rightCharacter === '*' ? rightIndex : rightIndex + 1
		]);
	}

	return false;
}
