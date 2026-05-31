import { describe, expect, it } from 'vitest';

import { NixConfig } from './nix-config.ts';

describe('NixConfig', () => {
	it('renders a nix.conf snippet', () => {
		expect(
			new NixConfig('https://cache.example', 'cupboard-1:key').render()
		).toBe(
			[
				'substituters = https://cache.example',
				'trusted-public-keys = cupboard-1:key',
				''
			].join('\n')
		);
	});
});
