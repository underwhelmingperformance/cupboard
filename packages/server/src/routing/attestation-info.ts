import { type StorePathHash } from '@cupboard/nix-store/scalars';
import {
	type AttestationInfoEntry,
	attestationInfoMaxListBytes,
	attestationInfoMaxRequestBytes,
	attestationInfoMaxResponseBytes,
	type AttestationInfoRequest,
	attestationInfoRequestSchema,
	type AttestationInfoResponse,
	attestationListSchema
} from '@cupboard/protocol/attestations';
import { bestEffort } from '@cupboard/shared/cleanup';
import { chunk } from '@cupboard/shared/collections';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import {
	readResponseBytes,
	readResponseText,
	RemoteBodyTooLargeError
} from '@cupboard/shared/response-body';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { type Context } from 'hono';

import {
	type AttestationListPublication,
	AttestationListRevisionRepository
} from '../db/attestation-list-revision.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { maxOutgoingConnections } from '../do/bulk.ts';
import {
	AttestationInfoHttpError,
	AttestationListPendingError,
	MalformedRequestBodyError,
	SharedFactsUnavailableError
} from '../errors.ts';
import { attestationListObjectKey } from '../http/http.ts';
import { parseRequestValue } from '../http/parse.ts';
import {
	isObjectOfListPublication,
	isSameListPublication
} from '../read/attestation-generation.ts';

import { tenantServer } from './durable-object.ts';
import { type WorkerHonoEnv } from './hono-env.ts';
import {
	cacheReadScopeVersion,
	revalidateCacheReadAuthority,
	revalidateCacheReadScope
} from './read-scope.ts';

function scopeChanged(): AttestationInfoHttpError {
	return new AttestationInfoHttpError(
		'scope-changed',
		'The cache changed during attestation discovery. Refresh the discovery page before retrying.'
	);
}

async function parseRequest(request: Request): Promise<AttestationInfoRequest> {
	let text: string;
	try {
		text = await readResponseText(request, {
			description: 'Attestation discovery request',
			maximumBytes: attestationInfoMaxRequestBytes
		});
	} catch (error) {
		if (error instanceof RemoteBodyTooLargeError) {
			throw new AttestationInfoHttpError(
				'request-too-large',
				'The attestation discovery request exceeds 64 KiB. Split the paths into smaller pages.'
			);
		}
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new MalformedRequestBodyError(error);
		}
		throw error;
	}
	return parseRequestValue(attestationInfoRequestSchema, value);
}

async function* entriesFor(
	context: Context<WorkerHonoEnv>,
	request: AttestationInfoRequest,
	publications: ReadonlyMap<StorePathHash, AttestationListPublication>
): AsyncGenerator<AttestationInfoEntry> {
	const scope = context.get('readScope');
	const tenant = context.get('tenant');

	for (const group of chunk(request.storePathHashes, maxOutgoingConnections)) {
		const entries = await mapWithConcurrency(
			group,
			maxOutgoingConnections,
			async (hash): Promise<AttestationInfoEntry> => {
				const publication = publications.get(hash);
				if (publication === undefined) {
					return { storePathHash: hash, status: 'missing' };
				}
				if (publication.state.status === 'pending') {
					throw new AttestationListPendingError(hash);
				}
				const found = {
					storePathHash: hash,
					status: 'found',
					narHash: publication.parent.narHash
				} as const;
				const key =
					publication.state.status === 'ready'
						? publication.state.key
						: attestationListObjectKey(
								tenant,
								hash,
								scope.scope,
								publication.parent.cacheGeneration
							);
				if (key === undefined) {
					return { ...found, attestations: [] };
				}
				let object: R2ObjectBody | null;
				try {
					object = await context.env.BLOBS.get(key);
				} catch (error) {
					throw new SharedFactsUnavailableError(error);
				}
				if (object === null) {
					if (publication.state.status === 'ready') {
						await bestEffort(() =>
							tenantServer(context.env, tenant).queueAttestationListRepair(
								scope.scope,
								hash,
								publication
							)
						);
						throw new AttestationListPendingError(hash);
					}
					return { ...found, attestations: [] };
				}
				if (!isObjectOfListPublication(object, scope, publication)) {
					await object.body.cancel();
					if (publication.state.status === 'ready') {
						await bestEffort(() =>
							tenantServer(context.env, tenant).queueAttestationListRepair(
								scope.scope,
								hash,
								publication
							)
						);
						throw new AttestationListPendingError(hash);
					}
					return { ...found, attestations: [] };
				}
				let bytes: Uint8Array;
				try {
					bytes = await readResponseBytes(new Response(object.body), {
						description: 'Attestation list',
						maximumBytes: attestationInfoMaxListBytes
					});
				} catch (error) {
					if (error instanceof RemoteBodyTooLargeError) {
						throw new AttestationInfoHttpError(
							'list-too-large',
							'The attestation list exceeds 1 MiB.',
							hash
						);
					}
					throw new SharedFactsUnavailableError(error);
				}
				let value: unknown;
				try {
					value = JSON.parse(
						new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
							bytes
						)
					);
				} catch (error) {
					throw new AttestationInfoHttpError(
						'list-invalid',
						'The cache returned an invalid attestation list.',
						hash,
						error
					);
				}
				const list = attestationListSchema.safeParse(value);
				if (!list.success) {
					throw new AttestationInfoHttpError(
						'list-invalid',
						'The cache returned an invalid attestation list.',
						hash,
						list.error
					);
				}
				return {
					...found,
					attestations: list.data.attestations.filter(
						(descriptor) =>
							request.predicateTypes === undefined ||
							request.predicateTypes.includes(descriptor.predicateType)
					)
				};
			}
		);
		yield* entries;
	}
}

async function pageResponse(
	version: string,
	requested: readonly StorePathHash[],
	source: AsyncIterable<AttestationInfoEntry> | Iterable<AttestationInfoEntry>
): Promise<Response> {
	const entries: AttestationInfoEntry[] = [];
	const utf8 = new TextEncoder();
	let bytes = utf8.encode(
		JSON.stringify({ scopeVersion: version, entries: [] })
	).byteLength;
	for await (const entry of source) {
		const entryBytes =
			utf8.encode(JSON.stringify(entry)).byteLength +
			(entries.length > 0 ? 1 : 0);
		const continuationBytes = utf8.encode(
			`,"nextIndex":${String(entries.length + 1)}`
		).byteLength;
		if (
			bytes + entryBytes + continuationBytes >
			attestationInfoMaxResponseBytes
		) {
			break;
		}
		entries.push(entry);
		bytes += entryBytes;
	}
	const response: AttestationInfoResponse = {
		scopeVersion: version,
		entries,
		...(entries.length < requested.length && { nextIndex: entries.length })
	};
	return Response.json(response, { headers: { 'cache-control': 'no-store' } });
}

export async function answerAttestationInfo(
	context: Context<WorkerHonoEnv>
): Promise<Response> {
	const request = await parseRequest(context.req.raw);
	const version = cacheReadScopeVersion(context);
	if (
		request.expectedScopeVersion !== undefined &&
		request.expectedScopeVersion !== version
	) {
		throw scopeChanged();
	}
	const repository = new AttestationListRevisionRepository(
		drizzleD1(context.env.CUPBOARD_DB, { schema: d1Schema }),
		context.get('tenant')
	);
	const publications = context.get('isCacheDeleted')
		? new Map<StorePathHash, AttestationListPublication>()
		: await repository.publicationsFor(
				context.get('readScope').scope,
				request.storePathHashes
			);
	const source = context.get('isCacheDeleted')
		? request.storePathHashes.map((storePathHash): AttestationInfoEntry => ({
				storePathHash,
				status: 'missing'
			}))
		: entriesFor(context, request, publications);
	const response = await pageResponse(version, request.storePathHashes, source);
	if (!context.get('isCacheDeleted')) {
		const latest = await repository.publicationsFor(
			context.get('readScope').scope,
			request.storePathHashes
		);
		for (const [hash, publication] of publications) {
			if (!isSameListPublication(publication, latest.get(hash))) {
				throw new AttestationListPendingError(hash);
			}
		}
	}

	await revalidateCacheReadScope(context, version, scopeChanged());
	await revalidateCacheReadAuthority(context);
	return response;
}
