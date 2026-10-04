import { type StorePathString } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	type CacheMetadataEntry,
	cacheMetadataMaxNarInfoBytes
} from '@cupboard/protocol/cache-metadata';
import { discardResponseBody } from '@cupboard/shared/cleanup';
import { chunk } from '@cupboard/shared/collections';
import {
	readResponseBytes,
	readResponseText,
	RemoteBodyTooLargeError
} from '@cupboard/shared/response-body';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { type Context } from 'hono';

import * as d1Schema from '../db/d1-schema.ts';
import { maxOutgoingConnections } from '../do/bulk.ts';
import {
	MetadataNarInfoInvalidError,
	MetadataNarInfoTooLargeError,
	MetadataScopeChangedError,
	SharedFactsUnavailableError
} from '../errors.ts';
import {
	cacheMetadataPageResponse,
	parseCacheMetadataRequest
} from '../read/metadata-page.ts';
import {
	readCacheMetadata,
	renderCacheMetadataEntry
} from '../read/metadata-read.ts';

import { type WorkerHonoEnv } from './hono-env.ts';
import {
	cacheReadScopeVersion,
	revalidateCacheReadAuthority,
	revalidateCacheReadScope
} from './read-scope.ts';
import { cachedTenantRead, withoutStoring } from './tenant-forward.ts';

class ForwardedMetadataRefusal extends Error {
	constructor(readonly response: Response) {
		super(
			`The cache returned HTTP ${String(response.status)} while reading metadata.`
		);
		this.name = 'ForwardedMetadataRefusal';
	}
}

async function publicEntry(
	context: Context<WorkerHonoEnv>,
	storePath: StorePathString
): Promise<CacheMetadataEntry> {
	const target = new URL(context.req.url);
	target.pathname = target.pathname.replace(
		/\/api\/v1\/path-info$/u,
		() => `/${StorePath.hash(storePath)}.narinfo`
	);
	let response: Response;
	try {
		response = await cachedTenantRead(
			context,
			new Request(target, { headers: { accept: 'text/x-nix-narinfo' } })
		);
	} catch (error) {
		throw new SharedFactsUnavailableError(error);
	}
	if (response.status === 404) {
		await discardResponseBody(response);
		return { storePath, status: 'missing' };
	}
	if (!response.ok) {
		if (response.status < 400) {
			await discardResponseBody(response);
			throw new MetadataNarInfoInvalidError(
				storePath,
				new Error(
					`The canonical narinfo request returned HTTP ${String(response.status)}`
				)
			);
		}
		const body = await readResponseText(response, {
			description: 'Metadata read refusal',
			maximumBytes: 8192
		});
		const headers = new Headers(response.headers);
		headers.delete('content-length');
		throw new ForwardedMetadataRefusal(
			new Response(body, { status: response.status, headers })
		);
	}
	let bytes: Uint8Array;
	try {
		bytes = await readResponseBytes(response, {
			description: `Narinfo for ${storePath}`,
			maximumBytes: cacheMetadataMaxNarInfoBytes
		});
	} catch (error) {
		if (error instanceof RemoteBodyTooLargeError) {
			throw new MetadataNarInfoTooLargeError(
				storePath,
				cacheMetadataMaxNarInfoBytes
			);
		}
		throw new SharedFactsUnavailableError(error);
	}
	let body: string;
	try {
		body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
			bytes
		);
	} catch (error) {
		throw new MetadataNarInfoInvalidError(storePath, error);
	}
	return renderCacheMetadataEntry(storePath, body);
}

async function* publicEntries(
	context: Context<WorkerHonoEnv>,
	paths: readonly StorePathString[]
): AsyncGenerator<CacheMetadataEntry> {
	for (const group of chunk(paths, maxOutgoingConnections)) {
		const outcomes = await Promise.allSettled(
			group.map((storePath) => publicEntry(context, storePath))
		);
		const failed = outcomes.find((outcome) => outcome.status === 'rejected');
		if (failed !== undefined) {
			const error: unknown = failed.reason;
			throw error;
		}
		for (const outcome of outcomes) {
			if (outcome.status === 'fulfilled') {
				yield outcome.value;
			}
		}
	}
}

export async function answerCacheMetadata(
	context: Context<WorkerHonoEnv>
): Promise<Response> {
	const request = await parseCacheMetadataRequest(context.req.raw);
	const version = cacheReadScopeVersion(context);
	if (
		request.expectedScopeVersion !== undefined &&
		request.expectedScopeVersion !== version
	) {
		throw new MetadataScopeChangedError();
	}
	const paths = request.storePaths;
	const entries = context.get('isCacheDeleted')
		? paths.map((storePath): CacheMetadataEntry => ({
				storePath,
				status: 'missing'
			}))
		: context.get('readScope').access === 'public'
			? publicEntries(context, paths)
			: readCacheMetadata(
					context.env.BLOBS,
					drizzleD1(context.env.CUPBOARD_DB, { schema: d1Schema }),
					context.get('tenant'),
					context.get('readScope'),
					paths
				);
	try {
		const response = await cacheMetadataPageResponse(version, paths, entries);
		await revalidateCacheReadScope(context, version);
		await revalidateCacheReadAuthority(context);
		return response;
	} catch (error) {
		if (error instanceof ForwardedMetadataRefusal) {
			return withoutStoring(error.response);
		}
		throw error;
	}
}
