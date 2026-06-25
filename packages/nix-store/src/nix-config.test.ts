import { describe, expect, it } from 'vitest';

import { NixConfig, renderNetrc } from './nix-config.ts';

describe('NixConfig', () => {
	it('renders a nix.conf snippet', () => {
		const config = new NixConfig('https://cache.example', 'cupboard-1:key');
		expect(config.render()).toBe(
			[
				'substituters = https://cache.example',
				'trusted-public-keys = cupboard-1:key',
				''
			].join('\n')
		);
	});

	it('renders newline-separated rotation keys as one space-separated line', () => {
		const config = new NixConfig(
			'https://cache.example',
			'cupboard-1:one\ncupboard-2:two'
		);
		expect(config.render()).toBe(
			[
				'substituters = https://cache.example',
				'trusted-public-keys = cupboard-1:one cupboard-2:two',
				''
			].join('\n')
		);
	});

	it('renders a netrc line for the given host, user and password', () => {
		expect(renderNetrc('cache.example.workers.dev', 'alice', 'secret')).toBe(
			'machine cache.example.workers.dev login alice password secret\n'
		);
	});
});
