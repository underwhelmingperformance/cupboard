import { type StorePathString } from '@cupboard/nix-store/scalars';
import {
	cacheIntersectionMaxHashes,
	cacheIntersectionMaxRequestBytes,
	type CacheIntersectionRequest,
	cacheIntersectionRequestSchema,
	type CacheMetadataEntry,
	cacheMetadataMaxNarInfoBytes,
	cacheMetadataMaxRequestBytes,
	cacheMetadataMaxResponseBytes,
	type CacheMetadataRequest,
	cacheMetadataRequestSchema,
	type CacheMetadataResponse
} from '@cupboard/protocol/cache-metadata';
import {
	readResponseText,
	RemoteBodyTooLargeError
} from '@cupboard/shared/response-body';

import {
	MalformedRequestBodyError,
	MetadataIntersectionTooManyHashesError,
	MetadataNarInfoInvalidError,
	MetadataNarInfoTooLargeError,
	MetadataRequestTooLargeError
} from '../errors.ts';
import { parseRequestValue } from '../http/parse.ts';

const utf8 = new TextEncoder();

async function readRequestText(
	request: Request,
	maximumBytes: number
): Promise<string> {
	try {
		return await readResponseText(request, {
			description: 'Metadata request',
			maximumBytes
		});
	} catch (error) {
		if (error instanceof RemoteBodyTooLargeError) {
			throw new MetadataRequestTooLargeError(maximumBytes);
		}
		throw error;
	}
}

function parseRequestJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new MalformedRequestBodyError(error);
		}
		throw error;
	}
}

export async function parseCacheMetadataRequest(
	request: Request
): Promise<CacheMetadataRequest> {
	return parseRequestValue(
		cacheMetadataRequestSchema,
		parseRequestJson(
			await readRequestText(request, cacheMetadataMaxRequestBytes)
		)
	);
}

export async function parseCachePathInfoRequest(
	request: Request
): Promise<CacheMetadataRequest | CacheIntersectionRequest> {
	const text = await readRequestText(request, cacheIntersectionMaxRequestBytes);
	const value = parseRequestJson(text);
	if (
		typeof value === 'object' &&
		value !== null &&
		'operation' in value &&
		value.operation === 'intersection'
	) {
		if (
			'storePathHashes' in value &&
			Array.isArray(value.storePathHashes) &&
			value.storePathHashes.length > cacheIntersectionMaxHashes
		) {
			throw new MetadataIntersectionTooManyHashesError(
				value.storePathHashes.length,
				cacheIntersectionMaxHashes
			);
		}
		return parseRequestValue(cacheIntersectionRequestSchema, value);
	}
	if (utf8.encode(text).byteLength > cacheMetadataMaxRequestBytes) {
		throw new MetadataRequestTooLargeError();
	}
	return parseRequestValue(cacheMetadataRequestSchema, value);
}

export async function cacheMetadataPageResponse(
	scopeVersion: string,
	requested: readonly StorePathString[],
	source: AsyncIterable<CacheMetadataEntry> | Iterable<CacheMetadataEntry>,
	onPage?: (page: CacheMetadataResponse) => void
): Promise<Response> {
	const entries: CacheMetadataEntry[] = [];
	let isPartial = false;
	let bytes = utf8.encode(
		JSON.stringify({ scopeVersion, entries: [] })
	).byteLength;
	for await (const entry of source) {
		if (entry.storePath !== requested[entries.length]) {
			throw new MetadataNarInfoInvalidError(
				requested[entries.length],
				new Error(
					'The metadata entries do not match the requested store paths in order'
				)
			);
		}
		if (
			entry.status === 'found' &&
			utf8.encode(entry.narinfo).byteLength > cacheMetadataMaxNarInfoBytes
		) {
			throw new MetadataNarInfoTooLargeError(
				entry.storePath,
				cacheMetadataMaxNarInfoBytes
			);
		}
		const entryBytes =
			utf8.encode(JSON.stringify(entry)).byteLength +
			(entries.length > 0 ? 1 : 0);
		const continuationBytes = utf8.encode(
			`,"nextIndex":${String(entries.length + 1)}`
		).byteLength;
		if (
			bytes + entryBytes + continuationBytes >
			cacheMetadataMaxResponseBytes
		) {
			if (entries.length === 0) {
				throw new MetadataNarInfoTooLargeError(
					entry.storePath,
					cacheMetadataMaxResponseBytes
				);
			}
			isPartial = true;
			break;
		}
		entries.push(entry);
		bytes += entryBytes;
	}
	const unprocessed = requested[entries.length];
	if (!isPartial && unprocessed !== undefined) {
		throw new MetadataNarInfoInvalidError(
			unprocessed,
			new Error(
				'The metadata source ended before every requested store path was processed'
			)
		);
	}
	const response: CacheMetadataResponse = {
		scopeVersion,
		entries,
		...(isPartial && { nextIndex: entries.length })
	};
	onPage?.(response);
	return Response.json(response, { headers: { 'cache-control': 'no-store' } });
}
