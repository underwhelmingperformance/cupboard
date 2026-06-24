import { describe, expect, it } from 'vitest';

import { NixSha256Hash } from './nar.ts';
import { prepareStorePathMetadata } from './nix-store.ts';

describe('prepareStorePathMetadata', () => {
	it('keeps Nix metadata authoritative and normalises references', () => {
		expect(
			prepareStorePathMetadata(
				{
					storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
					narHash: NixSha256Hash.parse(
						'sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk'
					),
					narSize: 123,
					references: [
						'/nix/store/2123456789abcdfghijklmnpqrsvwxyz-lib',
						'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime'
					],
					deriver: '/nix/store/4123456789abcdfghijklmnpqrsvwxyz-app.drv',
					ca: 'fixed:r:sha256:hash',
					signatures: ['cache:key']
				},
				{
					fileHash: NixSha256Hash.parse(
						'sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk'
					),
					fileSize: 456,
					compression: 'zstd'
				}
			)
		).toStrictEqual({
			metadata: {
				storePathHash: '0123456789abcdfghijklmnpqrsvwxyz',
				storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
				narHash: 'sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
				narSize: 123,
				fileHash: 'sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
				fileSize: 456,
				compression: 'zstd',
				references: [
					'2123456789abcdfghijklmnpqrsvwxyz-lib',
					'3123456789abcdfghijklmnpqrsvwxyz-runtime'
				],
				deriver: '4123456789abcdfghijklmnpqrsvwxyz-app.drv',
				ca: 'fixed:r:sha256:hash'
			},
			signatures: ['cache:key']
		});
	});
});
