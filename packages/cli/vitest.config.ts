import { defineConfig } from 'vitest/config';

import { hangLimits } from '../../tests/support/hang-limits.ts';

export default defineConfig({
	test: {
		// The tests stub every HTTP request. A proxy variable inherited from the
		// environment would send the CONNECT request for each HTTPS origin to a
		// real proxy. An empty value turns a variable off.
		env: {
			ALL_PROXY: '',
			all_proxy: '',
			HTTP_PROXY: '',
			http_proxy: '',
			HTTPS_PROXY: '',
			https_proxy: '',
			PROXY: '',
			proxy: ''
		},
		...hangLimits,
		setupFiles: ['./src/network-guard-test-setup.ts']
	}
});
