export type { NixDependencies, RealPath } from './nix.ts';
export { Nix } from './nix.ts';
export type { NixValidPathInfo } from './nix-store.ts';
export {
	NixConfigIncludeError,
	NixConfigSettingError,
	NixStoreDatabaseError,
	NixStoreError,
	NixStorePathNotFoundError,
	NotInNixStoreError,
	UnsupportedNixStoreError,
	UnsupportedNixStoreOperationError
} from './nix-store.ts';
