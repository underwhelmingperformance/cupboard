import { buildInputsCapability } from '@cupboard/protocol/build-inputs';
import {
	buildInputsUploadMaxPaths,
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
	uploadPreviewResponseSchema,
	uploadRequestMaxBodyBytes
} from '@cupboard/protocol/upload';
import { discardResponseBody } from '@cupboard/shared/cleanup';
import { chunk } from '@cupboard/shared/collections';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { StatusCodes } from 'http-status-codes';

import { spendSubrequests } from '../do/subrequest-slice.ts';
import {
	BuildInputsCapabilityRequiredError,
	uploadPageSplitHeader,
	UploadRequestLimitExceededError,
	UploadRequestTooLargeError
} from '../errors.ts';
import { hasAcceptedCapability } from '../http/capabilities.ts';
import {
	directUploadPageSize,
	uploadPageMaxBytes,
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

/**
Whether an upload request comes from a client that accepts `build-inputs-v1`.
Only such a client sends build inputs, and only its requests have the body
limit, the paging by size and the smaller advertised maximum. Other clients,
including those that send a whole closure in one request, are answered as
before build inputs existed.
*/
export function isBuildInputsRequest(request: Request): boolean {
	return hasAcceptedCapability(request, buildInputsCapability);
}

/**
The most paths that one negotiation or preview request may contain, which the
Worker advertises in `x-cupboard-upload-max-paths`. The Worker must be able to
send every page and every split within `availableSubrequests`. For a client
that accepts build inputs, it is also at most `buildInputsUploadMaxPaths`.
*/
export function uploadRequestMaxPathsFor(
	availableSubrequests: number,
	isBuildInputsClient: boolean
): number {
	let lower = 0;
	let upper = isBuildInputsClient
		? Math.min(uploadNegotiateMaxPaths, buildInputsUploadMaxPaths)
		: uploadNegotiateMaxPaths;
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

const utf8 = new TextEncoder();

// Groups the paths into pages of at most `uploadPageSize` paths and
// `uploadPageMaxBytes` bytes of metadata, in order. A path larger than a page
// gets a page of its own.
function pagesBySize(
	paths: readonly UploadPathNegotiation[]
): UploadPathNegotiation[][] {
	const pages: UploadPathNegotiation[][] = [];
	let page: UploadPathNegotiation[] = [];
	let bytes = 0;

	for (const path of paths) {
		const size = utf8.encode(JSON.stringify(path)).length + 1;

		if (
			page.length > 0 &&
			(page.length === uploadPageSize || bytes + size > uploadPageMaxBytes)
		) {
			pages.push(page);
			page = [];
			bytes = 0;
		}

		page.push(path);
		bytes += size;
	}

	if (page.length > 0) {
		pages.push(page);
	}

	return pages;
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

interface UploadBodyStream {
	getReader(): {
		read(): Promise<
			| { readonly done: true; readonly value?: Uint8Array }
			| { readonly done: false; readonly value: Uint8Array }
		>;
		releaseLock(): void;
	};
}

// Reads the request body, up to `uploadRequestMaxBodyBytes`, and stops
// reading a larger body.
async function uploadRequestBytes(request: {
	readonly headers: Pick<Headers, 'get'>;
	readonly body: UploadBodyStream | null;
}): Promise<Uint8Array> {
	const declared = Number(request.headers.get('content-length'));

	if (declared > uploadRequestMaxBodyBytes) {
		throw new UploadRequestTooLargeError(uploadRequestMaxBodyBytes);
	}

	if (request.body === null) {
		return new Uint8Array();
	}

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;

	for (;;) {
		const chunk = await reader.read();

		if (chunk.done) {
			break;
		}

		length += chunk.value.byteLength;

		if (length > uploadRequestMaxBodyBytes) {
			reader.releaseLock();
			throw new UploadRequestTooLargeError(uploadRequestMaxBodyBytes);
		}

		chunks.push(chunk.value);
	}

	const bytes = new Uint8Array(length);
	let offset = 0;

	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return bytes;
}

function parseUploadRequest(
	body: unknown,
	mode: 'negotiate' | 'preview'
): UploadRequest | undefined {
	const parsed =
		mode === 'negotiate'
			? uploadNegotiateRequestSchema.safeParse(body)
			: uploadPreviewRequestSchema.safeParse(body);

	return parsed.success ? parsed.data : undefined;
}

// Decodes and validates a body, and returns only the validated request, so
// the decoded text and the raw JSON can be collected before any page is sent.
function decodeUploadRequest(
	bytes: Uint8Array,
	mode: 'negotiate' | 'preview'
): UploadRequest | undefined {
	let body: unknown;

	try {
		body = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return undefined;
	}

	return parseUploadRequest(body, mode);
}

/**
The pages of a request and the fields that every page repeats. The paths go
only in the pages, so the Worker keeps one list of them.
*/
interface UploadPages {
	readonly envelope: UploadRequest;
	readonly pages: readonly (readonly UploadPathNegotiation[])[];
}

function uploadPagesOf(
	input: UploadRequest,
	pages: readonly (readonly UploadPathNegotiation[])[]
): UploadPages {
	return { envelope: { ...input, paths: [] }, pages };
}

// Refuses pages that need more sends than `availableSubrequests` allows, as
// a request needs at least one send even without paths. The refusal reports the
// paths of the leading pages that fit, so a retry of those leading paths makes
// the same pages and fits. When no page fits, it reports `maxPaths`.
function refuseOverBudget(
	pages: readonly (readonly UploadPathNegotiation[])[],
	availableSubrequests: number,
	maxPaths: number
): void {
	if (availableSubrequests < 1) {
		throw new UploadRequestLimitExceededError(maxPaths);
	}

	let sends = 0;
	let fittingPaths = 0;

	for (const page of pages) {
		sends += maximumPageSends(page.length);

		if (sends > availableSubrequests) {
			throw new UploadRequestLimitExceededError(
				fittingPaths === 0 ? maxPaths : Math.min(maxPaths, fittingPaths)
			);
		}

		fittingPaths += page.length;
	}
}

/**
What the Worker does with an upload request: the merged answer of its pages,
or a forward of the request to the tenant object as it is. For a client that
accepts build inputs, `bytes` is the body that the Worker read and `input` the
request that it validated, or undefined when the body is not a valid request.
For any other client, the Worker forwards the original request.
*/
export type UploadRequestOutcome =
	| { readonly kind: 'answered'; readonly response: Response }
	| {
			readonly kind: 'direct';
			readonly body?: {
				readonly bytes: Uint8Array;
				readonly input: UploadRequest | undefined;
			};
	  };

/**
Answers an upload request in pages when it is too large for one request to
the tenant object, or tells the caller to forward it.

For a client that accepts build inputs, the Worker reads the body itself, not
a copy, up to `uploadRequestMaxBodyBytes`, joins its chunks into one buffer,
and pages it by size as well as by count. For any other client, it reads a
copy of the body without a limit and pages it by count, as it did before build
inputs existed, and refuses a request that contains build inputs.
*/
export async function answerUploadsInChunks(
	request: Request,
	mode: 'negotiate' | 'preview',
	send: (body: UploadRequest) => Promise<Response>,
	availableSubrequests: number
): Promise<UploadRequestOutcome> {
	const isBuildInputsClient = isBuildInputsRequest(request);
	const maxPaths = uploadRequestMaxPathsFor(
		availableSubrequests,
		isBuildInputsClient
	);

	if (!isBuildInputsClient) {
		let body: unknown;

		try {
			body = await request.clone().json();
		} catch {
			return { kind: 'direct' };
		}

		const input = parseUploadRequest(body, mode);

		if (input === undefined) {
			return { kind: 'direct' };
		}

		if (input.paths.some((path) => path.buildInputs !== undefined)) {
			throw new BuildInputsCapabilityRequiredError();
		}

		if (maximumRequestSends(input.paths.length) > availableSubrequests) {
			throw new UploadRequestLimitExceededError(maxPaths);
		}

		if (input.paths.length <= directUploadPageSize) {
			return { kind: 'direct' };
		}

		return {
			kind: 'answered',
			response: await answerUploadPages(
				uploadPagesOf(input, chunk(input.paths, uploadPageSize)),
				mode,
				send,
				availableSubrequests,
				maxPaths
			)
		};
	}

	const plan = await planBuildInputsRequest(
		request,
		mode,
		availableSubrequests,
		maxPaths
	);

	if (plan.kind === 'direct') {
		return plan;
	}

	return {
		kind: 'answered',
		response: await answerUploadPages(
			plan.pages,
			mode,
			send,
			availableSubrequests,
			maxPaths
		)
	};
}

// Reads and validates the body of a client that accepts build inputs. A paged
// plan keeps only its pages, so the body, its text and the validated request
// can be collected while the pages are sent.
async function planBuildInputsRequest(
	request: Request,
	mode: 'negotiate' | 'preview',
	availableSubrequests: number,
	maxPaths: number
): Promise<
	| Extract<UploadRequestOutcome, { kind: 'direct' }>
	| { readonly kind: 'paged'; readonly pages: UploadPages }
> {
	const bytes = await uploadRequestBytes(request);
	const input = decodeUploadRequest(bytes, mode);

	if (input === undefined) {
		return { kind: 'direct', body: { bytes, input } };
	}

	const pages = pagesBySize(input.paths);
	refuseOverBudget(pages, availableSubrequests, maxPaths);

	if (pages.length <= 1 && input.paths.length <= directUploadPageSize) {
		return { kind: 'direct', body: { bytes, input } };
	}

	return { kind: 'paged', pages: uploadPagesOf(input, pages) };
}

async function answerUploadPages(
	{ envelope, pages }: UploadPages,
	mode: 'negotiate' | 'preview',
	send: (body: UploadRequest) => Promise<Response>,
	availableSubrequests: number,
	maxPaths: number
): Promise<Response> {
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
		const response = await send({ ...envelope, paths: [...paths] });

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
			pages,
			outgoingConnections,
			sendPage
		);
		const answers = chunks.flat();
		const capabilities = new Set(answers.map((answer) => answer.capability));
		const capability =
			capabilities.size === 1 ? answers[0]?.capability : undefined;

		return Response.json(
			{ uploads: answers.flatMap((answer) => answer.uploads) },
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
