import {
	uploadCapabilitiesHeader,
	type UploadDecision,
	uploadNegotiateMaxPaths,
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

import { spendSubrequests } from '../do/subrequest-slice.ts';
import {
	uploadPageSplitHeader,
	UploadRequestLimitExceededError
} from '../errors.ts';
import {
	directUploadPageSize,
	uploadPageSize
} from '../policy/upload-pages.ts';

export {
	directUploadPageSize,
	uploadPageSize
} from '../policy/upload-pages.ts';

const outgoingConnections = 6;

function maximumPageSends(paths: number): number {
	if (paths <= directUploadPageSize) {
		return 1;
	}
	const first = Math.ceil(paths / 2);
	return 1 + maximumPageSends(first) + maximumPageSends(paths - first);
}

function maximumRequestSends(paths: number): number {
	const fullPages = Math.floor(paths / uploadPageSize);
	const remainder = paths % uploadPageSize;
	return Math.max(
		1,
		fullPages * maximumPageSends(uploadPageSize) +
			(remainder === 0 ? 0 : maximumPageSends(remainder))
	);
}

export function uploadRequestMaxPathsFor(availableSubrequests: number): number {
	let lower = 0;
	let upper = uploadNegotiateMaxPaths;
	while (lower < upper) {
		const middle = Math.ceil((lower + upper) / 2);
		if (maximumRequestSends(middle) <= availableSubrequests) {
			lower = middle;
		} else {
			upper = middle - 1;
		}
	}
	return lower;
}

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

	if (!parsed.success) {
		return undefined;
	}
	const input = parsed.data;
	const maxPaths = uploadRequestMaxPathsFor(availableSubrequests);
	if (maximumRequestSends(input.paths.length) > availableSubrequests) {
		throw new UploadRequestLimitExceededError(maxPaths);
	}
	if (input.paths.length <= directUploadPageSize) {
		return undefined;
	}
	let sent = 0;
	const responseSchema =
		mode === 'negotiate'
			? uploadNegotiateResponseSchema
			: uploadPreviewResponseSchema;

	const sendPage = async (
		paths: readonly UploadPathNegotiation[]
	): Promise<UploadPageAnswer[]> => {
		if (sent >= availableSubrequests) {
			throw new UploadRequestLimitExceededError(maxPaths);
		}

		sent += 1;
		spendSubrequests(1, 'upload page');
		const response = await send({ ...input, paths: [...paths] });

		if (
			response.headers.get(uploadPageSplitHeader) === '1' &&
			paths.length > directUploadPageSize
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
