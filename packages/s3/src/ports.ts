/**
 * The authenticated principal produced by signature verification. The S3
 * package treats it as opaque and passes it to every `ObjectStore` call so the
 * store can authorise the operation. An anonymous request has no `accessKeyId`.
 */
export interface S3Principal {
	readonly accessKeyId?: string;
	readonly tenant: string;
	readonly cache: string;
	readonly grants: readonly string[];
	readonly label?: string;
	readonly credentialId?: string;
}

/**
 * A credential selected by its access key ID. It contains the shared secret
 * used to verify a SigV4 signature and the principal that the credential
 * authenticates.
 */
export interface ResolvedCredential {
	readonly secretAccessKey: string;
	readonly sessionToken?: string;
	readonly principal: S3Principal;
}

/**
 * Looks up an S3 credential by its access key ID. Returns `undefined` for an
 * unknown key. The request handler then returns `SignatureDoesNotMatch` without
 * revealing whether the key exists.
 */
export interface CredentialResolver {
	resolve(accessKeyId: string): Promise<ResolvedCredential | undefined>;
}

/**
 * A byte range request. `suffix` selects the final N bytes; otherwise `offset`
 * (and optional `length`) select a window from the start.
 */
export type ByteRange =
	| { readonly offset: number; readonly length?: number }
	| { readonly suffix: number };

/**
 * Metadata for a stored object, sourced from the backing store so that ETag and
 * `lastModified` reflect what the backend actually holds.
 */
export interface ObjectStat {
	readonly size: number;
	readonly etag: string;
	readonly contentType?: string;
	readonly lastModified: Date;
}

export interface GetObjectResult {
	readonly stat: ObjectStat;
	readonly body: ReadableStream<Uint8Array>;
	/**
	Present when a range was satisfied: the resolved [start, end] inclusive.
	*/
	readonly range?: { readonly start: number; readonly end: number };
}

export interface PutObjectResult {
	readonly etag: string;
}

export interface ListObjectsQuery {
	readonly prefix: string;
	readonly delimiter: string | undefined;
	readonly continuationToken: string | undefined;
	readonly maxKeys: number;
}

export interface ListedObject {
	readonly key: string;
	readonly size: number;
	readonly etag: string;
	readonly lastModified: Date;
}

export interface ListObjectsResult {
	readonly objects: readonly ListedObject[];
	readonly commonPrefixes: readonly string[];
	readonly isTruncated: boolean;
	readonly nextContinuationToken: string | undefined;
}

export interface MultipartUpload {
	readonly uploadId: string;
}

export interface UploadedPart {
	readonly partNumber: number;
	readonly etag: string;
}

export interface CompletedUpload {
	readonly etag: string;
}

/**
 * The bucket, key and authenticated principal for an `ObjectStore` operation.
 * The principal is `undefined` for an anonymous request. The store authorises
 * the operation and rejects keys or operations outside its contract.
 */
export interface ObjectContext {
	readonly bucket: string;
	readonly key: string;
	readonly principal: S3Principal | undefined;
}

/**
 * An object store behind the generic S3 server. An implementation can store
 * objects verbatim or by content, render them, or compute them. The server
 * implements the S3 protocol and delegates object behaviour to the store.
 */
export interface ObjectStore {
	stat(context: ObjectContext): Promise<ObjectStat | undefined>;
	get(
		context: ObjectContext,
		range: ByteRange | undefined
	): Promise<GetObjectResult | undefined>;
	put(
		context: ObjectContext,
		body: ReadableStream<Uint8Array>,
		meta: PutObjectMeta
	): Promise<PutObjectResult>;
	delete(context: ObjectContext): Promise<void>;
	list(
		bucket: string,
		query: ListObjectsQuery,
		principal: S3Principal | undefined
	): Promise<ListObjectsResult>;
	bucketExists(
		bucket: string,
		principal: S3Principal | undefined
	): Promise<boolean>;

	createMultipartUpload(
		context: ObjectContext,
		meta: PutObjectMeta
	): Promise<MultipartUpload>;
	uploadPart(
		context: ObjectContext,
		uploadId: string,
		partNumber: number,
		contentLength: number | undefined,
		body: ReadableStream<Uint8Array>
	): Promise<UploadedPart>;
	completeMultipartUpload(
		context: ObjectContext,
		uploadId: string,
		parts: readonly UploadedPart[]
	): Promise<CompletedUpload>;
	abortMultipartUpload(context: ObjectContext, uploadId: string): Promise<void>;
}

export interface PutObjectMeta {
	readonly contentType: string | undefined;
	readonly contentLength: number | undefined;
	/**
	Base64 SHA-256 from `x-amz-checksum-sha256`, when the client sent one.
	*/
	readonly checksumSha256: string | undefined;
}
