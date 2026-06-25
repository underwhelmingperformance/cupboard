import { describe, expect, it } from 'vitest';

import { selectOrphanedStagingKeys } from './garbage-collection-service.ts';

describe('selectOrphanedStagingKeys', () => {
	const cutoff = Date.parse('2026-01-01T00:15:00.000Z');

	function staged(key: string, uploadedIso: string) {
		return { key, uploaded: new Date(uploadedIso) };
	}

	it('reaps an aged, unreferenced staged object', () => {
		const objects = [
			staged('staging/s3/a.nar.zst', '2026-01-01T00:00:00.000Z')
		];
		expect(selectOrphanedStagingKeys(objects, new Set(), cutoff)).toStrictEqual(
			['staging/s3/a.nar.zst']
		);
	});

	it('spares an object a pending upload still references', () => {
		const objects = [
			staged('staging/s3/a.nar.zst', '2026-01-01T00:00:00.000Z')
		];
		const referenced = new Set(['staging/s3/a.nar.zst']);
		expect(
			selectOrphanedStagingKeys(objects, referenced, cutoff)
		).toStrictEqual([]);
	});

	it('spares an object still within the staging window', () => {
		const objects = [
			staged('staging/s3/a.nar.zst', '2026-01-01T00:20:00.000Z')
		];
		expect(selectOrphanedStagingKeys(objects, new Set(), cutoff)).toStrictEqual(
			[]
		);
	});
});
