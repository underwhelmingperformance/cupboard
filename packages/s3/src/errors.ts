import { StatusCodes } from 'http-status-codes';

import { buildErrorXml } from './xml.ts';

/**
 * The S3 error codes this server can return. Each concrete {@link S3Error}
 * specifies one code for the wire `<Code>` element. The union keeps the
 * supported codes enumerable and typed.
 */
export type S3ErrorCode =
	| 'AccessDenied'
	| 'BadDigest'
	| 'EntityTooLarge'
	| 'InternalError'
	| 'InvalidArgument'
	| 'InvalidPart'
	| 'InvalidPartOrder'
	| 'InvalidRange'
	| 'InvalidRequest'
	| 'MalformedXML'
	| 'MethodNotAllowed'
	| 'MissingContentLength'
	| 'NoSuchBucket'
	| 'NoSuchKey'
	| 'NoSuchUpload'
	| 'NotImplemented'
	| 'PreconditionFailed'
	| 'ServiceUnavailable'
	| 'SignatureDoesNotMatch';

/**
 * The base class for S3 protocol errors. Each request handler throws a concrete
 * subclass for one condition, which lets callers and tests match the error
 * type. The request boundary renders every `S3Error` as the canonical S3
 * `<Error>` response.
 */
export abstract class S3Error extends Error {
	abstract readonly code: S3ErrorCode;
	abstract readonly status: number;

	constructor(
		message: string,
		readonly resource?: string | undefined,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = new.target.name;
	}

	toResponse(requestId: string): Response {
		const body = buildErrorXml(
			this.code,
			this.message,
			requestId,
			this.resource
		);
		return new Response(body, {
			status: this.status,
			headers: {
				'content-type': 'application/xml',
				'x-amz-request-id': requestId
			}
		});
	}
}

// --- AccessDenied (403) --------------------------------------------------

abstract class AccessDeniedError extends S3Error {
	readonly code = 'AccessDenied';
	readonly status = StatusCodes.FORBIDDEN;
}

/**
A request reached a signed-only route without any SigV4 credentials.
*/
export class RequestNotSignedError extends AccessDeniedError {
	constructor() {
		super('Request is not signed.');
	}
}

/**
A header-signed request's timestamp fell outside the clock-skew window.
*/
export class ClockSkewExceededError extends AccessDeniedError {
	constructor() {
		super('Request time is outside the permitted window.');
	}
}

/**
A presigned URL was used after its `X-Amz-Expires` window elapsed.
*/
export class PresignedUrlExpiredError extends AccessDeniedError {
	constructor() {
		super('Request has expired.');
	}
}

/**
The request's signing timestamp is later than the server's current time.
*/
export class RequestNotYetValidError extends AccessDeniedError {
	constructor() {
		super('Request is not yet valid.');
	}
}

/**
An unauthenticated request reached a route that requires a credential.
*/
export class AnonymousAccessDeniedError extends AccessDeniedError {
	constructor() {
		super('Anonymous access is not permitted.');
	}
}

/**
A request used a credential for a cache outside the credential's scope.
*/
export class CredentialCacheMismatchError extends AccessDeniedError {
	constructor() {
		super('Credential is not scoped to this cache.');
	}
}

/**
A credential attempted a write without the upload grant.
*/
export class CredentialCannotWriteError extends AccessDeniedError {
	constructor() {
		super('Credential cannot write to this cache.');
	}
}

/**
The addressed tenant is suspended or offboarding, so it does not accept writes.
*/
export class WritesNotAcceptedError extends AccessDeniedError {
	constructor() {
		super('This tenant is not currently accepting writes.');
	}
}

/**
An S3 request used plaintext outside an explicitly enabled local deployment.
*/
export class InsecureTransportError extends AccessDeniedError {
	constructor() {
		super('S3 requests require HTTPS.');
	}
}

// --- SignatureDoesNotMatch (403) -----------------------------------------

/**
The re-signed canonical request did not reproduce the client's signature.
*/
export class SignatureDoesNotMatchError extends S3Error {
	readonly code = 'SignatureDoesNotMatch';
	readonly status = StatusCodes.FORBIDDEN;

	constructor() {
		super('The request signature does not match.');
	}
}

// --- InvalidRequest (400) ------------------------------------------------

abstract class InvalidRequestError extends S3Error {
	readonly code = 'InvalidRequest';
	readonly status = StatusCodes.BAD_REQUEST;
}

/**
The `Authorization` header specified a scheme other than AWS4-HMAC-SHA256.
*/
export class UnsupportedAuthorizationSchemeError extends InvalidRequestError {
	constructor() {
		super('Unsupported authorization scheme.');
	}
}

/**
The `Authorization` header could not be parsed into its SigV4 parts.
*/
export class MalformedAuthorizationHeaderError extends InvalidRequestError {
	constructor() {
		super('Malformed Authorization header.');
	}
}

/**
A presigned URL specified a signing algorithm other than AWS4-HMAC-SHA256.
*/
export class UnsupportedSigningAlgorithmError extends InvalidRequestError {
	constructor() {
		super('Unsupported signing algorithm.');
	}
}

/**
A presigned URL was missing a required `X-Amz-*` query parameter.
*/
export class MalformedPresignedUrlError extends InvalidRequestError {
	constructor() {
		super('Malformed presigned URL.');
	}
}

/**
The SigV4 credential scope was not the expected five-part value.
*/
export class MalformedCredentialScopeError extends InvalidRequestError {
	constructor() {
		super('Malformed credential scope.');
	}
}

/**
The `X-Amz-Date` value was not a valid AWS basic-format timestamp.
*/
export class InvalidAmzDateError extends InvalidRequestError {
	constructor() {
		super('Invalid X-Amz-Date.');
	}
}

/**
The `X-Amz-Expires` parameter was absent, non-numeric or outside the permitted range.
*/
export class InvalidAmzExpiresError extends InvalidRequestError {
	constructor() {
		super('Invalid X-Amz-Expires.');
	}
}

/**
The declared request-body length was not a valid non-negative integer.
*/
export class InvalidContentLengthError extends InvalidRequestError {
	constructor() {
		super('Invalid Content-Length.');
	}
}

/**
The request used a payload hash mode this server cannot verify.
*/
export class UnsupportedPayloadModeError extends InvalidRequestError {
	constructor() {
		super('The signed payload mode is not supported.');
	}
}

/**
An aws-chunked request body was framed incorrectly.
*/
export class MalformedChunkedEncodingError extends InvalidRequestError {
	constructor() {
		super('Malformed aws-chunked encoding.');
	}
}

/**
An aws-chunked request body ended before its declared chunk data.
*/
export class TruncatedChunkedBodyError extends InvalidRequestError {
	constructor() {
		super('Truncated aws-chunked body.');
	}
}

/**
The body of a narinfo `PUT` could not be parsed as a narinfo.
*/
export class MalformedNarInfoError extends InvalidRequestError {
	constructor() {
		super('Malformed narinfo body.');
	}
}

/**
A narinfo body did not match its object key or was otherwise invalid.
*/
export class NarInfoMismatchError extends InvalidRequestError {
	constructor() {
		super('narinfo does not match the object key or is invalid.');
	}
}

/**
A narinfo PUT body exceeded the maximum accepted size.
*/
export class NarInfoTooLargeError extends InvalidRequestError {
	constructor() {
		super('The narinfo body is too large.');
	}
}

/**
The upload did not commit the requested narinfo for its store path.
*/
export class NarInfoNotCommittableError extends InvalidRequestError {
	constructor() {
		super('The narinfo could not be committed for this path.');
	}
}

// --- MissingContentLength (411) -----------------------------------------

/**
An operation requires the decoded body length, but the request omitted it.
*/
export class MissingContentLengthError extends S3Error {
	readonly code = 'MissingContentLength';
	readonly status = StatusCodes.LENGTH_REQUIRED;

	constructor() {
		super('You must provide the Content-Length HTTP header.');
	}
}

// --- InvalidArgument (400) -----------------------------------------------

abstract class InvalidArgumentError extends S3Error {
	readonly code = 'InvalidArgument';
	readonly status = StatusCodes.BAD_REQUEST;
}

/**
The multipart `partNumber` was not an integer in the 1..10000 range.
*/
export class InvalidPartNumberError extends InvalidArgumentError {
	constructor() {
		super('Invalid part number.');
	}
}

/**
The `Range` header was a malformed `bytes=` value.
*/
export class InvalidRangeHeaderError extends InvalidArgumentError {
	constructor() {
		super('Invalid Range header.');
	}
}

/**
The `max-keys` listing parameter was negative or not an integer.
*/
export class InvalidMaxKeysError extends InvalidArgumentError {
	constructor() {
		super('Invalid max-keys.');
	}
}

/**
The request path carried malformed percent-encoding.
*/
export class MalformedPathEncodingError extends InvalidArgumentError {
	constructor() {
		super('Malformed percent-encoding in path.');
	}
}

// --- InvalidPartOrder (400) ---------------------------------------------

/**
A multipart completion listed parts out of order or more than once.
*/
export class InvalidPartOrderError extends S3Error {
	readonly code = 'InvalidPartOrder';
	readonly status = StatusCodes.BAD_REQUEST;

	constructor() {
		super('The list of parts was not in ascending order.');
	}
}

// --- InvalidPart (400) --------------------------------------------------

/**
A multipart completion refers to a missing part or supplies the wrong ETag.
*/
export class InvalidPartError extends S3Error {
	readonly code = 'InvalidPart';
	readonly status = StatusCodes.BAD_REQUEST;

	constructor(options?: ErrorOptions) {
		super(
			'One or more of the specified parts could not be found.',
			undefined,
			options
		);
	}
}

// --- InvalidRange (416) --------------------------------------------------

/**
The requested byte range cannot be satisfied for the object.
*/
export class InvalidRangeError extends S3Error {
	readonly code = 'InvalidRange';
	readonly status = StatusCodes.REQUESTED_RANGE_NOT_SATISFIABLE;

	constructor(resource?: string) {
		super('The requested range is not satisfiable.', resource);
	}
}

// --- MalformedXML (400) --------------------------------------------------

abstract class MalformedXmlError extends S3Error {
	readonly code = 'MalformedXML';
	readonly status = StatusCodes.BAD_REQUEST;
}

/**
A request body was not well-formed XML or failed schema validation.
*/
export class MalformedXmlBodyError extends MalformedXmlError {
	constructor() {
		super('The XML you provided was not well-formed or did not validate.');
	}
}

/**
A `DeleteObjects` request contained more than the maximum of 1,000 keys.
*/
export class DeleteObjectsTooManyKeysError extends MalformedXmlError {
	constructor() {
		super('A DeleteObjects request may not exceed 1000 keys.');
	}
}

/**
The XML body for `DeleteObjects` or `CompleteMultipartUpload` exceeded the size limit.
*/
export class ControlBodyTooLargeError extends MalformedXmlError {
	constructor() {
		super('The request body is too large.');
	}
}

// --- NotImplemented (501) ------------------------------------------------

abstract class NotImplementedError extends S3Error {
	readonly code = 'NotImplemented';
	readonly status = StatusCodes.NOT_IMPLEMENTED;
}

/**
The server does not support `ListParts`.
*/
export class ListPartsNotImplementedError extends NotImplementedError {
	constructor() {
		super('ListParts is not supported.');
	}
}

/**
The request did not resolve to any supported S3 operation.
*/
export class UnsupportedOperationError extends NotImplementedError {
	constructor() {
		super('The requested operation is not supported.');
	}
}

/**
A write targeted a key that is neither a narinfo nor a NAR object.
*/
export class NonCacheWriteError extends NotImplementedError {
	constructor(resource?: string) {
		super('Only narinfo and NAR objects can be written.', resource);
	}
}

/**
The cache does not yet support object deletion through S3.
*/
export class DeletionNotImplementedError extends NotImplementedError {
	constructor() {
		super('Object deletion is not yet supported.');
	}
}

// --- BadDigest (400) -----------------------------------------------------

abstract class BadDigestError extends S3Error {
	readonly code = 'BadDigest';
	readonly status = StatusCodes.BAD_REQUEST;
}

/**
The uploaded NAR did not verify against the narinfo, or was never staged.
*/
export class UploadDigestMismatchError extends BadDigestError {
	constructor() {
		super(
			'The uploaded NAR does not match the narinfo, or was not uploaded first.'
		);
	}
}

/**
The uploaded NAR bytes do not hash to the file hash named in the key.
*/
export class NarChecksumMismatchError extends BadDigestError {
	constructor() {
		super('The uploaded NAR bytes do not match the requested key.');
	}
}

// --- EntityTooLarge (400) ------------------------------------------------

/**
The upload exceeds the tenant's storage quota or verifiable size.
*/
export class UploadOverQuotaError extends S3Error {
	readonly code = 'EntityTooLarge';
	readonly status = StatusCodes.BAD_REQUEST;

	constructor() {
		super('Upload exceeds the cache quota.');
	}
}

// --- ServiceUnavailable (503) --------------------------------------------

/**
The upload is staged but not yet verified; the client may retry shortly.
*/
export class UploadStillPendingError extends S3Error {
	readonly code = 'ServiceUnavailable';
	readonly status = StatusCodes.SERVICE_UNAVAILABLE;

	constructor() {
		super('The upload is still being verified; retry shortly.');
	}
}

/**
Another request is completing the same multipart upload.
*/
export class MultipartUploadAlreadyCompletingError extends S3Error {
	readonly code = 'ServiceUnavailable';
	readonly status = StatusCodes.SERVICE_UNAVAILABLE;

	constructor() {
		super('The multipart upload is already being completed; retry shortly.');
	}
}

/**
Cleanup is deleting the staged object for this multipart upload.
*/
export class StagedObjectBeingDeletedError extends S3Error {
	readonly code = 'ServiceUnavailable';
	readonly status = StatusCodes.SERVICE_UNAVAILABLE;

	constructor() {
		super('The staged object is being deleted; retry shortly.');
	}
}

/**
An upload reached no terminal state; treated as an internal inconsistency.
*/
export class UploadNotSettledError extends S3Error {
	readonly code = 'InternalError';
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor() {
		super('The narinfo upload did not reach a terminal state.');
	}
}

/**
A committed narinfo could not be read back; an internal inconsistency.
*/
export class CommittedNarInfoUnreadableError extends S3Error {
	readonly code = 'InternalError';
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor() {
		super('The narinfo was committed but could not be read back.');
	}
}

// --- NoSuchKey / NoSuchBucket (404) --------------------------------------

/**
The key does not exist or the cache contract does not expose it.
*/
export class NoSuchKeyError extends S3Error {
	readonly code = 'NoSuchKey';
	readonly status = StatusCodes.NOT_FOUND;

	constructor(resource?: string) {
		super('The specified key does not exist.', resource);
	}
}

/**
The named bucket does not exist.
*/
export class NoSuchBucketError extends S3Error {
	readonly code = 'NoSuchBucket';
	readonly status = StatusCodes.NOT_FOUND;

	constructor() {
		super('The specified bucket does not exist.');
	}
}

/**
The multipart upload ID is unknown, aborted or already completed.
*/
export class NoSuchUploadError extends S3Error {
	readonly code = 'NoSuchUpload';
	readonly status = StatusCodes.NOT_FOUND;

	constructor(options?: ErrorOptions) {
		super('The specified multipart upload does not exist.', undefined, options);
	}
}

// --- PreconditionFailed (412) --------------------------------------------

/**
A conditional request's precondition did not hold.
*/
export class PreconditionFailedError extends S3Error {
	readonly code = 'PreconditionFailed';
	readonly status = StatusCodes.PRECONDITION_FAILED;

	constructor() {
		super('At least one of the preconditions you specified did not hold.');
	}
}

// --- InternalError (500) -------------------------------------------------

/**
The server does not expose the cause of this failure to the client.
*/
export class InternalError extends S3Error {
	readonly code = 'InternalError';
	readonly status = StatusCodes.INTERNAL_SERVER_ERROR;

	constructor(options?: ErrorOptions) {
		super(
			'We encountered an internal error. Please try again.',
			undefined,
			options
		);
	}
}

// --- Passthrough relay ---------------------------------------------------

/**
 * An upstream S3 service returned an error to the passthrough provider. The
 * provider relays its status and code unchanged. Only the reference passthrough
 * provider uses this error; the production backend does not.
 */
export class UpstreamError extends S3Error {
	readonly code: S3ErrorCode;
	readonly status: number;

	constructor(status: number, code: S3ErrorCode, message: string) {
		super(message);
		this.code = code;
		this.status = status;
	}
}
