import { createHash, createPublicKey } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { VerifiedBundle } from '@cupboard/shared/attestation';
import { describe, expect, it } from 'vitest';

import {
	assetNameFor,
	buildPushArguments,
	cachePublicKeyRequestHeaders,
	cacheUrlFor,
	narHashToHex,
	normaliseTrustedPublicKeys,
	normaliseVersion,
	parseChecksums,
	parseLines,
	releaseApiPath,
	releaseWorkflowIdentityRegex,
	renderChecksums,
	renderNixConfig,
	verifyReleaseAttestation
} from './cupboard-action.ts';
import {
	AttestationError,
	InvalidInputError,
	UnsupportedPlatformError
} from './errors.ts';

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

describe('narHashToHex', () => {
	it('decodes an SRI sha256 NAR hash to lower-case hex', () => {
		expect(
			narHashToHex('sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=')
		).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	});

	it.each([
		['not-a-hash'],
		['sha256:abc'],
		['sha512-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=']
	])('rejects %s', (narHash) => {
		expect(() => narHashToHex(narHash)).toThrow();
	});
});

describe('renderChecksums', () => {
	it('renders sha256sum lines that parseChecksums round-trips', () => {
		const rendered = renderChecksums([
			{
				storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
				sha256:
					'1111111111111111111111111111111111111111111111111111111111111111'
			},
			{
				storePath: '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime',
				sha256:
					'2222222222222222222222222222222222222222222222222222222222222222'
			}
		]);

		expect(rendered).toBe(
			'1111111111111111111111111111111111111111111111111111111111111111  0123456789abcdfghijklmnpqrsvwxyz-app\n' +
				'2222222222222222222222222222222222222222222222222222222222222222  3123456789abcdfghijklmnpqrsvwxyz-runtime\n'
		);
		expect(Object.fromEntries(parseChecksums(rendered))).toStrictEqual({
			'0123456789abcdfghijklmnpqrsvwxyz-app':
				'1111111111111111111111111111111111111111111111111111111111111111',
			'3123456789abcdfghijklmnpqrsvwxyz-runtime':
				'2222222222222222222222222222222222222222222222222222222222222222'
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

describe('releaseWorkflowIdentityRegex', () => {
	it('matches the release workflow on any ref but no other workflow', () => {
		const regex = new RegExp(releaseWorkflowIdentityRegex('owner/repo'));
		const base = 'https://github.com/owner/repo/.github/workflows';

		expect({
			main: regex.test(`${base}/release.yml@refs/heads/main`),
			tag: regex.test(`${base}/release.yml@refs/tags/v1.0.0`),
			other: regex.test(`${base}/evil.yml@refs/heads/main`)
		}).toStrictEqual({ main: true, tag: true, other: false });
	});
});

const attestationTagCommit = 'a'.repeat(40);
const attestationOptions = {
	releaseRepository: 'owner/repo',
	version: 'v1.0.0',
	githubToken: '',
	environment: {}
};

function attestationInputUrl(input: string | URL | Request): string {
	if (typeof input === 'string') {
		return input;
	}

	if (input instanceof URL) {
		return input.href;
	}

	return input.url;
}

async function writeArchive(): Promise<{
	readonly path: string;
	readonly digest: string;
}> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attest-'));
	const archivePath = path.join(directory, 'cupboard.tar.gz');
	const bytes = new Uint8Array([1, 2, 3]);

	await writeFile(archivePath, bytes);

	return {
		path: archivePath,
		digest: createHash('sha256').update(bytes).digest('hex')
	};
}

function stubAttestationFetch(attestations: unknown[]): typeof fetch {
	return (input) => {
		const url = attestationInputUrl(input);

		if (url.includes('/commits/v1.0.0')) {
			return Promise.resolve(Response.json({ sha: attestationTagCommit }));
		}

		if (url.includes('/attestations/')) {
			return Promise.resolve(Response.json({ attestations }));
		}

		return Promise.resolve(new Response('not found', { status: 404 }));
	};
}

function verifiedAs(digest: string, commit: string): VerifiedBundle {
	return {
		signer: {
			key: createPublicKey({
				key: Buffer.from(
					'MCowBQYDK2VwAyEA74apN5wWAk7Q7yJ1hzf0EMHdcmIRanVgF1Xqz+VpOl8=',
					'base64'
				),
				format: 'der',
				type: 'spki'
			})
		},
		predicateType: 'https://slsa.dev/provenance/v1',
		subjectDigests: [digest],
		predicate: {
			buildDefinition: {
				resolvedDependencies: [{ digest: { gitCommit: commit } }]
			}
		}
	};
}

describe('verifyReleaseAttestation', () => {
	it('accepts a bundle built by the release workflow from the tag commit', async () => {
		const archive = await writeArchive();

		await expect(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: stubAttestationFetch([{ bundle: {} }]),
				verify: () =>
					Promise.resolve(verifiedAs(archive.digest, attestationTagCommit))
			})
		).resolves.toBeUndefined();
	});

	it('rejects a bundle built from a different commit', async () => {
		const archive = await writeArchive();

		await expect(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: stubAttestationFetch([{ bundle: {} }]),
				verify: () =>
					Promise.resolve(verifiedAs(archive.digest, 'b'.repeat(40)))
			})
		).rejects.toThrow(AttestationError);
	});

	it('rejects when there is no attestation', async () => {
		const archive = await writeArchive();

		await expect(
			verifyReleaseAttestation(attestationOptions, archive.path, 'v1.0.0', {
				fetch: stubAttestationFetch([])
			})
		).rejects.toThrow(AttestationError);
	});
});

describe('action input errors', () => {
	it('rejects an empty version as a usage error', () => {
		expect(() => normaliseVersion('  ')).toThrow(InvalidInputError);
	});

	it('rejects an unsupported platform', () => {
		expect(() => assetNameFor('v1.2.3', 'sunos', 'sparc')).toThrow(
			UnsupportedPlatformError
		);
	});
});
