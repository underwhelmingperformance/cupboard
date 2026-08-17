import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { SignatureDoesNotMatchError } from './errors.ts';

/**
A body stream paired with the completion of its fixed-digest check.
*/
export interface AuthenticatedPayload {
	readonly body: ReadableStream<Uint8Array>;
	readonly verified: Promise<void>;
	readonly isVerificationRequired: boolean;
}

const fixedDigestPattern = /^[0-9a-f]{64}$/i;

/**
 * Streams a request body through an incremental SHA-256 check when the request
 * declares a fixed hexadecimal digest.
 */
export function authenticatePayload(
	body: ReadableStream<Uint8Array>,
	contentSha256: string | undefined
): AuthenticatedPayload {
	if (contentSha256 === undefined || !fixedDigestPattern.test(contentSha256)) {
		return {
			body,
			verified: Promise.resolve(),
			isVerificationRequired: false
		};
	}

	const expected = contentSha256.toLowerCase();
	const reader = body.getReader();
	const digest = sha256.create();
	const {
		promise: verified,
		resolve: resolveVerification,
		reject: rejectVerification
	} = Promise.withResolvers<undefined>();

	// A body consumer also sees a digest failure on its final read. The separate
	// promise lets the request handler withhold a success response until that read
	// has completed and the declared digest has been checked.
	const authenticated = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { value, done: isDone } = await reader.read();
				if (!isDone) {
					digest.update(value);
					controller.enqueue(value);
					return;
				}

				if (!areHexDigestsEqual(bytesToHex(digest.digest()), expected)) {
					throw new SignatureDoesNotMatchError();
				}

				controller.close();
				resolveVerification(undefined);
			} catch (error) {
				controller.error(error);
				rejectVerification(error);
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason);
			} finally {
				rejectVerification(reason);
			}
		}
	});

	// A handler can fail for another reason before it awaits verification. Keep
	// the verification promise observed while preserving its rejection for the
	// handler that does await it.
	void verified.catch(() => false);

	return { body: authenticated, verified, isVerificationRequired: true };
}

/**
Reads any remaining body bytes and completes a required digest check.
*/
export async function completePayloadVerification(
	payload: AuthenticatedPayload
): Promise<void> {
	if (!payload.isVerificationRequired) {
		return;
	}

	if (!payload.body.locked) {
		const verificationReader = payload.body.getReader();
		try {
			for (;;) {
				const { done: isDone } = await verificationReader.read();
				if (isDone) {
					break;
				}
			}
		} finally {
			verificationReader.releaseLock();
		}
	}

	await payload.verified;
}

function areHexDigestsEqual(left: string, right: string): boolean {
	let mismatch = left.length ^ right.length;
	const length = Math.max(left.length, right.length);

	for (let index = 0; index < length; index++) {
		mismatch |=
			(left.codePointAt(index) ?? 0) ^ (right.codePointAt(index) ?? 0);
	}

	return mismatch === 0;
}
