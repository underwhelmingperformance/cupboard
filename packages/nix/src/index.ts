export type { NixDependencies, RealPath } from './nix.ts';
export { Nix } from './nix.ts';
export type {
	NixDerivedPathString,
	NixMissingPartition,
	NixStoreDirectorySource,
	NixValidPathInfo
} from './nix-store.ts';
export {
	InvalidNixStoreDirectoryError,
	InvalidNixStorePathError,
	NixConfigIncludeError,
	NixConfigSettingError,
	NixDaemonUnavailableError,
	NixStoreDatabaseError,
	NixStoreError,
	NixStorePathNotFoundError,
	NotInNixStoreError,
	UnsupportedNixStoreError,
	UnsupportedNixStoreOperationError
} from './nix-store.ts';
export type { NixDaemonClientOptions } from './store-client.ts';
export type {
	NixDaemonOverrides,
	NixDaemonSetOptions,
	NixStoreConfig
} from './store-config.ts';
export { discoverNixStoreConfig } from './store-config.ts';
