import { NixSignature } from '@cupboard/nix-store/signature';
import {
	type BuildOriginPredicate,
	buildOriginPredicateSchema,
	buildOriginPredicateType,
	type BuildOriginSubject
} from '@cupboard/protocol/build-origin';
import type { VerifyResult } from '@cupboard/shared/sigstore';
import { z } from 'zod';

import { CliError } from '../errors.ts';

/**
 * A bundle declared the build-origin predicate type, but its predicate does not
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
 * Returns undefined unless the verified bundle declares the build-origin
 * predicate type. A predicate of another type is never parsed as a Cupboard
 * statement.
 *
 * A bundle that declares the type but fails the schema throws
 * {@link BuildOriginStatementInvalidError}. The predicate type claims origin
 * facts, so treating a malformed predicate as absent would report the bundle
 * as verified without validating those facts.
 */
export function buildOriginStatement(
	result: Pick<VerifyResult, 'bundle' | 'predicateType' | 'predicate'>
): BuildOriginPredicate | undefined {
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

export function describeBuildOrigin(subject: BuildOriginSubject): string {
	if (subject.origin === 'store-held') {
		return `${subject.buildStore} reported the path as locally built, but the receipt does not record when it was built`;
	}

	if (subject.origin === 'copied') {
		return describeCopied(subject);
	}

	if (subject.origin === 'republished') {
		return `this run read its narinfo from ${subject.metadataSource}${describeSignatures(
			subject.signatures,
			'the narinfo'
		)}`;
	}

	if (subject.verification === 'local') {
		return 'the coordinating machine built it under supervision';
	}

	if (subject.machine === undefined) {
		return `${subject.buildStore} reported that it built the path, but this run did not observe which machine performed the build`;
	}

	return `${subject.machine} built it, and ${subject.buildStore} reported the build`;
}

// `copiedFrom` records every source in the observed copy attempts. It does not
// prove which source supplied the path because an earlier attempt may have
// failed before Nix tried the next source.
function describeCopied(
	subject: Extract<BuildOriginSubject, { origin: 'copied' }>
): string {
	const source =
		subject.copiedFrom === undefined
			? 'the build store reported a copied path, but this run did not observe the source'
			: `this run observed copy attempts from ${subject.copiedFrom.join(', ')}`;
	return `${source}${describeSignatures(subject.signatures, 'the build-store metadata')}`;
}

// These signatures are evidence recorded in the receipt, not verification
// results. Only describe what the source metadata reported.
function describeSignatures(
	signatures: readonly string[],
	source: string
): string {
	const names = NixSignature.parseAll(signatures).map(
		(signature) => signature.name
	);

	return names.length === 0
		? `; ${source} lists no Nix signatures`
		: `; ${source} lists unverified Nix signatures for ${names.join(', ')}`;
}
