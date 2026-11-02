import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
	createPublicationRequestId,
	isFreshPublicationRequestId,
	type PublicationRequestId,
	publicationRequestIdSchema
} from './publication-manifests.ts';

const rfcTimestamp = 1_645_557_742_000;
const rfcId = '017f22e2-79b0-7cc3-98c4-dc0c0c07398f';
const dayMs = 24 * 60 * 60 * 1000;
const futureToleranceMs = 5 * 60 * 1000;

function fixedRandomness(hex: string) {
	return vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
		if (!(array instanceof Uint8Array)) {
			throw new TypeError('Expected UUID bytes');
		}
		for (let index = 0; index < array.length; index++) {
			array[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
		}
		return array;
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('createPublicationRequestId', () => {
	it('matches the RFC 9562 Appendix A.6 UUIDv7 layout through the public export', () => {
		vi.spyOn(Date, 'now').mockReturnValue(rfcTimestamp);
		const random = fixedRandomness('0000000000000cc3d8c4dc0c0c07398f');
		const id = createPublicationRequestId();
		expectTypeOf(id).toEqualTypeOf<PublicationRequestId>();
		expect(id).toBe(rfcId);
		expect(publicationRequestIdSchema.parse(id)).toBe(id);
		expect(random).toHaveBeenCalledExactlyOnceWith(expect.any(Uint8Array));
		expect(isFreshPublicationRequestId(id, new Date(rfcTimestamp))).toBe(true);
	});

	it.each([
		['00', '7000-8000-000000000000'],
		['aa', '7aaa-aaaa-aaaaaaaaaaaa'],
		['ff', '7fff-bfff-ffffffffffff']
	])(
		'sets version and variant without losing the other random bits (%s)',
		(byte, suffix) => {
			vi.spyOn(Date, 'now').mockReturnValue(rfcTimestamp);
			fixedRandomness(byte.repeat(16));
			expect(createPublicationRequestId()).toBe(`017f22e2-79b0-${suffix}`);
		}
	);

	it.each([
		[0, '00000000-0000'],
		[2 ** 32 - 1, '0000ffff-ffff'],
		[2 ** 32, '00010000-0000'],
		[2 ** 48 - 1, 'ffffffff-ffff']
	])('encodes the full 48-bit millisecond clock at %s', (timestamp, prefix) => {
		vi.spyOn(Date, 'now').mockReturnValue(timestamp);
		fixedRandomness('00'.repeat(16));
		expect(createPublicationRequestId()).toBe(
			`${prefix}-7000-8000-000000000000`
		);
	});

	it.each([-1, 2 ** 48, NaN, Infinity, 0.5])(
		'refuses an unrepresentable clock instead of truncating it (%s)',
		(timestamp) => {
			vi.spyOn(Date, 'now').mockReturnValue(timestamp);
			expect(() => createPublicationRequestId()).toThrow(RangeError);
		}
	);

	it('uses fresh cryptographic randomness even within the same millisecond', () => {
		vi.spyOn(Date, 'now').mockReturnValue(rfcTimestamp);
		const random = fixedRandomness('00'.repeat(16));
		const first = createPublicationRequestId();
		random.mockImplementation((array) => {
			if (array instanceof Uint8Array) {
				array.fill(0xff);
			}
			return array;
		});
		const second = createPublicationRequestId();
		expect(random).toHaveBeenCalledTimes(2);
		expect(first).not.toBe(second);
		expect(first.slice(0, 14)).toBe(second.slice(0, 14));
	});

	it('does not replace a backwards clock with a newer timestamp', () => {
		vi.spyOn(Date, 'now')
			.mockReturnValueOnce(rfcTimestamp)
			.mockReturnValueOnce(rfcTimestamp - 1);
		fixedRandomness('00'.repeat(16));
		expect(createPublicationRequestId().slice(0, 13)).toBe('017f22e2-79b0');
		expect(createPublicationRequestId().slice(0, 13)).toBe('017f22e2-79af');
	});
});

describe('isFreshPublicationRequestId', () => {
	const id = publicationRequestIdSchema.parse(rfcId);

	it.each([
		[-futureToleranceMs - 1, false],
		[-futureToleranceMs, true],
		[-futureToleranceMs + 1, true],
		[0, true],
		[dayMs - 1, true],
		[dayMs, false],
		[dayMs + 1, false]
	])(
		'checks exact original-lifetime boundaries at clock offset %s',
		(offset, fresh) => {
			expect(
				isFreshPublicationRequestId(id, new Date(rfcTimestamp + offset))
			).toBe(fresh);
		}
	);

	it('accepts uppercase UUIDs without changing their creation time', () => {
		const uppercase = publicationRequestIdSchema.parse(rfcId.toUpperCase());
		expect(isFreshPublicationRequestId(uppercase, new Date(rfcTimestamp))).toBe(
			true
		);
	});

	it('fails closed for an invalid current clock', () => {
		expect(isFreshPublicationRequestId(id, new Date(NaN))).toBe(false);
	});

	it.each([
		'550e8400-e29b-41d4-a716-446655440000',
		'017f22e2-79b0-4cc3-98c4-dc0c0c07398f',
		'017f22e2-79b0-1cc3-98c4-dc0c0c07398f',
		'00000000-0000-0000-0000-000000000000',
		'ffffffff-ffff-ffff-ffff-ffffffffffff',
		'00000000-0000-7000-8000-000000000000',
		'ffffffff-ffff-7fff-bfff-ffffffffffff'
	])(
		'parses persisted UUIDs but refuses untimestamped or out-of-range unknown IDs (%s)',
		(value) => {
			const persisted = publicationRequestIdSchema.parse(value);
			expect(
				isFreshPublicationRequestId(persisted, new Date(rfcTimestamp))
			).toBe(false);
		}
	);

	it.each([
		'',
		'not-a-uuid',
		'017f22e2-79b0-7cc3-78c4-dc0c0c07398f',
		'017f22e2-79b0-7cc3-c8c4-dc0c0c07398f',
		'017f22e2-79b0-7cc3-98c4-dc0c0c07398f-extra',
		'017f22e279b07cc398c4dc0c0c07398f'
	])(
		'fails closed if malformed data bypasses the branded type (%s)',
		(value) => {
			expect(
				isFreshPublicationRequestId(
					value as PublicationRequestId,
					new Date(rfcTimestamp)
				)
			).toBe(false);
		}
	);
});
