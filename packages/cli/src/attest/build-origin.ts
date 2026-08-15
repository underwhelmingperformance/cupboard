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
 * A sentence naming where one subject came from: the coordinating machine that
 * watched the build, the builder the activity log recorded, or the build store
 * that reported the path as its own work.
 */
export function describeBuildOrigin(subject: ParsedBuildOriginSubject): string {
	if (subject.verification === 'local') {
		return 'the coordinating machine built it under supervision';
	}

	if (subject.machine === undefined) {
		return `${subject.buildStore} reports it as its own work, and this run did not watch the build`;
	}

	return `${subject.machine} built it, and ${subject.buildStore} reported the build`;
}
