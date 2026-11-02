import {
	publicationLookupMaxResults,
	publicationManifestLimitErrorCode,
	type PublicationManifestLimitErrorData,
	publicationManifestMaxMembers,
	publicationManifestPageMaxMembers
} from '@cupboard/protocol/publication-manifests';
import { type ErrorMap, ORPCError, ValidationError } from '@orpc/server';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

const fieldSchema = z.enum(['results', 'members', 'memberCount']);
const issueSchema = z.object({
	code: z.literal('too_big'),
	origin: z.enum(['array', 'number']),
	maximum: z.number(),
	path: z.array(z.string()).min(1)
});
interface SchemaLimit {
	readonly maximum: number;
	readonly origin: 'array' | 'number';
	readonly limit: PublicationManifestLimitErrorData['limit'];
}
const limits: Readonly<Record<z.output<typeof fieldSchema>, SchemaLimit>> = {
	results: {
		maximum: publicationLookupMaxResults,
		origin: 'array',
		limit: 'lookup-results'
	},
	members: {
		maximum: publicationManifestPageMaxMembers,
		origin: 'array',
		limit: 'page-members'
	},
	memberCount: {
		maximum: publicationManifestMaxMembers,
		origin: 'number',
		limit: 'total-members'
	}
};

export function publicationInputLimitError(
	errors: ErrorMap,
	error: unknown
): ORPCError<string, PublicationManifestLimitErrorData> | undefined {
	if (
		errors[publicationManifestLimitErrorCode] === undefined ||
		!(error instanceof ORPCError) ||
		error.code !== 'BAD_REQUEST'
	) {
		return;
	}

	let cause: unknown = error;
	const visited = new Set<unknown>();
	while (cause instanceof ORPCError && cause.code === 'BAD_REQUEST') {
		if (visited.has(cause)) {
			return;
		}
		visited.add(cause);
		cause = cause.cause;
	}
	if (!(cause instanceof ValidationError)) {
		return;
	}

	for (const issue of cause.issues) {
		const parsed = issueSchema.safeParse(issue);
		if (!parsed.success) {
			continue;
		}
		const field = fieldSchema.safeParse(parsed.data.path.at(-1));
		if (!field.success) {
			continue;
		}
		const limit = limits[field.data];
		if (
			limit.maximum !== parsed.data.maximum ||
			limit.origin !== parsed.data.origin
		) {
			continue;
		}

		return new ORPCError(publicationManifestLimitErrorCode, {
			defined: true,
			status: StatusCodes.REQUEST_TOO_LONG,
			message: 'Publication request exceeds its declared limit',
			data: { limit: limit.limit, maximum: limit.maximum },
			cause: error
		});
	}
}
