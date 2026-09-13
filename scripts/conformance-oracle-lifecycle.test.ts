import { beforeEach, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
	release: vi.fn(),
	system: vi.fn(() => Promise.resolve('aarch64-darwin' as const)),
	version: vi.fn(() => Promise.resolve('unused-version'))
}));

vi.mock('./conformance-oracle.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./conformance-oracle.ts')>()),
	resolveConformanceNixBinary: () =>
		Promise.resolve({
			binary: '/unused/nix',
			outLink: '/unused/oracle-root',
			releaseOutLink: probe.release
		}),
	readNixSystem: probe.system,
	readNixVersion: probe.version
}));

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
});

it.each(['system', 'version'] as const)(
	'releases the oracle root when the %s probe fails',
	async (phase) => {
		const failure = new Error(`${phase} probe failed`);
		probe[phase].mockRejectedValueOnce(failure);

		await expect(import('../tests/conformance/oracle.ts')).rejects.toThrow(
			failure
		);
		expect(probe.release.mock.calls).toStrictEqual([[]]);
	}
);
