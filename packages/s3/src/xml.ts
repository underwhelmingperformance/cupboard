import Builder from 'fast-xml-builder';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';

const declaration = '<?xml version="1.0" encoding="UTF-8"?>';
// The S3 XML namespace is a fixed identifier string defined by the S3 API, not a
// fetchable URL. AWS, R2 and MinIO all emit the `http` form verbatim, so we match
// it rather than "upgrade" the scheme.
// eslint-disable-next-line unicorn/prefer-https -- fixed S3 namespace identifier
const s3Namespace = 'http://s3.amazonaws.com/doc/2006-03-01/';

const builder = new Builder({
	ignoreAttributes: false,
	attributeNamePrefix: '@_',
	suppressEmptyNode: false,
	processEntities: true
});

const parser = new XMLParser({
	ignoreAttributes: true,
	parseTagValue: false,
	processEntities: true,
	isArray: (name) => name === 'Part' || name === 'Object'
});

/**
 * Serialises a single-rooted document to XML with the standard declaration,
 * delegating element rendering and entity escaping to `fast-xml-parser`.
 */
function buildDocument(root: Record<string, unknown>): string {
	return `${declaration}${builder.build(root)}`;
}

/**
 * Wraps an ETag in the double quotes S3 always emits, unless already quoted.
 */
export function quoteEtag(etag: string): string {
	if (etag.startsWith('"') && etag.endsWith('"')) {
		return etag;
	}

	return `"${etag}"`;
}

/**
 * Renders the canonical S3 `<Error>` document.
 */
export function buildErrorXml(
	code: string,
	message: string,
	requestId: string,
	resource: string | undefined
): string {
	return buildDocument({
		Error: {
			Code: code,
			Message: message,
			...(resource !== undefined && { Resource: resource }),
			RequestId: requestId
		}
	});
}

interface ListObjectEntry {
	readonly key: string;
	readonly lastModified: Date;
	readonly etag: string;
	readonly size: number;
}

export interface ListObjectsRender {
	readonly bucket: string;
	readonly prefix: string;
	readonly delimiter: string | undefined;
	readonly maxKeys: number;
	readonly keyCount: number;
	readonly isTruncated: boolean;
	readonly continuationToken: string | undefined;
	readonly nextContinuationToken: string | undefined;
	readonly contents: readonly ListObjectEntry[];
	readonly commonPrefixes: readonly string[];
}

function contentNode(entry: ListObjectEntry): Record<string, unknown> {
	return {
		Key: entry.key,
		LastModified: entry.lastModified.toISOString(),
		ETag: quoteEtag(entry.etag),
		Size: entry.size,
		StorageClass: 'STANDARD'
	};
}

/**
 * Renders a `ListObjectsV2` (`list-type=2`) success body.
 */
export function renderListObjectsV2(result: ListObjectsRender): string {
	return buildDocument({
		ListBucketResult: {
			'@_xmlns': s3Namespace,
			Name: result.bucket,
			Prefix: result.prefix,
			KeyCount: result.keyCount,
			MaxKeys: result.maxKeys,
			IsTruncated: result.isTruncated,
			...(result.delimiter !== undefined && { Delimiter: result.delimiter }),
			...(result.continuationToken !== undefined && {
				ContinuationToken: result.continuationToken
			}),
			...(result.nextContinuationToken !== undefined && {
				NextContinuationToken: result.nextContinuationToken
			}),
			Contents: result.contents.map((entry) => contentNode(entry)),
			CommonPrefixes: result.commonPrefixes.map((prefix) => ({
				Prefix: prefix
			}))
		}
	});
}

/**
 * Renders a legacy `ListObjects` (v1) success body, which uses marker-based
 * pagination rather than continuation tokens.
 */
export function renderListObjectsV1(result: ListObjectsRender): string {
	return buildDocument({
		ListBucketResult: {
			'@_xmlns': s3Namespace,
			Name: result.bucket,
			Prefix: result.prefix,
			Marker: result.continuationToken ?? '',
			...(result.nextContinuationToken !== undefined && {
				NextMarker: result.nextContinuationToken
			}),
			MaxKeys: result.maxKeys,
			IsTruncated: result.isTruncated,
			...(result.delimiter !== undefined && { Delimiter: result.delimiter }),
			Contents: result.contents.map((entry) => contentNode(entry)),
			CommonPrefixes: result.commonPrefixes.map((prefix) => ({
				Prefix: prefix
			}))
		}
	});
}

/**
 * Renders the `CreateMultipartUpload` (`?uploads`) response body.
 */
export function renderInitiateMultipartUpload(
	bucket: string,
	key: string,
	uploadId: string
): string {
	return buildDocument({
		InitiateMultipartUploadResult: {
			'@_xmlns': s3Namespace,
			Bucket: bucket,
			Key: key,
			UploadId: uploadId
		}
	});
}

/**
 * Renders the `CompleteMultipartUpload` success body.
 */
export function renderCompleteMultipartUpload(
	location: string,
	bucket: string,
	key: string,
	etag: string
): string {
	return buildDocument({
		CompleteMultipartUploadResult: {
			'@_xmlns': s3Namespace,
			Location: location,
			Bucket: bucket,
			Key: key,
			ETag: quoteEtag(etag)
		}
	});
}

/**
 * Renders the `GetBucketLocation` response body.
 */
export function renderBucketLocation(region: string): string {
	return buildDocument({
		LocationConstraint: { '@_xmlns': s3Namespace, '#text': region }
	});
}

export interface DeleteObjectsError {
	readonly key: string;
	readonly code: string;
	readonly message: string;
}

/**
 * Renders the `DeleteObjects` (`?delete`) batch response body.
 */
export function renderDeleteResult(
	deleted: readonly string[],
	errors: readonly DeleteObjectsError[]
): string {
	return buildDocument({
		DeleteResult: {
			'@_xmlns': s3Namespace,
			Deleted: deleted.map((key) => ({ Key: key })),
			Error: errors.map((error) => ({
				Key: error.key,
				Code: error.code,
				Message: error.message
			}))
		}
	});
}

const completedPartSchema = z.object({
	PartNumber: z.coerce.number().int().min(1),
	ETag: z.coerce.string()
});

const completeUploadSchema = z.object({
	CompleteMultipartUpload: z.object({ Part: z.array(completedPartSchema) })
});

export interface CompletedPart {
	readonly partNumber: number;
	readonly etag: string;
}

/**
 * Renders a `CompleteMultipartUpload` request body from a part list.
 */
export function renderCompleteMultipartUploadRequest(
	parts: readonly CompletedPart[]
): string {
	return buildDocument({
		CompleteMultipartUpload: {
			Part: parts.map((part) => ({
				PartNumber: part.partNumber,
				ETag: quoteEtag(part.etag)
			}))
		}
	});
}

/**
 * Parses a `CompleteMultipartUpload` request body into its part list, ordered
 * by part number.
 */
export function parseCompleteMultipartUpload(body: string): CompletedPart[] {
	const parsed = completeUploadSchema.parse(parser.parse(body));
	return parsed.CompleteMultipartUpload.Part.map((part) => ({
		partNumber: part.PartNumber,
		etag: unquoteEtag(part.ETag)
	})).toSorted((left, right) => left.partNumber - right.partNumber);
}

const deletionTargetSchema = z.object({ Key: z.coerce.string() });

const deletionRequestSchema = z.object({
	Delete: z.object({
		Object: z.array(deletionTargetSchema),
		Quiet: z
			.string()
			.optional()
			.transform((value) => value === 'true')
	})
});

export interface ParsedDeleteObjects {
	readonly keys: readonly string[];
	/** When set, only errored entries are reported, not successful deletions. */
	readonly quiet: boolean;
}

/**
 * Parses a `DeleteObjects` request body into the keys to remove and the `Quiet`
 * flag governing how the result is reported.
 */
export function parseDeleteObjects(body: string): ParsedDeleteObjects {
	const parsed = deletionRequestSchema.parse(parser.parse(body));
	return {
		keys: parsed.Delete.Object.map((object) => object.Key),
		quiet: parsed.Delete.Quiet
	};
}

const listParser = new XMLParser({
	ignoreAttributes: true,
	parseTagValue: false,
	processEntities: true,
	isArray: (name) => name === 'Contents' || name === 'CommonPrefixes'
});

const listContentSchema = z.object({
	Key: z.coerce.string(),
	LastModified: z.coerce.string(),
	ETag: z.coerce.string(),
	Size: z.coerce.number().int()
});

const commonPrefixSchema = z.object({ Prefix: z.coerce.string() });

const listBucketResultSchema = z.object({
	IsTruncated: z
		.string()
		.optional()
		.transform((value) => value === 'true'),
	NextContinuationToken: z.coerce.string().optional(),
	NextMarker: z.coerce.string().optional(),
	Contents: z.array(listContentSchema).default([]),
	CommonPrefixes: z.array(commonPrefixSchema).default([])
});

const listResultSchema = z.object({ ListBucketResult: listBucketResultSchema });

export interface ParsedListObject {
	readonly key: string;
	readonly size: number;
	readonly etag: string;
	readonly lastModified: Date;
}

export interface ParsedListResult {
	readonly objects: readonly ParsedListObject[];
	readonly commonPrefixes: readonly string[];
	readonly isTruncated: boolean;
	readonly nextContinuationToken: string | undefined;
}

/**
 * Parses a `ListObjectsV2`/`ListObjects` response body. Used by the passthrough
 * provider to relay a listing from a backing S3 service.
 */
export function parseListResult(body: string): ParsedListResult {
	const { ListBucketResult: result } = listResultSchema.parse(
		listParser.parse(body)
	);

	return {
		objects: result.Contents.map((entry) => ({
			key: entry.Key,
			size: entry.Size,
			etag: unquoteEtag(entry.ETag),
			lastModified: new Date(entry.LastModified)
		})),
		commonPrefixes: result.CommonPrefixes.map((entry) => entry.Prefix),
		isTruncated: result.IsTruncated,
		nextContinuationToken: result.NextContinuationToken ?? result.NextMarker
	};
}

const uploadIdSchema = z.object({
	InitiateMultipartUploadResult: z.object({ UploadId: z.coerce.string() })
});

/**
 * Parses an `UploadId` from a `CreateMultipartUpload` response body.
 */
export function parseUploadId(body: string): string {
	return uploadIdSchema.parse(parser.parse(body)).InitiateMultipartUploadResult
		.UploadId;
}

const completeResultSchema = z.object({
	CompleteMultipartUploadResult: z.object({ ETag: z.coerce.string() })
});

/**
 * Parses the resulting object ETag from a `CompleteMultipartUpload` response.
 */
export function parseCompletedEtag(body: string): string {
	return unquoteEtag(
		completeResultSchema.parse(parser.parse(body)).CompleteMultipartUploadResult
			.ETag
	);
}

/**
 * Strips the surrounding quotes S3 wraps around ETags, if present.
 */
export function unquoteEtag(etag: string): string {
	if (etag.startsWith('"') && etag.endsWith('"')) {
		return etag.slice(1, -1);
	}

	return etag;
}
