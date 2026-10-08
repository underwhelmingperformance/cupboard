import { attestationNegotiateMaxBundles } from '@cupboard/protocol/attestations';
import {
	readResponseBytes,
	RemoteBodyTooLargeError
} from '@cupboard/shared/response-body';

import { type AccessClaims } from '../auth/auth.ts';
import { RequestBodyTooLargeError } from '../errors.ts';
import { uploadPageSize } from '../policy/upload-pages.ts';

// Apart from upload negotiation and preview, the largest admin input with a
// fixed maximum size is a full attestation negotiation page. In compact JSON it
// is the 26-byte `{"pushId":"","bundles":[]}`, a push ID of at most 128
// characters, 128 bytes for each bundle, and a comma between bundles. The
// limit is twice that, so a client may also send whitespace.
export const contractRequestMaxBytes =
	2 * (26 + 128 + 129 * attestationNegotiateMaxBundles - 1);

// The Worker sends upload negotiation and preview to the tenant object in
// pages of at most `uploadPageSize` paths. A path's entry can list up to 10,000
// references, so the schema allows pages larger than any request that
// Cloudflare accepts. The limit allows 40 KiB for each path's entry.
export const uploadRequestMaxBytes = uploadPageSize * 40 * 1024;

/**
 * Returns a function that calls `authenticate` once and returns the same
 * promise on every call, so the body guard and the procedure middleware of
 * one request share one verification.
 */
export function authenticateOnce(
	authenticate: () => Promise<AccessClaims>
): () => Promise<AccessClaims> {
	let claims: Promise<AccessClaims> | undefined;

	return () => (claims ??= authenticate());
}

/**
 * A copy of an admin API request for a contract handler. When the handler
 * reads the copy's body, the copy authenticates the request first, and then
 * reads the original body up to `maximumBytes`. If authentication fails, the
 * copy's body is empty, and the procedure middleware refuses the request
 * without its body being read. A request that the handler does not match
 * leaves the original body unread, so a later route can read it.
 */
export class ContractRequest {
	#isTooLarge = false;
	readonly request: Request;

	constructor(
		original: Request,
		authenticate: () => Promise<unknown>,
		readonly maximumBytes: number
	) {
		this.request =
			original.body === null
				? original
				: new Request(original.url, {
						method: original.method,
						headers: original.headers,
						signal: original.signal,
						body: this.#guardedBody(original, authenticate)
					});
	}

	#guardedBody(
		original: Request,
		authenticate: () => Promise<unknown>
	): ReadableStream<Uint8Array> {
		return new ReadableStream<Uint8Array>(
			{
				pull: async (controller) => {
					try {
						await authenticate();
					} catch {
						// The procedure middleware awaits the same authentication and
						// refuses the request with its error.
						controller.close();
						return;
					}

					try {
						controller.enqueue(
							await readResponseBytes(original, {
								description: 'admin API request body',
								maximumBytes: this.maximumBytes
							})
						);
						controller.close();
					} catch (error) {
						this.#isTooLarge = error instanceof RemoteBodyTooLargeError;
						controller.error(error);
					}
				}
			},
			// With the default high-water mark of 1, the stream pulls as soon as it
			// is created, which would authenticate and read every request, including
			// those for the routes after the contract handler.
			{ highWaterMark: 0 }
		);
	}

	/**
	 * Throws {@link RequestBodyTooLargeError} if the handler's read of the body
	 * crossed the limit. The handler turns a failed read into its own 400
	 * response, so call this after the handler returns.
	 */
	refuseOversizeBody(): void {
		if (this.#isTooLarge) {
			throw new RequestBodyTooLargeError(this.maximumBytes);
		}
	}
}
