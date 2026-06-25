/**
 * The authenticated principal a verified request resolves to. The S3 package
 * treats it as opaque, threading it into every `ObjectStore` call so the store
 * can authorise. `accessKeyId` is absent for an anonymous (unsigned) request.
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
 * A credential resolved from its access key id: the shared secret needed to
 * verify the SigV4 signature, plus the principal it authenticates as.
 */
export interface ResolvedCredential {
	readonly secretAccessKey: string;
	readonly sessionToken?: string;
	readonly principal: S3Principal;
}

/**
 * Looks up an S3 credential by its access key id. Returns `undefined` when no
 * such credential exists, so the package can answer `SignatureDoesNotMatch`
 * without leaking whether the key is known.
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
	/** Present when a range was satisfied: the resolved [start, end] inclusive. */
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
 * The context every `ObjectStore` call receives: the addressed bucket and key,
 * and the authenticated principal (`undefined` for an anonymous request). The
 * store is responsible for authorisation and for rejecting keys or operations
 * outside its contract.
 */
export interface ObjectContext {
	readonly bucket: string;
	readonly key: string;
	readonly principal: S3Principal | undefined;
}

/**
 * A virtual object store the generic S3 server projects. Implementations decide
 * whether an object is stored verbatim, content-addressed, rendered, or
 * computed; the server only speaks the protocol.
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
	/** Base64 SHA-256 from `x-amz-checksum-sha256`, when the client sent one. */
	readonly checksumSha256: string | undefined;
}
