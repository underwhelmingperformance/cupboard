import { NixSignature } from '@cupboard/nix-store/signature';
import {
	buildOriginPredicateSchema,
	buildOriginPredicateType,
	type ParsedBuildOriginPredicate,
	type ParsedBuildOriginSubject
} from '@cupboard/protocol/build-origin';
import type { VerifyResult } from '@cupboard/shared/sigstore';
import { z } from 'zod';

import { CliError } from '../errors.ts';

/**
 * A bundle claimed the build-origin predicate type, but its predicate does not
 * match the statement's schema. `fields` names each failing part of the
 * predicate as a dotted path.
 */
export class BuildOriginStatementInvalidError extends CliError {
	constructor(
		public readonly bundle: string,
		public readonly fields: readonly string[],
		public override readonly cause: z.ZodError
	) {
		super(
			`Build-origin statement in ${bundle} did not match the expected schema:\n${z.prettifyError(cause)}`
		);
		this.name = 'BuildOriginStatementInvalidError';
	}
}

/**
 * The build-origin statement a verified bundle carries. Returns undefined for
 * a bundle whose predicate type is not the build-origin type, so a predicate
 * of another type is never read as a cupboard statement.
 *
 * A bundle that claims the type but fails the schema throws
 * {@link BuildOriginStatementInvalidError}. The predicate type claims origin
 * facts, and treating the bundle as carrying no statement would report it as
 * verified without those facts.
 */
export function buildOriginStatement(
	result: Pick<VerifyResult, 'bundle' | 'predicateType' | 'predicate'>
): ParsedBuildOriginPredicate | undefined {
	if (result.predicateType !== buildOriginPredicateType) {
		return undefined;
	}

	const parsed = buildOriginPredicateSchema.safeParse(result.predicate);

	if (!parsed.success) {
		throw new BuildOriginStatementInvalidError(
			result.bundle,
			parsed.error.issues.map((issue) => issue.path.join('.')),
			parsed.error
		);
	}

	return parsed.data;
}

/**
 * One sentence describing where a subject came from. A path the run built names
 * the machine or store that built it. A path the store already held names that
 * store. A path the run copied names the stores it came from and the keys that
 * signed it. A republished path names the cache its metadata was read from.
 */
export function describeBuildOrigin(subject: ParsedBuildOriginSubject): string {
	if (subject.origin === 'store-held') {
		return `${subject.buildStore} registered it as its own work, and this run did not build it`;
	}

	if (subject.origin === 'copied') {
		return describeCopied(subject);
	}

	if (subject.origin === 'republished') {
		return `this run republished it from ${subject.metadataSource}${signedBy(
			subject.signatures,
			'that cache published no signature for it'
		)}`;
	}

	if (subject.verification === 'local') {
		return 'the coordinating machine built it under supervision';
	}

	if (subject.machine === undefined) {
		return `${subject.buildStore} reports it as its own work, and this run did not watch the build`;
	}

	return `${subject.machine} built it, and ${subject.buildStore} reported the build`;
}

// A copied path is described from what the run can show: the stores it watched
// the copy come from, if it watched one at all, and the keys that signed the
// path.
function describeCopied(
	subject: Extract<ParsedBuildOriginSubject, { origin: 'copied' }>
): string {
	const source =
		subject.copiedFrom === undefined
			? 'it was copied into the build store, but this run did not watch the copy'
			: `this run copied it from ${subject.copiedFrom.join(', ')}`;
	return `${source}${signedBy(subject.signatures, 'the store holds no signature for it')}`;
}

// The keys that signed a path, as a clause to append to its description. A path
// with no signature takes the caller's clause, because which document should
// have carried one differs by origin.
function signedBy(signatures: readonly string[], unsigned: string): string {
	const names = NixSignature.parseAll(signatures).map(
		(signature) => signature.name
	);

	return names.length === 0
		? `; ${unsigned}`
		: `; signed by ${names.join(', ')}`;
}
