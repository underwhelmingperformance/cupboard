import {
	cacheNameSchema,
	nixSha256HashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { s3NarStagingKey, s3TenantStagingPrefix } from './staging.ts';

describe('s3NarStagingKey', () => {
	it('namespaces the default cache by tenant', () => {
		const fileHash = nixSha256HashSchema.parse(`sha256:${'1'.repeat(52)}`);
		const tenant = tenantIdSchema.parse('acme');

		expect(s3NarStagingKey(tenant, '', fileHash)).toBe(
			`staging/s3/acme/_default/${fileHash}.nar.zst`
		);
		expect(
			s3NarStagingKey(tenant, '', fileHash).startsWith(
				s3TenantStagingPrefix(tenant)
			)
		).toBe(true);
	});

	it('namespaces a named cache within its tenant', () => {
		const fileHash = nixSha256HashSchema.parse(`sha256:${'1'.repeat(52)}`);

		expect(
			s3NarStagingKey(
				tenantIdSchema.parse('acme'),
				cacheNameSchema.parse('builds'),
				fileHash
			)
		).toBe(`staging/s3/acme/builds/${fileHash}.nar.zst`);
	});
});
