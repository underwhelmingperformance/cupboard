export const compatibilityTests = [
	'NixOS installer compatibility > accepts a hook executable available only to the trusted daemon',
	'NixOS installer compatibility > uses the exact installed version through a trusted daemon',
	'NixOS installer compatibility > builds and realises a local derivation as the runner user',
	'NixOS installer compatibility > connects to the official cache with the installed certificate configuration',
	'NixOS installer compatibility > job-scoped SSH > evaluates a private Git input with wrong key',
	'NixOS installer compatibility > job-scoped SSH > evaluates a private Git input with wrong host pin',
	'NixOS installer compatibility > job-scoped SSH > evaluates a private Git input with valid credentials',
	'NixOS installer compatibility > job-scoped SSH > builds through job-scoped SSH configuration with local builds disabled and wrong key',
	'NixOS installer compatibility > job-scoped SSH > builds through job-scoped SSH configuration with local builds disabled and wrong host pin',
	'NixOS installer compatibility > job-scoped SSH > builds through job-scoped SSH configuration with local builds disabled and valid credentials'
] as const;

export const pipelineTests = [
	'a consumer repository publish run > publishes from the runner store, retains both targets on rerun, and rebuilds when requested',
	'a consumer repository publish run > publishes under the trust rule the GitHub branch preset creates',
	'a consumer repository publish run > publishes a cohort whose derivation graph exceeds the capture limit',
	'a consumer repository publish run > publishes a cohort whose demand exceeds the tenant credit budget',
	'a consumer repository publish run > installed from a release archive > publishes a cohort the packaged executable builds and pushes',
	'a consumer repository publish run > against an ssh-ng remote store > builds and publishes every target from the remote store',
	'a consumer repository publish run > against an ssh-ng remote store > builds a missing runtime dependency before substituting the targets'
] as const;

export const remoteStoreTests = [
	'remote Nix store end to end > isolates every local Nix process in a temporary store and configuration',
	'remote Nix store end to end > streams a remote build while its temporary root protects it from GC',
	'remote Nix store end to end > observes remote-store execution for cold builds and warm checks',
	'remote Nix store end to end > distinguishes onward builder dispatch from execution in the selected remote store',
	'remote Nix store end to end > rejects a host key that does not identify the remote store',
	'remote Nix store end to end > uses job-scoped SSH credentials independently of the store URI',
	'remote Nix store end to end > uses the prepare action transport for native copy and rejects the wrong host pin',
	'remote Nix store end to end > cancels one SSH daemon and reconnects with no remote process left behind',
	'remote Nix store end to end > cancels native copy and its remote SSH process tree',
	'remote Nix store end to end > cancels an action-level remote cohort before publication',
	'remote Nix store end to end > publishes mixed already-valid and new outputs without inferring remote execution',
	'remote Nix store end to end > plans and publishes six cold derivations through a real SSH store',
	'remote Nix store end to end > publishes remote outputs across copy-barrier GC and resolves attestation subjects after the store disappears',
	'remote Nix store end to end > publishes a mixed remote build with a receipt and retention root'
] as const;
