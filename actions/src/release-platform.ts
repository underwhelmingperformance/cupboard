import { arch, platform } from 'node:process';

import {
	IntelMacOsUnsupportedError,
	UnsupportedPlatformError
} from './errors.ts';

const releaseAssetSuffixes = new Map([
	['linux-x64', 'linux-x64'],
	['linux-arm64', 'linux-arm64'],
	['darwin-arm64', 'macos-arm64']
]);

/**
Throws when the host is not a supported platform, so that a caller can fail
before it contacts GitHub or runs a supplied cupboard executable. The check
looks only at the host. On x86_64 macOS it refuses every release, including
older releases that still have a `cupboard-macos-x64.tar.gz` asset.
*/
export function assertReleasePlatformSupported(
	runtimePlatform: string = platform,
	runtimeArchitecture: string = arch
): void {
	assetNameFor(runtimePlatform, runtimeArchitecture);
}

export function assetNameFor(
	runtimePlatform: string = platform,
	runtimeArchitecture: string = arch
): string {
	if (runtimePlatform === 'darwin' && runtimeArchitecture === 'x64') {
		throw new IntelMacOsUnsupportedError();
	}

	const suffix = releaseAssetSuffixes.get(
		`${runtimePlatform}-${runtimeArchitecture}`
	);

	if (suffix === undefined) {
		throw new UnsupportedPlatformError(runtimePlatform, runtimeArchitecture);
	}

	return `cupboard-${suffix}.tar.gz`;
}
