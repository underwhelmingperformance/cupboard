import {
	subrequestSafetyReserve,
	workersInvocationAllowances
} from '@cupboard/protocol/platform';
import {
	uploadCapabilitiesHeader,
	type UploadDecision,
	type UploadNegotiateRequest,
	uploadNegotiateRequestSchema,
	uploadNegotiateResponseSchema,
	type UploadPathNegotiation,
	type UploadPreviewDecision,
	type UploadPreviewRequest,
	uploadPreviewRequestSchema,
	uploadPreviewResponseSchema
} from '@cupboard/protocol/upload';
import { discardResponseBody } from '@cupboard/shared/cleanup';
import { chunk } from '@cupboard/shared/collections';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { StatusCodes } from 'http-status-codes';

import { subrequestsPerReconcileRemoval } from '../do/reconcile-queue-service.ts';
import {
	uploadPageSplitHeader,
	UploadRequestBudgetExceededError
} from '../errors.ts';

// Reserve one call per path for its NAR head and another for the remaining
// classification work. The second reserve covers fixed work in the object.
const pageSubrequests =
	workersInvocationAllowances.free.subrequests - 2 * subrequestSafetyReserve;
export const uploadPageSize = Math.floor(pageSubrequests / 2);
const directUploadPageSize = Math.floor(
	pageSubrequests / (1 + subrequestsPerReconcileRemoval)
);
const outgoingConnections = 6;

class UploadPageRefused extends Error {
	constructor(readonly response: Response) {
		super('An upload page was refused');
	}
}

type UploadRequest = UploadNegotiateRequest | UploadPreviewRequest;

interface UploadPageAnswer {
	readonly uploads: readonly (UploadDecision | UploadPreviewDecision)[];
	readonly capability: string | undefined;
}

export async function answerUploadsInChunks(
	request: Request,
	mode: 'negotiate' | 'preview',
	send: (body: UploadRequest) => Promise<Response>,
	availableSubrequests: number
): Promise<Response | undefined> {
	let body: unknown;

	try {
		body = await request.clone().json();
	} catch {
		return undefined;
	}

	const parsed =
		mode === 'negotiate'
			? uploadNegotiateRequestSchema.safeParse(body)
			: uploadPreviewRequestSchema.safeParse(body);

	if (!parsed.success || parsed.data.paths.length <= directUploadPageSize) {
		return undefined;
	}

	const input = parsed.data;
	let sent = 0;
	const responseSchema =
		mode === 'negotiate'
			? uploadNegotiateResponseSchema
			: uploadPreviewResponseSchema;

	const sendPage = async (
		paths: readonly UploadPathNegotiation[]
	): Promise<UploadPageAnswer[]> => {
		if (sent >= availableSubrequests) {
			throw new UploadRequestBudgetExceededError();
		}

		sent += 1;
		const response = await send({ ...input, paths: [...paths] });

		if (
			response.headers.get(uploadPageSplitHeader) === '1' &&
			paths.length > 1
		) {
			await discardResponseBody(response);
			const middle = Math.ceil(paths.length / 2);
			const first = await sendPage(paths.slice(0, middle));
			const second = await sendPage(paths.slice(middle));

			return [...first, ...second];
		}

		if (!response.ok) {
			throw new UploadPageRefused(response);
		}

		const page = responseSchema.parse(await response.json());

		return [
			{
				uploads: page.uploads,
				capability: response.headers.get(uploadCapabilitiesHeader) ?? undefined
			}
		];
	};

	try {
		const chunks = await mapWithConcurrency(
			chunk(input.paths, uploadPageSize),
			outgoingConnections,
			sendPage
		);
		const pages = chunks.flat();
		const capabilities = new Set(pages.map((page) => page.capability));
		const capability =
			capabilities.size === 1 ? pages[0]?.capability : undefined;

		return Response.json(
			{ uploads: pages.flatMap((page) => page.uploads) },
			{
				status: StatusCodes.OK,
				headers: {
					'cache-control': 'no-store',
					...(capability !== undefined && {
						[uploadCapabilitiesHeader]: capability
					})
				}
			}
		);
	} catch (error) {
		if (error instanceof UploadPageRefused) {
			return error.response;
		}

		throw error;
	}
}
