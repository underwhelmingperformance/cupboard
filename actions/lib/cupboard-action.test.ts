import { describe, expect, it } from 'vitest';

import {
	assetNameFor,
	buildAttestationVerifyArguments,
	buildPushArguments,
	cachePublicKeyRequestHeaders,
	cacheUrlFor,
	normaliseTrustedPublicKeys,
	normaliseVersion,
	parseChecksums,
	parseLines,
	releaseApiPath,
	renderNixConfig
} from './cupboard-action.ts';

describe('normaliseVersion', () => {
	it.each([
		['latest', 'latest'],
		['1.2.3', 'v1.2.3'],
		['v1.2.3', 'v1.2.3']
	])('normalises %s', (version, expected) => {
		expect(normaliseVersion(version)).toBe(expected);
	});
});

describe('releaseApiPath', () => {
	it.each([
		['latest', '/repos/cupboard/cupboard/releases/latest'],
		['1.2.3', '/repos/cupboard/cupboard/releases/tags/v1.2.3'],
		['v1.2.3', '/repos/cupboard/cupboard/releases/tags/v1.2.3']
	])('builds the release path for %s', (version, expected) => {
		expect(releaseApiPath('cupboard/cupboard', version)).toBe(expected);
	});
});

describe('assetNameFor', () => {
	it.each([
		['darwin', 'arm64', 'cupboard-v1.2.3-macos-arm64.tar.gz'],
		['darwin', 'x64', 'cupboard-v1.2.3-macos-x64.tar.gz'],
		['linux', 'arm64', 'cupboard-v1.2.3-linux-arm64.tar.gz'],
		['linux', 'x64', 'cupboard-v1.2.3-linux-x64.tar.gz']
	])(
		'builds the asset name for %s %s',
		(runtimePlatform, runtimeArchitecture, expected) => {
			expect(assetNameFor('v1.2.3', runtimePlatform, runtimeArchitecture)).toBe(
				expected
			);
		}
	);
});

describe('parseLines', () => {
	it('parses newline-delimited inputs', () => {
		expect(parseLines('/nix/store/a\n\n /nix/store/b \r\n')).toStrictEqual([
			'/nix/store/a',
			'/nix/store/b'
		]);
	});
});

describe('parseChecksums', () => {
	it('parses sha256sum output', () => {
		expect(
			Object.fromEntries(
				parseChecksums(
					'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  cupboard-v1.2.3-linux-x64.tar.gz\n'
				)
			)
		).toStrictEqual({
			'cupboard-v1.2.3-linux-x64.tar.gz':
				'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
		});
	});
});

describe('cacheUrlFor', () => {
	it.each([
		['https://cache.example.test/', '', 'https://cache.example.test'],
		['https://cache.example.test', 'ci', 'https://cache.example.test/cache/ci']
	])('builds a substituter URL', (baseUrl, cache, expected) => {
		expect(cacheUrlFor(baseUrl, cache)).toBe(expected);
	});
});

describe('renderNixConfig', () => {
	it('renders generated Nix config', () => {
		expect(
			renderNixConfig({
				substituter: 'https://cache.example.test/cache/ci',
				trustedPublicKey: 'cupboard-1:key\ncupboard-1:next-key',
				netrcFile: '/tmp/cupboard-netrc'
			})
		).toBe(
			[
				'substituters = https://cache.example.test/cache/ci',
				'trusted-public-keys = cupboard-1:key cupboard-1:next-key',
				'netrc-file = /tmp/cupboard-netrc',
				''
			].join('\n')
		);
	});
});

describe('normaliseTrustedPublicKeys', () => {
	it('collapses whitespace for rotating public keys', () => {
		expect(
			normaliseTrustedPublicKeys(' cupboard-1:old\ncupboard-1:new \t ')
		).toBe('cupboard-1:old cupboard-1:new');
	});
});

describe('cachePublicKeyRequestHeaders', () => {
	it('does not include GitHub authentication headers', () => {
		expect(cachePublicKeyRequestHeaders()).toStrictEqual({
			accept: 'text/plain',
			'user-agent': 'cupboard-action'
		});
	});
});

describe('buildPushArguments', () => {
	it('builds a GitHub OIDC push invocation', () => {
		expect(
			buildPushArguments({
				url: 'https://cache.example.test',
				paths: ['/nix/store/a', '/nix/store/b'],
				audience: '',
				root: 'github:owner/repo/main',
				cache: 'ci',
				ttl: '7d',
				wait: true,
				waitTimeout: '10m',
				attestations: ['/tmp/a.json', '/tmp/b.json']
			})
		).toStrictEqual([
			'--no-colour',
			'push',
			'https://cache.example.test',
			'/nix/store/a',
			'/nix/store/b',
			'--github-oidc',
			'--audience',
			'https://cache.example.test',
			'--root',
			'github:owner/repo/main',
			'--cache',
			'ci',
			'--ttl',
			'7d',
			'--wait-timeout',
			'10m',
			'--attestation',
			'/tmp/a.json',
			'--attestation',
			'/tmp/b.json'
		]);
	});
});

describe('buildAttestationVerifyArguments', () => {
	it('scopes verification to the release repository and tag', () => {
		expect(
			buildAttestationVerifyArguments(
				'/tmp/cupboard-v1.2.3-linux-x64.tar.gz',
				'owner/repo',
				'v1.2.3'
			)
		).toStrictEqual([
			'attestation',
			'verify',
			'/tmp/cupboard-v1.2.3-linux-x64.tar.gz',
			'--repo',
			'owner/repo',
			'--source-ref',
			'refs/tags/v1.2.3'
		]);
	});
});
