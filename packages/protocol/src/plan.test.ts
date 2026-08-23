import { describe, expect, it } from 'vitest';

import {
	describeUnknownPath,
	describeUnknownPathsRefusal,
	type UnknownPathDetail,
	unknownPathDetailSchema,
	unknownPathsCeilingRefusalSchema
} from './plan.ts';

const drvPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv';
const outPath = '/nix/store/1123456789abcdfghijklmnpqrsvwxyz-lib';

function detail(overrides: Record<string, unknown> = {}): UnknownPathDetail {
	return unknownPathDetailSchema.parse({
		path: outPath,
		cause: { kind: 'not-in-store-or-substituters' },
		targets: [
			{
				attr: 'packages.x86_64-linux.app',
				installable: `${drvPath}^out`
			}
		],
		...overrides
	});
}

describe('unknownPathsCeilingRefusalSchema', () => {
	it('parses a payload from an older cupboard that has no per-path detail', () => {
		const parsed = unknownPathsCeilingRefusalSchema.parse({
			reason: 'unknown-paths-ceiling',
			unknownCount: 3,
			ceiling: { value: 0, source: 'configured' },
			downloadSize: 10,
			narSize: 20
		});

		expect(parsed).toStrictEqual({
			reason: 'unknown-paths-ceiling',
			unknownCount: 3,
			unknownPaths: [],
			unreachableSubstituters: [],
			ceiling: { value: 0, source: 'configured' },
			downloadSize: 10,
			narSize: 20
		});
	});

	it.each([
		{
			name: 'an attr containing a control character',
			target: { attr: 'app\n::error::forged', installable: drvPath }
		},
		{
			name: 'an output selection containing a control character',
			target: { attr: 'app', installable: `${drvPath}^out\n::error::forged` }
		},
		{
			name: 'an empty output selection',
			target: { attr: 'app', installable: `${drvPath}^` }
		}
	])('rejects $name', ({ target }) => {
		const parsed = unknownPathsCeilingRefusalSchema.safeParse({
			reason: 'unknown-paths-ceiling',
			unknownCount: 1,
			unknownPaths: [
				{
					path: outPath,
					cause: { kind: 'not-in-store-or-substituters' },
					targets: [target]
				}
			],
			ceiling: { value: 0, source: 'configured' },
			downloadSize: 0,
			narSize: 0
		});

		expect(parsed.success).toBe(false);
	});
});

describe('describeUnknownPath', () => {
	it.each([
		{
			name: 'a missing derivation in the local daemon store',
			value: detail({
				path: drvPath,
				cause: { kind: 'missing-derivation' }
			}),
			store: { kind: 'daemon' } as const,
			expected:
				`${drvPath}; target packages.x86_64-linux.app (${drvPath}^out)\n` +
				"The local Nix daemon's store does not contain this derivation. " +
				'Nix therefore cannot inspect its outputs or dependencies.'
		},
		{
			name: 'an unrefreshed substituter result in the local store',
			value: detail({
				cause: {
					kind: 'substituter-result-not-refreshed',
					reason: 'the transport drops per-command settings'
				}
			}),
			store: { kind: 'local-filesystem' } as const,
			expected:
				`${outPath}; target packages.x86_64-linux.app (${drvPath}^out)\n` +
				'The local Nix store does not contain this path. Cupboard could ' +
				"not refresh Nix's cached substituter result because the " +
				'transport drops per-command settings.'
		},
		{
			name: 'a dependency path that no target refers to, in a remote store',
			value: detail({ targets: [] }),
			store: {
				kind: 'ssh-ng',
				uri: 'ssh-ng://builder.example.test'
			} as const,
			expected:
				`${outPath}\n` +
				'The remote Nix store at ssh-ng://builder.example.test does not ' +
				'contain this path. The plan queried the available substituters, ' +
				'but none provided it.'
		},
		{
			name: 'a remote store selected by the environment, with no URI',
			value: detail({ targets: [] }),
			store: { kind: 'ssh-ng' } as const,
			expected:
				`${outPath}\n` +
				'The remote Nix store does not contain this path. The plan queried ' +
				'the available substituters, but none provided it.'
		},
		{
			name: 'a payload that does not identify a store',
			value: detail({ targets: [] }),
			store: undefined,
			expected:
				`${outPath}\n` +
				'The selected Nix store does not contain this path. The plan ' +
				'queried the available substituters, but none provided it.'
		}
	])('renders $name', ({ value, store, expected }) => {
		expect(describeUnknownPath(value, store)).toBe(expected);
	});

	it('redacts a password embedded in the store URI', () => {
		const rendered = describeUnknownPath(detail({ targets: [] }), {
			kind: 'ssh-ng',
			uri: 'ssh-ng://build:secret@builder.example.test'
		});

		expect(rendered).toBe(
			`${outPath}\n` +
				'The remote Nix store at ssh-ng://build@builder.example.test does ' +
				'not contain this path. The plan queried the available ' +
				'substituters, but none provided it.'
		);
	});
});

describe('describeUnknownPathsRefusal', () => {
	it('renders one path with its target, the configured ceiling and the remedy', () => {
		const rendered = describeUnknownPathsRefusal({
			unknownPaths: [detail()],
			ceiling: { value: 0, source: 'configured' },
			store: { kind: 'daemon' },
			unreachableSubstituters: []
		});

		expect(rendered).toBe(
			'Cupboard cannot calculate the build and download work for this ' +
				'cohort because Nix cannot obtain 1 required store path.\n\n' +
				'Unavailable path:\n' +
				`- ${outPath}; target packages.x86_64-linux.app (${drvPath}^out)\n` +
				"  The local Nix daemon's store does not contain this path. The " +
				'plan queried the available substituters, but none provided it.\n\n' +
				'The plan refuses if Nix cannot obtain any required path. Make the ' +
				"missing path available in the local Nix daemon's store, then retry."
		);
	});

	it('renders several paths and the fallback ceiling after substituter queries fail', () => {
		const rendered = describeUnknownPathsRefusal({
			unknownPaths: [
				detail({
					path: drvPath,
					cause: { kind: 'missing-derivation' },
					targets: [
						{
							attr: 'packages.x86_64-linux.app',
							installable: `${drvPath}^out`
						},
						{
							attr: 'packages.x86_64-linux.dev',
							installable: `${drvPath}^dev`
						}
					]
				}),
				detail({ targets: [] })
			],
			ceiling: {
				value: 0,
				source: 'untrusted-fallback',
				fallbackReason: 'the daemon connection is not trusted'
			},
			store: { kind: 'ssh-ng', uri: 'ssh-ng://builder.example.test' },
			unreachableSubstituters: [
				'https://cache.example.test',
				's3://other-cache'
			]
		});

		expect(rendered).toBe(
			'Cupboard cannot calculate the build and download work for this ' +
				'cohort because Nix cannot obtain 2 required store paths.\n\n' +
				'Unavailable paths:\n' +
				`- ${drvPath}; targets packages.x86_64-linux.app (${drvPath}^out), ` +
				`packages.x86_64-linux.dev (${drvPath}^dev)\n` +
				'  The remote Nix store at ssh-ng://builder.example.test does not ' +
				'contain this derivation. Nix therefore cannot inspect its outputs ' +
				'or dependencies.\n' +
				`- ${outPath}\n` +
				'  The remote Nix store at ssh-ng://builder.example.test does not ' +
				'contain this path. The plan queried the available substituters, ' +
				'but none provided it.\n\n' +
				'The plan could not query these configured substituters. A path ' +
				'available only from one of them therefore counts as unavailable: ' +
				'https://cache.example.test, s3://other-cache.\n\n' +
				'The plan refuses if Nix cannot obtain any required path. That ' +
				'limit applied because the daemon connection is not trusted. ' +
				'Make the missing paths available in the remote Nix store at ' +
				'ssh-ng://builder.example.test, then retry.'
		);
	});
});
