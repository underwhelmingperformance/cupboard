import { z } from 'zod';

import { publicationRecoveryMs } from './publication.ts';

// Keep persisted UUIDs parseable: receipt recovery is independent of freshness.
export const publicationRequestIdSchema = z
	.uuid()
	.brand('PublicationRequestId');
export type PublicationRequestId = z.output<typeof publicationRequestIdSchema>;

const publicationRequestFutureToleranceMs = 5 * 60 * 1000;

/**
RFC 9562 §5.7: 48-bit Unix milliseconds, version 7, variant 10, 74 random bits.
Use a CSPRNG per §6.9; no monotonic counter replaces clock time.
https://www.rfc-editor.org/rfc/rfc9562.html#section-5.7
https://www.rfc-editor.org/rfc/rfc9562.html#section-6.9
*/
export function createPublicationRequestId(): PublicationRequestId {
	const timestamp = Date.now();
	if (
		!Number.isSafeInteger(timestamp) ||
		timestamp < 0 ||
		timestamp >= 2 ** 48
	) {
		throw new RangeError(
			'Publication request time must fit UUIDv7 milliseconds'
		);
	}

	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const view = new DataView(bytes.buffer);
	view.setUint16(0, Math.floor(timestamp / 2 ** 32));
	view.setUint32(2, timestamp % 2 ** 32);
	view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x70);
	view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);
	const hex = Array.from(bytes, (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');
	return publicationRequestIdSchema.parse(
		`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
	);
}

/**
Only gates unknown requests. A valid stored operation/admission may still recover
until its original deadline, including receipts with older UUID versions.
*/
export function isFreshPublicationRequestId(
	id: PublicationRequestId,
	now: Date
): boolean {
	if (!publicationRequestIdSchema.safeParse(id).success || id[14] !== '7') {
		return false;
	}

	const createdAt = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
	const nowMs = now.getTime();
	return (
		Number.isFinite(nowMs) &&
		createdAt > nowMs - publicationRecoveryMs &&
		createdAt <= nowMs + publicationRequestFutureToleranceMs
	);
}
