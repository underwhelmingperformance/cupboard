import {
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

const versionedDocumentSchema = z.looseObject({ version: z.unknown() });

/**
Parses the plan action's JSON plan document. A document of another version is
refused with `PublishPlanVersionError` before its other fields are read.
*/
export function parsePublishPlan(contents: string): PublishPlanDocument {
	const value: unknown = JSON.parse(contents);
	const versioned = versionedDocumentSchema.safeParse(value);
	const found = versioned.success ? versioned.data.version : undefined;

	if (found !== publishPlanVersion) {
		throw new PublishPlanVersionError(found, publishPlanVersion);
	}

	return publishPlanDocumentSchema.parse(value);
}
