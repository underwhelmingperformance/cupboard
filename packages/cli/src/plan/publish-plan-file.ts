import {
	type CohortRootsDocument,
	cohortRootsDocumentSchema,
	cohortRootsVersion,
	type PublishPlanDocument,
	publishPlanDocumentSchema,
	publishPlanVersion
} from '@cupboard/protocol/publish-plan';
import { z } from 'zod';

import { CliUsageError } from '../errors.ts';

/**
The plan document was written by a cupboard release with a different
document version, so this release could misread it.
*/
export class PublishPlanVersionError extends CliUsageError {
	constructor(
		readonly found: unknown,
		readonly supported: number
	) {
		super(
			`The publish plan has version ${found === undefined ? 'none' : JSON.stringify(found)}, but this cupboard reads only version ${String(supported)}. Use the cupboard release that matches the publish workflow.`
		);
		this.name = 'PublishPlanVersionError';
	}
}

/**
The cohort roots document was written by a cupboard release with a different
document version, so this release could misread it.
*/
export class CohortRootsVersionError extends CliUsageError {
	constructor(
		readonly found: unknown,
		readonly supported: number
	) {
		super(
			`The roots file has version ${found === undefined ? 'none' : JSON.stringify(found)}, but this cupboard reads only version ${String(supported)}. Use the cupboard release that matches the publish workflow.`
		);
		this.name = 'CohortRootsVersionError';
	}
}

const versionedDocumentSchema = z.looseObject({ version: z.unknown() });

function documentVersion(value: unknown): unknown {
	const versioned = versionedDocumentSchema.safeParse(value);

	return versioned.success ? versioned.data.version : undefined;
}

/**
Parses the plan action's JSON plan document. A document of another version is
refused with `PublishPlanVersionError` before its other fields are read.
*/
export function parsePublishPlan(contents: string): PublishPlanDocument {
	const value: unknown = JSON.parse(contents);
	const found = documentVersion(value);

	if (found !== publishPlanVersion) {
		throw new PublishPlanVersionError(found, publishPlanVersion);
	}

	return publishPlanDocumentSchema.parse(value);
}

/**
Parses a cohort job's JSON roots document for `push --roots-file`. A document
of another version is refused with `CohortRootsVersionError` before its other
fields are read.
*/
export function parseCohortRoots(contents: string): CohortRootsDocument {
	const value: unknown = JSON.parse(contents);
	const found = documentVersion(value);

	if (found !== cohortRootsVersion) {
		throw new CohortRootsVersionError(found, cohortRootsVersion);
	}

	return cohortRootsDocumentSchema.parse(value);
}
