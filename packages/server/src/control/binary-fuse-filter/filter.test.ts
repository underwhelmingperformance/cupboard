import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { BinaryFuseFilterInvalidError } from '../../errors.ts';

import { BinaryFuse8 } from './filter.ts';

function thrownBy(run: () => unknown): unknown {
	let thrown: unknown;

	try {
		run();
	} catch (error) {
		thrown = error;
	}

	return thrown;
}

function slugs(count: number, prefix = 'tenant'): string[] {
	return Array.from(
		{ length: count },
		(_, index) => `${prefix}-${String(index)}`
	);
}

function refreshChecksum(bytes: Uint8Array): Uint8Array {
	let hash = 0x81_1c_9d_c5;

	for (let index = 4; index < bytes.length; index += 1) {
		hash = Math.imul(hash ^ (bytes[index] ?? 0), 0x01_00_01_93);
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	view.setUint32(0, hash >>> 0, true);

	return bytes;
}

describe('BinaryFuse8', () => {
	// The load-bearing invariant: a fuse filter has no false negatives, so every
	// built key must test present. A failure here would 404 a real tenant.
	it.each([0, 1, 2, 3, 5, 17, 50, 1000, 5000])(
		'reports every one of %i built keys as present',
		(count) => {
			const members = slugs(count);
			const filter = BinaryFuse8.build(members);

			expect(members.filter((slug) => !filter.has(slug))).toStrictEqual([]);
		}
	);

	it('keeps the false-positive rate close to the fuse8 rate', () => {
		const filter = BinaryFuse8.build(slugs(2000));
		const nonMembers = slugs(20_000, 'absent');

		const falsePositives = nonMembers.filter((slug) => filter.has(slug)).length;
		const falsePositiveRate = falsePositives / nonMembers.length;

		expect(falsePositiveRate).toBeGreaterThan(0.001);
		expect(falsePositiveRate).toBeLessThan(0.01);
	});

	it('round-trips members and non-members through serialisation', () => {
		const members = slugs(500);
		const filter = BinaryFuse8.build(members);
		const restored = BinaryFuse8.deserialise(filter.serialise());
		const sample = [...members, ...slugs(20, 'absent')];

		expect(sample.map((slug) => restored.has(slug))).toStrictEqual(
			sample.map((slug) => filter.has(slug))
		);
	});

	it('hashes strings as UTF-8 bytes', () => {
		const filter = BinaryFuse8.build(['tenant-é-雪-💾']);

		expect([...filter.serialise()]).toStrictEqual([
			146, 27, 94, 101, 69, 83, 85, 70, 1, 0, 0, 0, 103, 52, 210, 55, 37, 178,
			246, 109, 1, 0, 0, 0, 4, 0, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0, 4, 0, 0, 0, 12,
			0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 36, 0, 0, 0
		]);
	});

	it.each([
		{
			name: 'a lone high surrogate',
			value: `${String.fromCodePoint(0xd8_00)}x`,
			normalised: '\u{FFFD}x'
		},
		{
			name: 'a lone low surrogate',
			value: `${String.fromCodePoint(0xdc_00)}x`,
			normalised: '\u{FFFD}x'
		}
	])('normalises $name like TextEncoder', ({ value, normalised }) => {
		expect([...BinaryFuse8.build([value]).serialise()]).toStrictEqual([
			...BinaryFuse8.build([normalised]).serialise()
		]);
	});

	it('reports every Unicode key as present', () => {
		const members = [
			'tenant-é',
			'tenant-e\u{301}',
			'tenant-雪',
			'tenant-💾',
			'tenant-مرحبا'
		];
		const filter = BinaryFuse8.build(members);
		const restored = BinaryFuse8.deserialise(filter.serialise());

		expect(members.filter((slug) => !restored.has(slug))).toStrictEqual([]);
	});

	it.each([
		{
			name: 'short header',
			bytes: () => BinaryFuse8.build(slugs(10)).serialise().subarray(0, 8)
		},
		{
			name: 'truncated fingerprints',
			bytes: () => {
				const serialised = BinaryFuse8.build(slugs(500)).serialise();
				const bytes = Uint8Array.from(serialised.subarray(0, 64));

				return refreshChecksum(bytes);
			}
		},
		{
			name: 'overlong fingerprints',
			bytes: () => {
				const serialised = BinaryFuse8.build(slugs(500)).serialise();
				const bytes = new Uint8Array(serialised.length + 1);
				bytes.set(serialised);

				return refreshChecksum(bytes);
			}
		},
		{
			name: 'inconsistent geometry',
			bytes: () => {
				const bytes = BinaryFuse8.build(slugs(500)).serialise();
				const view = new DataView(
					bytes.buffer,
					bytes.byteOffset,
					bytes.byteLength
				);
				view.setUint32(24, 1, true);

				return refreshChecksum(bytes);
			}
		},
		{
			name: 'inconsistent key count',
			bytes: () => {
				const bytes = BinaryFuse8.build(slugs(500)).serialise();
				const view = new DataView(
					bytes.buffer,
					bytes.byteOffset,
					bytes.byteLength
				);
				view.setUint32(20, 1, true);

				return refreshChecksum(bytes);
			}
		},
		{
			// Neither the geometry nor the key count changes, so only the checksum
			// catches it; without that guard the filter would serve false negatives.
			name: 'a flipped fingerprint byte',
			bytes: () => {
				const bytes = BinaryFuse8.build(slugs(500)).serialise();
				const last = bytes.length - 1;
				bytes[last] = (bytes[last] ?? 0) ^ 1;

				return bytes;
			}
		},
		{
			name: 'a flipped seed byte',
			bytes: () => {
				const bytes = BinaryFuse8.build(slugs(500)).serialise();
				bytes[12] = (bytes[12] ?? 0) ^ 1;

				return bytes;
			}
		}
	])('rejects a serialised filter with $name', ({ bytes }) => {
		const error = thrownBy(() => BinaryFuse8.deserialise(bytes()));

		expect(error).toBeInstanceOf(BinaryFuseFilterInvalidError);
		if (!(error instanceof BinaryFuseFilterInvalidError)) {
			throw error;
		}

		expect({ name: error.name, status: error.status }).toStrictEqual({
			name: 'BinaryFuseFilterInvalidError',
			status: StatusCodes.INTERNAL_SERVER_ERROR
		});
	});

	it('builds deterministically for the same key set', () => {
		const members = slugs(300);

		expect([...BinaryFuse8.build(members).serialise()]).toStrictEqual([
			...BinaryFuse8.build(members).serialise()
		]);
	});

	it('deduplicates repeated strings before construction', () => {
		const filter = BinaryFuse8.build(['a', 'a', 'b']);
		const deduplicated = BinaryFuse8.build(['a', 'b']);

		expect({
			missing: ['a', 'b'].filter((slug) => !filter.has(slug)),
			serialisedLength: filter.serialise().length
		}).toStrictEqual({
			missing: [],
			serialisedLength: deduplicated.serialise().length
		});
	});

	it('rejects every probe for an empty set', () => {
		const filter = BinaryFuse8.build([]);
		const probes = slugs(1000, 'ghost');

		expect(probes.filter((slug) => filter.has(slug))).toStrictEqual([]);
	});

	it('round-trips an empty set through serialisation', () => {
		const restored = BinaryFuse8.deserialise(BinaryFuse8.build([]).serialise());
		const probes = slugs(1000, 'ghost');

		expect(probes.filter((slug) => restored.has(slug))).toStrictEqual([]);
	});
});
