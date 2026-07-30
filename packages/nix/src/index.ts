export type { NixDependencies, RealPath } from './nix.ts';
export { Nix } from './nix.ts';
export type { NixStoreDirectorySource, NixValidPathInfo } from './nix-store.ts';
export {
	InvalidNixStoreDirectoryError,
	InvalidNixStorePathError,
	NixConfigIncludeError,
	NixConfigSettingError,
	NixStoreDatabaseError,
	NixStoreError,
	NixStorePathNotFoundError,
	NotInNixStoreError,
	UnsupportedNixStoreError
} from './nix-store.ts';
export type {
	NixDaemonOverrides,
	NixDaemonSetOptions,
	NixStoreConfig
} from './store-config.ts';
export { discoverNixStoreConfig } from './store-config.ts';
