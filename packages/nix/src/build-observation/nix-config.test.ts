import { describe, expect, it } from 'vitest';

import { environmentWithPostBuildHook } from './nix-config.ts';

const hookScriptPath = '/run/user/1000/cupboard/invocation-1/hook.sh';
const setting = `post-build-hook = ${hookScriptPath}`;

describe('environmentWithPostBuildHook', () => {
	it.each([
		{
			name: 'creates NIX_CONFIG when absent',
			environment: { PATH: '/usr/bin' },
			expected: { PATH: '/usr/bin', NIX_CONFIG: setting }
		},
		{
			name: 'creates NIX_CONFIG when empty',
			environment: { PATH: '/usr/bin', NIX_CONFIG: '' },
			expected: { PATH: '/usr/bin', NIX_CONFIG: setting }
		},
		{
			name: 'appends after an existing value',
			environment: {
				NIX_CONFIG: 'substituters = https://cache.example',
				NIX_USER_CONF_FILES: '/etc/custom/nix.conf'
			},
			expected: {
				NIX_CONFIG: `substituters = https://cache.example\n${setting}`,
				NIX_USER_CONF_FILES: '/etc/custom/nix.conf'
			}
		},
		{
			name: 'appends after a trailing newline without doubling it',
			environment: { NIX_CONFIG: 'keep-going = true\n' },
			expected: { NIX_CONFIG: `keep-going = true\n${setting}` }
		},
		{
			name: 'appends after a multi-line value',
			environment: { NIX_CONFIG: 'keep-going = true\nfallback = true' },
			expected: {
				NIX_CONFIG: `keep-going = true\nfallback = true\n${setting}`
			}
		}
	])('$name', ({ environment, expected }) => {
		const input = { ...environment };

		expect({
			composed: environmentWithPostBuildHook(environment, hookScriptPath),
			original: environment
		}).toStrictEqual({ composed: expected, original: input });
	});
});
