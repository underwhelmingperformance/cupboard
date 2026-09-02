# Cache lifecycle, managed publication and staged deployment

## Summary and invariants

Complete the cache-centred model, fix the lifecycle and migration blockers, add
managed pull-request caches, and make one final release artifact capable of
upgrading the current production deployment without checking out intermediate
commits.

The deployment system uses a checked-in declarative state machine. Each
transition describes a pre-known source and target state, exact structural
migrations, runtime stage, application migration, prerequisites and completion
checks. The public API advances that state machine. It cannot select code, SQL,
tenants or migration handlers.

Preserve these invariants:

- `CacheScope` is the only cache identity model.
- Access, priority, retention, management and lifecycle remain independent cache
  properties.
- No empty string, omitted field, URL namespace or private-name prefix
  represents cache identity or access outside migration adapters.
- Cache scope and generation identify an incarnation.
- Older generations cannot read, overwrite or delete newer-generation state.
- Cache-local mutable R2 metadata is generation-scoped.
- Durable caches are never retired automatically.
- Only policy-managed caches can retire automatically.
- A permanent root prevents automatic retirement. Managed policies disallow
  permanence by default.
- Reuse views retain explicit access and select only caches with the same
  access.
- Policy status never changes read authentication.
- Queue messages only wake durable work. They never carry authoritative mutation
  state.
- Every semantic migration completes before its D1 or Durable Object contract.
- Every supported direct upgrade retains its TypeScript migrators, adapters and
  populated fixtures.
- Structural SQL migrations and the deployment manifest remain declarative and
  immutable.
- Semantic data work runs through finite, compiled TypeScript handlers which the
  caller cannot select directly.

## Stack and commit order

Rewrite the existing stack in a clean worktree based on the latest
`origin/main`. Preserve the current dirty checkout. Inherit the attestation fix
from `main`; do not reproduce it in this stack.

Fold corrections into the commits that introduce the affected contract. Do not
append a series of repair commits.

1. Keep `refactor(protocol): declare cache-scoped procedures once`.

2. Add `feat(deploy): declare staged application migrations`.

   Include the generic deployment state machine, ledgers, finite control
   procedures, runtime-stage support, migration checksums, read-only preview and
   injected PITR interfaces. Add the control-only recovery bucket, resumable
   fresh-install claim, successor-artifact adoption protocol and
   capability-limited migration context. Include the fixed legacy bootstrap
   protocol without naming cache migrations which do not exist yet. Use a
   trivial manifest initially.

3. Amend `refactor(storage): expand cache identity columns`.

   Add backward-compatible D1 and local state for native cache identity, access,
   generation, read revision, lifecycle, creation deadlines, writer epochs and
   credential targets. Install compatibility triggers for writes from the
   pre-stack Worker.

4. Amend `refactor(storage): backfill native cache identities`.

   Cover active, suspended and offboarding tenants consistently. Create
   lifecycle state for every referenced cache identity. Treat offboarded tenants
   as cleanup-only. Add the populated offboarding fixture which currently blocks
   the full migration sequence.

5. Amend `refactor(cache)!: make access a property of each cache`.

   Restore the TypeScript catalogue reconciler, its typed internal RPC,
   maintenance executor, completion checks and fresh-DO bootstrap. Include the
   fix which restores a D1-live cache over stale local deletion state.

6. Amend the credential and native-writer commits.

   Require an exact live lifecycle before inserting a cache credential. Prevent
   the previous Worker from creating credential orphans. Convert ordinary
   writers to native identity and stamp persistent work with one release-wide
   writer epoch.

7. Add `fix(cache): fence cache incarnations`.

   Add generation-bearing R2 keys, creation recovery, exact lifecycle admission,
   Workers Cache revisions, generation-safe teardown and the bounded R2
   migration.

8. Amend `refactor(cache)!: make retention a cache property`.

   Add explicit root retention states, immutable shared prefix-rule sets,
   additive local storage, the bounded retention migration and policy-write
   fencing.

9. Add `feat(deploy): stage the cache storage transition`.

   Declare the concrete release states, runtime stages, data migrations, checks
   and exact D1/DO migration sets now that every implementation exists. Bind the
   complete Worker upload descriptors, CLI deployment executor and resolved
   Cloudflare topology. Add per-tenant admission for local contraction. Add the
   persistence-backed multi-stage Miniflare harness and the checked-in
   predecessor compatibility probe which exercise this complete release
   sequence.

10. Change `refactor(storage): retire cache migration state`.

    Remove legacy logic from ordinary native requests. Retain every migration
    registry entry, handler, RPC, queue wake-up path, ledger, compatibility
    adapter and oldest-supported fixture needed by the first two runtime stages.

11. Move and amend `refactor(storage): contract cache identity storage`.

    Add the D1 and local contracts together with their manifest gates. Remove
    compatibility columns and triggers only through the declared contract
    transitions.

12. Add `feat(cache): manage ephemeral cache families`.

    Add managed policy families, immutable revisions, homogeneous groups,
    restricted provisioning, leases, capacity, updates and retirement. Keep
    manual cache creation durable.

13. Add `feat(github): publish through managed pull-request caches`.

    Configure the policy, OIDC authority and group reuse view. Provision the
    cache before negotiation. Split destination-specific and tenant-fallback
    credentials. Update the CLI, Actions and reusable workflow.

14. Amend the final documentation commit.

    Add the deployment and recovery runbook, correct read-authority
    descriptions, document managed lifecycle and retention, and complete the
    access terminology pass.

Regenerate structural migrations after reordering. Do not hand-edit migrations
generated by Drizzle. Each commit must pass its package-level format, lint,
type, migration and behavioural gates without relying on later commits.

## Declarative deployment system

### Release manifest

The release separates the content-addressed manifest body from its digest and
from the uploaded artifacts:

```ts
type DeploymentRelease = {
  manifestId: DeploymentManifestId;
  artifactId: DeploymentArtifactId;
  manifest: DeploymentManifestBody;
  artifacts: StaticDeploymentArtifacts;
};

type StaticDeploymentArtifacts = {
  manifestId: DeploymentManifestId;
  artifactId: DeploymentArtifactId;
  deploymentExecutorHash: DeploymentExecutorSha256;
  tenant: WorkerUploadTemplate;
  control: WorkerUploadTemplate;
};

type DeploymentInstance = {
  identity: DeploymentIdentity;
  topology: ResolvedDeploymentTopology;
  tenant: ResolvedWorkerUploadDescriptor;
  control: ResolvedWorkerUploadDescriptor;
};

type WorkerUploadTemplate = {
  bundleHash: BundleSha256;
  versionTag: CloudflareWorkerVersionTag;
  mainModule: string;
  compatibilityDate: IsoDate;
  compatibilityFlags: readonly string[];
  bindings: readonly WorkerBindingTemplate[];
  exports: readonly WorkerExportDescriptor[];
  limits: WorkerUploadLimits;
  placement: WorkerPlacement | null;
  settings: CanonicalWorkerUploadSettings;
};

type ResolvedWorkerUploadDescriptor = WorkerUploadTemplate & {
  bindings: readonly ResolvedWorkerBindingDescriptor[];
};

type DeploymentManifestBody = {
  initialState: DeploymentStateId;
  terminalState: DeploymentStateId;
  states: readonly DeploymentState[];
  forwardTransitions: readonly ForwardDeploymentTransition[];
  recoveryTransitions: readonly RecoveryDeploymentTransition[];
  bootstrapTransitions: readonly LegacyBootstrapTransition[];
  legacyRuntimeFingerprints: readonly LegacyRuntimeFingerprint[];
  runtimeStages: readonly RuntimeStage[];
  d1Migrations: readonly StructuralMigration[];
  durableObjectMigrations: readonly StructuralMigration[];
  dataMigrations: readonly DataMigrationDescriptor[];
  checks: readonly DeploymentCheckDescriptor[];
};

type RuntimeDeployment =
  | {
      kind: 'registered';
      stage: RuntimeStageId;
    }
  | {
      kind: 'legacy';
      fingerprint: LegacyRuntimeFingerprintId;
    };

type DeploymentState = {
  id: DeploymentStateId;
  d1Schema: D1SchemaStateId;
  tenantRuntime: RuntimeDeployment;
  controlRuntime: RuntimeDeployment;
  localSchema: {
    runtimeCeiling: DurableObjectMigrationId;
    fleetState: LocalSchemaFleetState;
  };
  writerEpoch: WriterEpoch;
  representations: {
    catalogue: RepresentationState;
    r2Metadata: RepresentationState;
    retention: RepresentationState;
    legacyR2: {
      writes: 'enabled' | 'disabled';
      readFallback: 'enabled' | 'disabled';
      deletion: 'forbidden' | 'eligible';
    };
  };
  fences: {
    d1ApplicationWrites: 'open' | 'closed';
    retentionAdministration: 'open' | 'closed';
    tenantLocalContractAdmission: 'not-required' | 'required';
  };
  recoveryPoints: {
    d1: 'absent' | 'recorded';
    durableObjectFleet: LocalRecoveryPointFleetState;
  };
};

type ForwardDeploymentTransition =
  | {
      id: DeploymentTransitionId;
      from: DeploymentStateId;
      to: DeploymentStateId;
      kind: 'apply-d1';
      migrations: readonly D1MigrationId[];
      checks: readonly DeploymentCheckId[];
    }
  | {
      id: DeploymentTransitionId;
      from: DeploymentStateId;
      to: DeploymentStateId;
      kind: 'deploy-runtime-stage';
      stage: RuntimeStageId;
      checks: readonly DeploymentCheckId[];
    }
  | {
      id: DeploymentTransitionId;
      from: DeploymentStateId;
      to: DeploymentStateId;
      kind: 'run-data-migration';
      migration: DataMigrationId;
      checks: readonly DeploymentCheckId[];
    }
  | {
      id: DeploymentTransitionId;
      from: DeploymentStateId;
      to: DeploymentStateId;
      kind: 'drain-writer-epoch';
      before: WriterEpoch;
      checks: readonly DeploymentCheckId[];
    }
  | {
      id: DeploymentTransitionId;
      from: DeploymentStateId;
      to: DeploymentStateId;
      kind: 'set-deployment-fence';
      fence: 'd1-application-writes' | 'retention-administration';
      value: 'open' | 'closed';
      checks: readonly DeploymentCheckId[];
    }
  | {
      id: DeploymentTransitionId;
      from: DeploymentStateId;
      to: DeploymentStateId;
      kind: 'record-recovery-point';
      storage: 'd1' | 'durable-object-fleet';
      checks: readonly DeploymentCheckId[];
    }
  | {
      id: DeploymentTransitionId;
      from: DeploymentStateId;
      to: DeploymentStateId;
      kind: 'set-tenant-local-contract-admission';
      value: 'not-required' | 'required';
      checks: readonly DeploymentCheckId[];
    }
  | {
      id: DeploymentTransitionId;
      from: DeploymentStateId;
      to: DeploymentStateId;
      kind: 'resolve-repair-intents';
      repairClass: 'cross-store-projection';
      checks: readonly DeploymentCheckId[];
    }
  | {
      id: DeploymentTransitionId;
      from: DeploymentStateId;
      to: DeploymentStateId;
      kind: 'close-r2-compatibility-window';
      checks: readonly DeploymentCheckId[];
    }
  | {
      id: DeploymentTransitionId;
      from: DeploymentStateId;
      to: DeploymentStateId;
      kind: 'verify';
      checks: readonly DeploymentCheckId[];
    };

type LegacyBootstrapTransition = {
  id: DeploymentBootstrapTransitionId;
  from: DeploymentStateId;
  to: DeploymentStateId;
  kind: 'bootstrap-legacy-runtime';
  sourceFingerprint: LegacyRuntimeFingerprintId;
  migrations: readonly D1MigrationId[];
  stage: RuntimeStageId;
  checks: readonly DeploymentCheckId[];
};

type DataMigrationResultAdoption = {
  predecessorMigration: DataMigrationId;
  successorMigration: DataMigrationId;
  completed:
    | { kind: 'reverify'; checks: readonly DeploymentCheckId[] }
    | { kind: 'rerun'; checkpoint: DataMigrationCheckpointId };
  notApplicable: {
    kind: 'revalidate';
    checks: readonly DeploymentCheckId[];
    becameApplicable: {
      kind: 'restart';
      checkpoint: DataMigrationCheckpointId;
    };
  };
  incomplete:
    | {
        kind: 'resume';
        cursorFormat: DataMigrationCursorFormatId;
        implementationCompatibility: DataMigrationCompatibilityId;
      }
    | { kind: 'restart'; checkpoint: DataMigrationCheckpointId };
  invariantFailure:
    | { kind: 'preserve' }
    | { kind: 'repair'; repair: RegisteredForwardRepairId };
};

type RecoveryDeploymentTransition =
  | {
      id: DeploymentRecoveryTransitionId;
      from: DeploymentStateId;
      to: DeploymentStateId;
      kind: 'restore-d1';
      recoveryEnvelope: D1RecoveryEnvelopeId;
      checks: readonly DeploymentCheckId[];
    }
  | {
      id: DeploymentRecoveryTransitionId;
      from: DeploymentStateId;
      to: DeploymentStateId;
      kind: 'restore-durable-objects';
      cohort: DataMigrationId;
      bookmarkPhase: LocalContractPhase;
      checks: readonly DeploymentCheckId[];
    }
  | {
      id: DeploymentRecoveryTransitionId;
      from: DeploymentStateId;
      to: DeploymentStateId;
      kind: 'deploy-recovery-stage';
      stage: RuntimeStageId;
      checks: readonly DeploymentCheckId[];
    }
  | {
      id: DeploymentRecoveryTransitionId;
      from: DeploymentStateId;
      to: DeploymentStateId;
      kind: 'forward-repair';
      repair: RegisteredForwardRepairId;
      checks: readonly DeploymentCheckId[];
    }
  | {
      id: DeploymentRecoveryTransitionId;
      kind: 'adopt-predecessor-deployment';
      compatiblePredecessorArtifacts: readonly DeploymentArtifactId[];
      predecessorState: DeploymentStateId;
      to: DeploymentStateId;
      migrationResults: readonly DataMigrationResultAdoption[];
      checks: readonly DeploymentCheckId[];
    };
```

`DeploymentState` describes observable storage and runtime facts. Preview,
advancement and recovery compare those facts with D1 migration records, Worker
metadata, tenant probes and migration ledgers. They do not interpret an opaque
state name through an operation handler.

Forward transitions form one linear sequence. Recovery edges live in a separate
registry, so a forward transition cannot create a cycle. A transition refers to
checks rather than to previously visited states: returning to a state does not
imply that an earlier check still holds.

The legacy source state uses recognised tenant and control runtime fingerprints.
It does not pretend that the pre-stack Workers implement one of the new
registered stages. The bootstrap transition, its exact additive migrations, its
target stage and its checks remain manifest data even though the CLI must
execute the transition until the new control Worker is available.

The manifest contains no function reference, handler name, runtime SQL,
arbitrary argument or client-supplied payload. Generic executors implement each
transition kind. A separate compiled registry binds each data-migration and
check ID to exactly one implementation. The transition-specific migrations,
runtime stage, data migration, writer epoch and checks remain in manifest data.

Each data-migration descriptor declares:

- an immutable ID and implementation revision;
- source and target representation;
- eligible tenant statuses;
- required runtime stage and schema states;
- fixed statement, row, parameter and R2-operation budgets;
- durable cursor and delta-journal requirements;
- completion invariants;
- retryable and terminal failure codes.

Each forward transition kind has a fixed state effect. `set-deployment-fence`
may change only the named fence. `record-recovery-point` may change only the
corresponding recovery-point fact. `set-tenant-local-contract-admission` may
change only the tenant-local admission requirement.
`close-r2-compatibility-window` disables legacy writes and read fallback and
makes legacy objects eligible for deletion. `resolve-repair-intents` may
complete or roll back only the durable repairs in its declared class and must
finish with an empty set. `verify` runs checks and may not change any state
fact. Generic executors cannot smuggle these mutations into checks or
data-migration handlers.

Build validation rejects:

- missing, duplicate or undeclared registry entries;
- more than one forward successor from a normal state;
- any cycle in the forward sequence;
- a recovery edge not present in the recovery registry;
- a successor-adoption edge whose predecessor identity or source state is not
  exact;
- a migration-result adoption without an explicit revalidation or rerun rule;
- a successor runtime which cannot execute against the predecessor's observed D1
  and local schema states;
- a legacy source state whose fingerprint is not declared;
- a bootstrap transition whose source fingerprint, migrations or target stage
  differ from the state change it declares;
- migration filename reordering;
- unknown local migration ceilings;
- contract transitions without migration and drainage prerequisites;
- an `apply-d1` transition whose declared migrations do not produce the target
  state's D1 schema;
- a runtime transition whose declared stage does not produce the target runtime
  and local ceiling;
- a data-migration transition whose descriptor does not produce the target
  representation state;
- a transition which changes a state fact outside the fixed effect of its
  discriminant;
- a `verify` transition whose source and target facts differ;
- a terminal state whose tenant-local contract admission is not `required`;
- runtime stages incompatible with adjacent D1 states;
- an artifact descriptor whose manifest ID, artifact ID or bundle hashes do not
  match the generated release;
- an upload field or binding requirement which is omitted from the canonical
  artifact input;
- handlers required by the oldest-supported fixture which are absent from the
  artifact.

Use a manifest identity, a static artifact identity and an installation-specific
deployment-instance identity:

```text
manifestId = sha256(canonicalJson(DeploymentManifestBody))
artifactId = sha256(canonicalJson({
  manifestId,
  deploymentExecutorHash,
  tenantUploadTemplate,
  controlUploadTemplate
}))
instanceId = sha256(canonicalJson({
  artifactId,
  resolvedDeploymentTopology
}))
```

The build produces the manifest first and embeds `manifestId` in both Workers.
It hashes the complete deploy and bootstrap executor from the CLI distribution,
not one source module. Each canonical upload template covers every static,
non-secret field sent to Cloudflare, including the final module bytes,
compatibility date and flags, binding names and types, exports, limits,
placement and cache or runtime settings. It includes required secret binding
names and presence requirements, but never secret values or installation
resource identities.

`ResolvedDeploymentTopology` records the Cloudflare account, script, D1, R2,
Queue, service-binding, route and custom-domain identities which the manifest
expects the CLI to preserve. Values which are managed outside a Worker upload
remain checked topology facts instead of becoming implicit executor inputs.
Changing upload behaviour, bundle contents or the bootstrap implementation
changes `artifactId`. Changing the resolved account or resource topology changes
`instanceId` without requiring an installation-specific build.

The published CLI distribution contains the manifest and canonical upload
templates. Deployment preflight validates `artifactId`, then resolves the target
account's resource identities and produces `DeploymentInstance`. The bootstrap
or deployment claim persists the static artifact identity before resource
creation and seals the exact deployment-instance identity once every required
resource exists. A resumed command must reproduce the sealed identity; it cannot
silently resolve a replacement queue, bucket, database or script.

Complete bundle hashes cover migration implementations, imported helpers, checks
and generic executors. A source-level migration revision remains useful for
diagnostics, but it is not an integrity boundary.

Cloudflare assigns Worker version IDs during upload, so those IDs cannot be
artifact inputs. After upload, the ledger records the actual tenant and control
version IDs and binds them to the exact deployment instance. Each Worker reports
its embedded `manifestId`, `artifactId`, stage and runtime version metadata. The
CLI verifies that the resolved upload descriptors, assigned version IDs and
reported identities match the deployment instance.

### Structural migration immutability

Record the SHA-256 digest of the exact UTF-8 bytes of every newly applied D1 and
Durable Object migration.

For migrations applied before checksum tracking existed:

- verify that every applied name is a recognised historical migration;
- write a labelled one-time baseline checksum;
- record that the historical bytes could not be independently verified;
- enforce checksums for every later application.

Reject unknown applied migrations, missing expected migrations and checksum
mismatches. Record both deployment identities and the diagnostic handler
revision with every TypeScript migration completion.

### Runtime stages

Use three registered stages. A deployment option selects only a registered stage
ID, never an arbitrary local migration ceiling.

1. `cache-migration-foundation`

   - Applies every additive local structure needed by native requests, writer
     epochs, catalogue reconciliation, generation-bearing R2 objects, retention
     and all later migrators.
   - Enables catalogue reconciliation.
   - Stops before every local assertion and contract.
   - Supports the expanded and compatible D1 states.
   - Retains legacy R2 and retention adapters for incomplete tenants.

2. `cache-data-migrations`

   - Retains the complete first-stage initialisation path for a DO which slept
     through stage one.
   - Uses the same additive local ceiling and the same writer epoch.
   - Enables the R2 and retention migrations after old-writer drainage.
   - Supports D1 both before and after final contraction.
   - Does not introduce request-path tables or columns.

3. `cache-storage-contract`

   - Retains recovery paths from every supported old local watermark.
   - Applies local assertions and contracts only after global migration gates
     pass.
   - Uses only the native request model.
   - Supports contracted D1.

Every DO event passes through the stage initialisation barrier, including HTTP
requests, service-binding RPCs, alarms and WebSocket sessions.

The foundation and data-migration states declare legacy R2 writes and read
fallback as enabled and legacy deletion as forbidden. The storage-contract stage
requires the opposite facts. The manifest must therefore execute
`close-r2-compatibility-window` before it can deploy that stage.

### Control API

Expose two contract-first control procedures:

```ts
type DeploymentIdentity = {
  artifactId: DeploymentArtifactId;
  instanceId: DeploymentInstanceId;
};

deploymentStatus({
	deployment: DeploymentIdentity;
}): DeploymentStatus;

deploymentAdvance({
	deployment: DeploymentIdentity;
	expectedState: DeploymentStateId;
	targetState: DeploymentStateId;
	expectedRevision: DeploymentRevision;
	attemptId?: DeploymentAttemptId;
	externalObservation?: CloudflareDeploymentObservation;
}): DeploymentAdvanceResult;
```

`targetState` is an optimistic assertion. The Worker accepts it only when it is
the sole immediate successor of the persisted state in its embedded manifest.
The Worker derives the operation, migration and checks from that transition.

Apart from the attempt ID and fixed deployment observation above, the endpoint
cannot accept:

- a migration ID;
- a handler name;
- SQL or source text;
- a tenant or cache selector;
- a batch size;
- migration-specific arguments;
- a cursor or completion status.

A transition has durable `pending`, `running`, `completed` or `failed` execution
state, an attempt ID and an expiring claim. A retry after a lost response
returns or resumes the same transition. It cannot begin the successor until the
current transition is durably complete.

`deploymentStatus` is read-only. It reports the current transition and the next
expected action but cannot claim or start one.

For a transition which requires an external Cloudflare action:

1. The first `deploymentAdvance` call claims the transition.
2. It returns `external-action-required`, the attempt ID and the exact action
   declared by the manifest.
3. The CLI performs that action.
4. The CLI calls `deploymentAdvance` again with the same source state, target
   state, revision and attempt ID.
5. The Worker verifies the available evidence before completing the transition.

The strict `externalObservation` value can contain only Cloudflare deployment
topology and version evidence required by a `deploy-runtime-stage` transition.
It cannot select an action or alter its arguments. D1 transitions are verified
directly from migration names and checksums.

Cloudflare's [version-metadata binding][cloudflare-version-metadata] proves only
the version ID, tag and creation time of the executing Worker. Deployment
evidence therefore combines:

- the CLI's Cloudflare API observation that the tenant and control scripts each
  run the expected version at 100%;
- the control Worker's own embedded manifest, stage and version metadata;
- a service-binding probe of the tenant Worker's embedded manifest, stage and
  version metadata;
- the artifact mapping from canonical upload descriptors to the Worker version
  IDs which the CLI observed after upload.

The ledger records both observed version IDs and the artifact mapping. A
deployment operator can upload arbitrary Worker code already, so the server may
accept the CLI's strictly typed topology observation after corroborating every
runtime fact it can observe itself.

[cloudflare-version-metadata]:
  https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/

Add a separate manifest-constrained recovery procedure:

```ts
deploymentRecover({
	deployment: DeploymentIdentity;
	expectedState: DeploymentStateId;
	targetRecoveryState: DeploymentStateId;
	expectedRevision: DeploymentRevision;
}): DeploymentRecoveryResult;
```

It accepts only recovery edges declared for the persisted state. It cannot
select a migration or arbitrary runtime.

### Successor artifact recovery

A corrected artifact must be able to supersede a failed deployment without
changing migration state by hand. The successor manifest declares an
`adopt-predecessor-deployment` recovery edge for a finite set of compatible
predecessor artifact IDs and one source state. The checked-in manifest therefore
remains installation-independent. Successor preparation binds the exact
predecessor and successor deployment instances. The predecessor manifest does
not need to predict the identity of a future correction.

Persist the execution which the successor intends to replace:

```ts
type PredecessorExecutionSnapshot = {
  transitionId: DeploymentTransitionId;
  attemptId: DeploymentAttemptId;
  phase: DeploymentExecutionPhase;
  claimRevision: DeploymentClaimRevision;
  claimExpiresAt: IsoTimestamp | null;
  externalAction: ExternalActionPhase | null;
};
```

Expose two narrow procedures:

```ts
deploymentPrepareSuccessor({
  predecessor: DeploymentIdentity;
  successor: DeploymentIdentity;
  expectedState: DeploymentStateId;
  expectedRevision: DeploymentRevision;
}): SuccessorPreparationResult;

deploymentAdoptPredecessor({
  predecessor: DeploymentIdentity;
  successor: DeploymentIdentity;
  predecessorState: DeploymentStateId;
  expectedRevision: DeploymentRevision;
  attemptId: DeploymentAttemptId;
  externalObservation: CloudflareDeploymentObservation;
}): DeploymentAdoptionResult;
```

Neither procedure accepts a migration, result rule, handler or target state. The
successor Worker derives those values from the sole matching recovery edge in
its embedded manifest.

Use a two-sided adoption protocol:

1. The current control Worker conditionally records a successor-preparation
   claim containing the exact predecessor identity, failed state, deployment
   revision, execution snapshot and proposed successor identity. This procedure
   does not execute successor code or choose a migration.
2. The CLI verifies that the successor manifest contains the matching adoption
   edge, then uploads the complete successor artifact.
3. The successor control Worker verifies its embedded manifest, the prepared
   claim, the predecessor ledger and the observed storage state.
4. The successor Worker runs the adoption edge's checks and applies its declared
   migration-result rules.
5. One D1 transaction makes the successor identity current, records the observed
   Worker version IDs and completes the adoption claim.

An active predecessor claim blocks preparation. A predecessor execution is
quiescent only when it has a terminal failure, or when its claim has expired and
the successor recovery edge declares how to settle that transition kind. The
declared rule may abandon an action which was never issued, observe and adopt an
idempotently completed action, observe and repair partial effects, or restart an
idempotent action after the earlier attempt has settled.

Preparation marks the predecessor deployment `superseding` and advances the
deployment revision. The official CLI rereads that claim immediately before an
external action. A callback or completion report with the predecessor attempt or
revision is rejected. If an external action may already have started, adoption
waits for its declared settlement period and re-observes the Worker topology or
D1 schema before making the successor current. Expiry alone is not evidence that
an issued external action has settled.

The successor-preparation procedure accepts only the two deployment identities
and the predecessor's optimistic state and revision. The global-administrator
and Cloudflare deployment checks still apply. The caller cannot pass a handler,
cursor, result policy or target migration.

If the faulty control Worker cannot serve this procedure, the CLI may write the
same strictly shaped preparation row through the Cloudflare D1 API. That path
requires Cloudflare authority over the recorded database and conditionally
checks the exact predecessor identity, failed state and revision. It cannot
change deployment state or migration results. The successor Worker still
performs every adoption check. The fixed legacy and fresh-install bootstraps use
the same identity-and-state CAS before the ordinary control API exists.

Each `DataMigrationResultAdoption` chooses one rule for each predecessor result:

- `complete` may become complete in the successor only after the successor
  reruns the declared representation and completion checks;
- a changed representation contract or incompatible implementation requires a
  complete rerun from the retained source representation;
- `not-applicable` is never copied; the successor reruns the declared
  eligibility checks, records a new `not-applicable` result if they still hold,
  and otherwise starts applicable work at the declared checkpoint;
- pending, running or failed work may resume only when the successor declares
  the cursor format and implementation semantics compatible;
- incompatible incomplete work restarts from an explicitly declared idempotent
  checkpoint;
- an invariant failure remains blocking unless the successor edge declares and
  completes a typed repair before adoption.

The same rules apply to local tenant progress. Adoption never converts an
unknown cursor, missing source representation or terminal failure into a
successful result. Preview reports which tenant results will be revalidated,
reverified, resumed, restarted or repaired before the operator claims the edge.

### Internal Durable Object operation

The control plane calls a narrow internal operation:

```ts
advanceTenantDeployment({
	deployment: DeploymentIdentity;
	targetState: DeploymentStateId;
	claimId: MigrationClaimId;
	ledgerRevision: DeploymentRevision;
}): TenantDeploymentProgress;
```

The tenant identity comes from the DO binding. The DO verifies its embedded
manifest, current local state and durable claim before invoking the registered
handler. It loads all migration input, cursors and authoritative rows from
storage.

Queue messages contain only a deployment wake-up ID. Consumers reload the
transition and tenant ledger before acting. Delayed, duplicate and dead-lettered
messages cannot replay captured writes.

### Authority

Add `deployment:read` and `deployment:advance` operations. Configurable tenant
and control OIDC rules cannot request them.

Wildcard grant matching is necessary but not sufficient. Every deployment
procedure's contract metadata also requires a non-configurable deployment
principal. For this release, that principal is the issuer-and-subject identity
stored in the global-administrator record. The authorisation middleware verifies
both:

- a wildcard grant which permits the requested deployment operation; and
- a verified token principal which exactly matches the global administrator.

An interactive wildcard issued through an ordinary configurable trust rule does
not satisfy the principal requirement. Put this rule in shared contract metadata
and middleware so no deployment procedure can omit it.

For an existing deployment, preflight must:

1. Obtain or refresh the existing global-administrator token.
2. Call a control endpoint supported by the pre-stack Worker.
3. Verify issuer, audience and wildcard authority.
4. Verify that the running CLI distribution, Worker upload templates and bundle
   contents match `artifactId`, and that the resolved Worker uploads and
   topology match the sealed deployment instance.
5. Stop before any D1 or Worker mutation if renewable authority is unavailable.

After deploying a new runtime stage, the CLI obtains a fresh token before later
control calls. Durable migration work does not depend on one token remaining
valid.

A fresh deployment follows a separate path. It qualifies when the CLI has just
created the resources or when D1 contains an exact incomplete fresh-install
claim. An existing empty or partially initialised database without that claim
uses recovery, not the fresh path.

Before applying the empty-database schema, the CLI applies the one fixed
bootstrap-ledger migration through the Cloudflare D1 API. It then conditionally
inserts a `FreshInstallationBootstrap` row. If the process stops between those
operations, the next invocation recognises the empty bootstrap table and resumes
the insert. The row records:

```ts
type FreshInstallationPhase =
  | 'claimed'
  | 'resources-created'
  | 'topology-sealed'
  | 'schema-applied'
  | 'tenant-uploaded'
  | 'control-uploaded'
  | 'runtime-deployed'
  | 'administrator-onboarded'
  | 'complete';

type FreshInstallationBootstrap = {
  accountId: CloudflareAccountId;
  artifactId: DeploymentArtifactId;
  intendedResources: FreshInstallationResourceIntent;
  observedResources: FreshInstallationResourceProgress;
  instanceId: DeploymentInstanceId | null;
  topologyDigest: DeploymentTopologyDigest | null;
  phase: FreshInstallationPhase;
  claimId: DeploymentClaimId;
  claimRevision: DeploymentClaimRevision;
  claimOwner: DeploymentClaimOwner;
  claimExpiresAt: IsoTimestamp;
  onboardingChallengeHash: OnboardingChallengeHash | null;
  updatedAt: IsoTimestamp;
};
```

- the Cloudflare account, static artifact identity and intended resource names;
- the exact D1, R2, Queue and Worker script identities as the CLI creates them;
- the deployment-instance identity and topology digest after sealing;
- a claim ID, revision, owner and expiry;
- progress through resource creation, schema application, each Worker upload,
  final deployment and administrator onboarding;
- a one-time onboarding challenge hash.

Create D1 first, then create the bootstrap table and claim with `artifactId`
before creating any other Cupboard resource. Create the remaining resources
idempotently and record each observed identity. Once every required resource
exists, calculate the topology digest and `instanceId`, then seal both with a
compare-and-set operation. They cannot change after sealing. Apply the remaining
schema and upload Workers only after this transition. A resource whose name,
type, account or existing identity conflicts with the claim produces a typed
invariant failure.

A later invocation may claim a D1 database which has the exact empty fingerprint
and no Cupboard migration or application table. It must use the same configured
database identity and Cloudflare account. Once any other table exists, the
database requires either a matching bootstrap claim or the ordinary recovery
path.

The CLI authenticates this path through Cloudflare account authority because no
Cupboard administrator exists yet. A later invocation with authority over the
same account and resources may acquire an expired claim and resume its recorded
phase. It must reproduce every observed resource and the sealed instance
exactly. Before onboarding, that invocation conditionally replaces the challenge
hash and proves the new challenge to the bootstrap-only control procedure. This
procedure exists only while the administrator record is absent and the claim's
resource identities, deployment identity and revision match. Successful
onboarding invalidates the challenge and completes the claim atomically.

The fresh path applies the complete empty-database schema, deploys the final
runtime, performs administrator onboarding and then enters the terminal
deployment state. Every step records observed evidence before the next step
starts. A crash after any resource, migration or Worker upload therefore leaves
a resumable claim instead of an unauthorised partial installation.

Freeze the control origin, administrator identity, control trust, signing keys
and custom-domain routing throughout a staged upgrade.

### Direct-upgrade bootstrap

The pre-stack control Worker does not implement the deployment procedures. The
CLI therefore uses one fixed bootstrap protocol before the ordinary state
machine becomes available:

1. Authenticate against the pre-stack control Worker and verify the global
   administrator principal and wildcard grant.
2. Read D1 through the Cloudflare API and require the exact supported legacy
   schema and migration fingerprint. Reject unknown, partially expanded or
   divergent databases.
3. Atomically apply the one fixed bootstrap-ledger migration and acquire its
   claim. The same D1 batch creates the bootstrap table when absent and
   conditionally inserts the target deployment identities, legacy fingerprint,
   attempt ID and expiry. A concurrent command either owns that row or observes
   it.
4. Apply only the manifest's remaining fixed bootstrap migrations: the complete
   deployment ledger, checksum baseline, additive cache schema and compatibility
   triggers.
5. Seed the ledger with the manifest's explicit legacy source state and its
   running `bootstrap-legacy-runtime` transition.
6. Upload and deploy the foundation tenant Worker, then the foundation control
   Worker.
7. Let the new control Worker observe the D1 state, both artifact mappings, its
   own embedded manifest and stage, and the tenant Worker's manifest and stage
   through the service binding.
8. Adopt and complete the bootstrap transition through `deploymentAdvance`.
9. Continue through the ordinary manifest API.

Every bootstrap write uses the same attempt ID and conditional state checks. A
second CLI invocation resumes the existing claim or reports its active owner. If
the first invocation exits after creating the ledger, applying some additive
migrations or deploying one Worker, the next invocation observes those effects
and continues. It does not reapply SQL or create another initial state.

Only the exact declared legacy fingerprint may enter bootstrap. A database with
the deployment ledger but no completed foundation transition is an interrupted
upgrade, not a fresh installation.

The bootstrap executor accepts no migration list from the command line. It loads
the sole bootstrap transition whose source fingerprint matches the observed
legacy state, then applies its exact migrations and target stage. This keeps the
first upgrade declarative even though the old Worker cannot host the advance
API.

### Adjacent compatibility

The manifest validator simulates the complete sequence. It proves:

- the deployed stage supports D1 before and after every SQL transition performed
  while it remains live;
- the incoming stage supports the existing D1 state before upload;
- tenant-first deployment supports both `old control -> new tenant` and
  `new control -> old tenant`;
- stage two supports D1 before and after contraction;
- each declared rollback runtime supports the storage state to which it may
  return;
- old queue wake-ups remain valid against the new consumer;
- stage two and stage three can initialise every supported old local watermark
  directly.

The D1 runner applies only the exact migrations declared by the current
transition. The DO migrator applies only the registered stage ceiling. Neither
may apply every pending migration automatically.

## Migration ledgers and execution

### State

Use a general D1 deployment ledger and per-tenant migration rows:

```ts
type DataMigrationStatus =
  'pending' | 'running' | 'complete' | 'not-applicable' | 'failed';

type TenantDataMigration = {
  deployment: DeploymentIdentity;
  migration: DataMigrationId;
  implementationRevision: DataMigrationRevision;
  tenant: TenantId;
  status: DataMigrationStatus;
  attempts: number;
  claimId: MigrationClaimId | null;
  claimRevision: MigrationClaimRevision;
  claimExpiresAt: IsoTimestamp | null;
  nextAttemptAt: IsoTimestamp | null;
  startedAt: IsoTimestamp | null;
  completedAt: IsoTimestamp | null;
  lastFailure: StoredMigrationFailure | null;
};

type GlobalDataMigration = {
  deployment: DeploymentIdentity;
  migration: DataMigrationId;
  status: 'pending' | 'running' | 'complete' | 'failed';
  cohortCreatedAt: IsoTimestamp;
  cohortHighWater: TenantRegistryRevision;
  scanHighWater: MigrationScanHighWater | null;
  claimId: MigrationClaimId | null;
  claimRevision: MigrationClaimRevision;
  claimExpiresAt: IsoTimestamp | null;
  fleetCompletionRevision: DeploymentRevision | null;
  completedAt: IsoTimestamp | null;
  lastFailure: StoredMigrationFailure | null;
};

type LocalContractPhase =
  | 'pending'
  | 'bookmark-recorded'
  | 'contracting'
  | 'restoration-scheduled'
  | 'restored-awaiting-verification'
  | 'complete'
  | 'terminal-failure';

type LocalContractMigration = {
  deployment: DeploymentIdentity;
  tenant: TenantId;
  phase: LocalContractPhase;
  admission: 'closed' | 'open';
  admissionRevision: TenantLocalAdmissionRevision;
  preContractBookmark: DurableObjectBookmark | null;
  restoreUndoBookmark: DurableObjectBookmark | null;
  claimId: MigrationClaimId | null;
  claimRevision: MigrationClaimRevision;
  updatedAt: IsoTimestamp;
  lastFailure: StoredMigrationFailure | null;
};
```

Store bounded typed failures. Never use exception messages as program logic.

Represent retryable work as `pending` with `nextAttemptAt`. A worker moves it to
`running` only after atomically claiming the row. There is no separate
`retrying` status. The claim ID and revision passed to `advanceTenantDeployment`
must match this row.

Keep global execution state separate from per-tenant results. Create global
entries for:

- cache catalogue reconciliation;
- generation-bearing R2 objects;
- cache retention properties;
- local storage contraction.

The global row owns the fixed cohort, scan high-water, execution claim and
transactional fleet-completion revision. Local cursors are implementation
details, not proof of fleet completion.

### Capability-limited migration context

The data-migration registry does not pass a raw D1 database, Durable Object
storage handle, R2 binding or Worker environment to a handler. It creates a
capability-limited context from the descriptor:

```ts
type DataMigrationBudget = {
  maximumStatements: number;
  maximumRowsReturned: number;
  maximumReportedD1RowsRead: number;
  maximumRowsWritten: number;
  maximumParametersPerStatement: number;
  maximumR2Operations: number;
  maximumR2BytesRead: number;
  maximumR2BytesWritten: number;
};

type DataMigrationContext = {
  d1: BudgetedMigrationDatabase;
  durableObject: BudgetedMigrationDatabase;
  r2: BudgetedMigrationObjectStore;
  progress: MigrationProgressStore;
  budget: Readonly<DataMigrationBudget>;
};

type RegisteredD1MigrationStatement = {
  id: MigrationStatementId;
  maximumParameters: number;
  maximumRowsReturned: number;
  maximumReportedRowsRead: number;
  maximumRowsWritten: number;
  access:
    | {
        kind: 'indexed-keyset';
        index: MigrationIndexId;
        key: MigrationKeysetId;
      }
    | {
        kind: 'checked-query-plan';
        plan: MigrationQueryPlanId;
      };
};
```

`maximumRowsReturned` bounds result materialisation. It does not claim to bound
the rows which the database examines. A result `LIMIT` is therefore insufficient
evidence of bounded database work.

Every registered statement declares a worst-case result and mutation bound and
uses either indexed keyset traversal or a reviewed query plan with a declared
work bound. Build and Worker tests verify the required index and query plan
against the production statement. Before execution, the wrapper reserves the
statement, result and mutation bounds from the invocation budget. After each D1
statement, it audits D1's reported `rows_read` against the statement and
invocation limits. Exceeding either limit produces a typed implementation
failure and prevents cursor advancement. Migration writes remain idempotent
because this audit can fail after D1 has applied a mutation.

Unbounded scans, updates and deletes are not valid migration statements.

The wrappers also reserve statements, parameters, R2 operations and R2 bytes
before each operation. An R2 write has a known body length. An R2 read first
uses bounded metadata to reserve the object's declared size, and rejects an
object which exceeds the remaining allowance. The parameter wrapper enforces
D1's production limit of 100 parameters per statement. A handler can checkpoint
and yield before the next bounded batch, but it cannot raise its own budget.

The registry constructs each capability from an allowlist of tables, statement
families, R2 key spaces and progress records declared for that migration. Data
migrations cannot execute arbitrary SQL, access an unrelated bucket prefix or
write deployment-control state. Budget exhaustion returns a typed implementation
failure and leaves the transition incomplete. The operator must deploy corrected
code through the successor-artifact recovery protocol; a caller cannot override
the budget through the advance API.

The executor accepts only the retryable and terminal error codes listed by the
descriptor. An undeclared code becomes a typed implementation failure and cannot
advance or reschedule the migration automatically.

`BudgetedMigrationDatabase` accepts only registered statement IDs with typed
parameters. It does not accept a SQL string. The statement registry is included
in the complete Worker bundle hash and validated against the descriptor's table,
operation allowlist and invocation budget at build time. Cursor advancement is
available only after the context verifies that the corresponding statement and
delta sequence completed within the reserved bounds.

Structural migration executors have the separate authority needed to apply the
exact SQL files named by an `apply-d1` transition. They do not expose that
authority to TypeScript data-migration handlers. Tests use the same wrappers so
the declared limits are executable constraints rather than documentation.

### Tenant cohort and completion

At migration start, materialise every active, suspended and offboarding tenant
into the migration cohort. Native tenant creation writes terminal `complete`
entries for every destination representation it creates.

Before committing a tenant result, reread its status transactionally:

- active, suspended and offboarding tenants must become `complete`;
- a tenant which became offboarded stops reconciliation;
- it becomes `not-applicable` only after all cache references and durable work
  have been removed;
- remaining offboarded residue is an invariant failure.

Global completion is one transactional absence proof. It must find:

- no eligible tenant without a ledger row;
- no pending, running or failed row, including a pending row whose retry time
  has not arrived;
- no offboarded tenant without a valid terminal result;
- no newly eligible tenant omitted from the cohort.

### Catalogue reconciliation

For every eligible tenant:

1. Apply local migrations through the additive ceiling.
2. Discover identities from every legacy cache-bearing table and work queue.
3. Include empty named caches which exist only in DO SQLite.
4. Resolve access and deletion from authoritative D1 lifecycle rows.
5. Treat `deleted_at = NULL` as explicitly live.
6. Create the native default identity for a fresh local database.
7. Project DO-owned identities into D1.
8. Validate generations, credentials, references and row counts.
9. Refuse an unexplained live D1 lifecycle absent from the DO.
10. Mark completion only when both stores agree.

The D1 backfill must cover active, suspended and offboarding tenants
consistently. Offboarded tenants must have no retained cache references before
contraction.

### Writer epoch and queues

Use one writer epoch for all three runtime stages. Stamp persistent work which
can outlive its request:

- uploads;
- commit sessions and reservations;
- attachments;
- verification;
- deletion;
- reconciliation.

Compatibility triggers or defaults assign the legacy epoch to pre-stack writes.
New code writes the current epoch explicitly.

The drain gate requires:

- the foundation tenant and control versions are deployed at 100%;
- the maximum old token, WebSocket and upload lifetime has elapsed since
  cutover, including clock tolerance;
- no earlier-epoch D1 work remains;
- every relevant DO reports no earlier-epoch work or session;
- adopted work has been converted durably before receiving the current epoch.

Do not inspect queue contents or approximate queue metrics.

### D1 mutation admission and contraction fence

Separate ordinary application mutations from deployment-control mutations. Store
one application-mutation fence with a monotonically increasing revision and an
`open | closed` state. Every ordinary operation which can mutate D1 captures the
open revision during admission and verifies that revision in the same D1
transaction or conditional statement which performs the mutation. Merely
checking the fence before the write is not sufficient.

Deployment ledgers, migration checksums, recovery envelopes and the exact
structural migrations claimed by the current transition remain writable while
the application fence is closed. They use separate tables and narrowly typed
deployment procedures. Application handlers cannot obtain that authority, and
deployment-control writes cannot mutate ordinary product rows except through a
declared repair operation.

Persistent work carries its admitted fence revision. Closing the fence:

1. atomically increments the revision and changes the state to `closed`;
2. rejects new mutation admission;
3. waits for operations admitted under the previous revision;
4. proves that no previous-revision persistent work remains;
5. resolves or rolls back every quarantined cross-store mutation;
6. proves that no repair intent remains;
7. applies the declared contraction while the fence remains closed.

Cross-store operations write a durable repair intent before the first side
effect. If a DO mutation succeeds but its conditional D1 projection loses the
fence race, the operation remains quarantined and invisible through D1. The
stage-two runtime records a typed `projection-fenced` repair state. While the
expanded schema still exists, the deployment repair executor either completes
the native projection or rolls back the local effect. Both paths are idempotent
and generation-fenced.

No quarantined intent may survive contraction. An unresolved or failed intent
blocks the contract transition and requires operator action. The final runtime
therefore does not need to interpret pre-contract repair state, and the plan
does not depend on reconciling a legacy representation after removing it.

## Deployment sequence and recovery

### Upgrade sequence

`cupboard deploy` performs these transitions:

1. Validate the artifact, manifest, checksums, Cloudflare authority and Cupboard
   administrator authority.
2. Classify the database as a fresh installation, an exact supported legacy
   deployment or an interrupted manifest deployment. Reject every other state.
3. For an exact legacy deployment, run or resume the fixed direct-upgrade
   bootstrap until the foundation transition is adopted by the new control
   Worker.
4. For an existing manifest deployment, read the current durable state through
   `deploymentStatus`.
5. Preview every remaining state, tenant count, failure and rollback boundary.
6. Record the cutover time and release writer epoch.
7. Claim, run and verify catalogue reconciliation to transactional fleet
   completion.
8. Claim and apply the exact compatible D1 constraints.
9. Claim and drain every earlier writer epoch.
10. Claim and deploy `cache-data-migrations`.
11. Claim a `set-deployment-fence` transition which closes retention
    administration while the old and new representations differ.
12. Claim, run and verify the generation-bearing R2 migration.
13. Claim, run and verify the retention migration.
14. Claim a second `set-deployment-fence` transition which reopens retention
    administration through the native representation.
15. Prove every application migration complete or validly not applicable.
16. Claim a `set-deployment-fence` transition which closes ordinary D1
    application writes, advances the fence revision and drains every
    previous-revision mutation.
17. Claim `resolve-repair-intents`, resolve or roll back every quarantined
    cross-store projection, then prove that none remains.
18. Claim a `record-recovery-point` transition which writes and verifies the D1
    Time Travel recovery envelope.
19. Claim and apply only the declared D1 contraction migrations.
20. Verify the contracted schema without changing deployment state.
21. Claim `close-r2-compatibility-window` while ordinary application writes
    remain fenced. This transition disables legacy R2 writes, disables legacy
    read fallback and makes legacy objects eligible for bounded deletion.
22. Claim a `set-deployment-fence` transition which reopens ordinary D1
    application writes.
23. Claim `set-tenant-local-contract-admission` and make the requirement active
    in the foundation and data-migration runtimes.
24. Claim and deploy `cache-storage-contract`, tenant Worker first and control
    Worker second.
25. Wake every relevant DO so its first-wake barrier captures PITR and applies
    local contracts.
26. Prove fleet-wide local contract completion.
27. Verify final D1, DO, R2, runtime and ledger state without mutating it.

A bounded command wait budget may end at any safe state. Rerunning resumes from
observed durable state.

### D1 recovery

[D1 Time Travel][cloudflare-d1-time-travel] is an immediate migration-failure
mechanism, not a long-lived rollback window.

During contraction, ordinary application mutations remain fenced. The deployment
controller continues to write its ledger and recovery state. If migration or
verification fails before the application fence is lifted, restore the recorded
bookmark and return to stage two.

The authoritative recovery record lives outside the database being restored. Use
this record for each active D1 recovery transition:

```ts
type D1RecoveryEnvelope = {
  databaseId: CloudflareD1DatabaseId;
  deployment: DeploymentIdentity;
  transitionId: DeploymentTransitionId;
  attemptId: DeploymentAttemptId;
  expectedDeploymentRevision: DeploymentRevision;
  closedApplicationFenceRevision: D1MutationFenceRevision;
  preContractSchemaFingerprint: D1SchemaFingerprint;
  phase:
    | 'recorded'
    | 'restore-requested'
    | 'restored-awaiting-verification'
    | 'complete';
  preContractBookmark: D1Bookmark;
  restoreUndoBookmark: D1Bookmark | null;
  checksum: RecoveryEnvelopeChecksum;
  updatedAt: IsoTimestamp;
};
```

Store these envelopes in a dedicated control-plane R2 bucket. The tenant Worker
has no binding to this bucket, and cache storage, migration, retention and
garbage-collection code cannot address it. Use this key:

```text
d1/<databaseId>/<artifactId>/<instanceId>/<transitionId>/<attemptId>.json
```

The complete key lets recovery envelopes from separate deployments and attempts
coexist. Updates use conditional object versions. The checksum covers every
field except itself. The D1 ledger may mirror the envelope for queries, but a
Time Travel restore cannot erase the only copy. The control Worker's upload
descriptor and resolved topology must contain the recovery-bucket binding and
resource identity.

The `record-recovery-point` transition writes the envelope, reads it back,
verifies its checksum and only then marks the state fact as recorded. A restore
updates the external envelope to `restore-requested`. It stores the undo
bookmark returned by the restore operation before the controller adopts the
restored D1 state. Recovery then verifies the database fingerprint and advances
the envelope through `restored-awaiting-verification` to `complete`. A restart
uses the envelope and observed database state to resume the same recovery edge.
Retain a completed envelope until the Time Travel bookmark has expired and the
manifest has crossed its forward-only boundary. Only deployment maintenance may
then delete it.

After writes resume against contracted D1, restoring the bookmark would lose
later data. Recovery is then forward-only unless a separate data-preserving
reverse migration exists. This release does not claim such a reverse migration.

[cloudflare-d1-time-travel]:
  https://developers.cloudflare.com/d1/reference/time-travel/

### Durable Object PITR

The design uses the SQLite-backed Durable Object [PITR API][cloudflare-do-pitr].
On a stage-three first wake:

1. Enter the migration critical section before any local write or event
   admission.
2. Check whether a pre-contract bookmark is already recorded.
3. If absent, obtain it and persist it outside the DO in D1 with a
   tenant/deployment CAS.
4. Read it back and verify it.
5. Apply and verify local contracts.
6. Record local completion and open the tenant admission revision atomically.
7. Admit the waiting event.

A retry never replaces the pre-contract bookmark with a post-contract bookmark.

Persist every phase transition in `LocalContractMigration`. The normal path is
`pending -> bookmark-recorded -> contracting -> complete`. Recovery uses
`restoration-scheduled -> restored-awaiting-verification -> pending` or a
terminal failure. Store the pre-contract bookmark before contraction and the
undo bookmark returned by `onNextSessionRestoreBookmark()` before aborting the
current object.

If contraction fails before event admission, schedule restoration for the next
DO session, persist the returned restoration/undo bookmark externally, abort the
current object and verify the restored watermark on restart. A restarted object
in `restored-awaiting-verification` must verify the requested restoration before
it can retry contraction; it cannot interpret the restart as an ordinary
first-wake migration.

Once any post-contract event is admitted, PITR restoration would lose later
pushes, roots and maintenance work. Recovery becomes forward-only. The runbook
must report this boundary and the bookmark-expiry deadline.

Use an injected PITR implementation locally and a disposable production-backed
canary to test the real API.

[cloudflare-do-pitr]:
  https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/

### Per-tenant admission during local contraction

Reopening the global D1 application fence does not imply that every tenant DO
has applied the local contract. Once `cache-storage-contract` is the deployed
stage, an operation which can mutate both D1 and one tenant DO must obtain a
tenant-local admission before its first product write.

The manifest enables this requirement before uploading either stage-three
Worker. Foundation and stage-two tenant and control runtimes already implement
the check. A direct tenant write also checks the requirement before changing
local or R2 state. If the tenant Worker has not yet reached stage three, it
cannot satisfy the contract request, so the operation returns a typed retryable
error without writing product state. Deploying the tenant Worker first then
makes the barrier available before the control Worker changes. This rule keeps
both mixed script pairs fail closed.

The control path uses this sequence:

1. Read `LocalContractMigration` for the tenant.
2. If the phase is not `complete`, call the tenant DO through its service
   binding. The DO runs the first-wake migration barrier, records the bookmark,
   applies the contract and returns only after D1 records `complete`.
3. Capture the open tenant admission revision.
4. Perform the product D1 mutation with a conditional check that the phase is
   still `complete`, admission remains open and the revision is unchanged.
5. Pass the same admission revision to any following DO operation or durable
   work record.

A DO-first operation enters the same initialisation barrier before it can
contact D1. Pure D1 operations which cannot create later tenant-local work do
not need this admission. Queue consumers, alarms, service-binding calls and
WebSocket resumptions follow the same rule as foreground requests.

Scheduling local PITR restoration atomically closes tenant admission and
increments its revision before changing the phase. Recovery waits for work
admitted under the previous revision, then schedules the restore. While the
phase is `contracting`, `restoration-scheduled` or
`restored-awaiting-verification`, new cross-store operations return a typed
retryable migration error. Other tenants continue normally.

If a DO write succeeds but the following D1 condition loses the tenant-admission
race, the generation-bound repair protocol quarantines and resolves that work
before restoration or another local contract attempt. This is the per-tenant
equivalent of the global D1 fence. It prevents a D1-first request from changing
tenant state while the DO captures a bookmark, contracts or restores.

Tenant-local admission remains permanently required in the terminal deployment
state. This is deliberate: later releases can add another local migration and
reuse the same per-tenant barrier. A tenant whose phase is complete passes the
normal admission check without entering a migration path. No final transition
returns `tenantLocalContractAdmission` to `not-required`, and manifest
validation rejects a terminal state which does so.

### Rollback states

The preview reports the exact permitted target:

- Before writer drainage completes: the pre-stack Worker remains a valid
  rollback target.
- After drainage and before D1 contraction: rollback may use
  `cache-migration-foundation` while copied and legacy representations remain
  available.
- During fenced D1 contraction: immediate Time Travel restoration may return to
  stage two.
- After contracted D1 resumes writes but before `close-r2-compatibility-window`:
  stage two remains compatible. Returning to the foundation stage may also
  require a logical D1 reverse migration.
- Completion of `close-r2-compatibility-window` is an irreversible native-only
  boundary. Legacy deletion may begin immediately. The foundation stage is no
  longer a rollback target even if maintenance has not yet removed an object.
- After compatibility closure: recover with the native-only stage-two runtime, a
  compatible successor artifact or forward repair. No recovery edge may
  re-enable legacy writes or fallback.
- During a DO's local contraction and before event admission: PITR may restore
  that object.
- After a post-contract event: use the final runtime and forward-repair tooling.
- At any failed transition, a corrected artifact may take over only through an
  exact successor-adoption edge which supports the observed storage state.

Worker rollback never implies D1, DO or R2 rollback.

## Cache incarnation and read safety

### Model

```ts
type CacheManagement =
  | { kind: 'durable' }
  | {
      kind: 'managed';
      policyId: ManagedPolicyId;
      policyRevision: ManagedPolicyRevisionId;
      groupId: ManagedCacheGroupId;
    };

type CacheLifecycleState = 'creating' | 'active' | 'retiring' | 'deleted';

type CacheLifecycle = {
  scope: CacheScope;
  generation: CacheGeneration;
  readRevision: CacheReadRevision;
  state: CacheLifecycleState;
  access: CacheAccess;
  management: CacheManagement;
  creationExpiresAt: IsoTimestamp | null;
  leaseExpiresAt: IsoTimestamp | null;
};
```

Database checks enforce:

- default scope has a null name;
- named scope has a valid `CacheName`;
- access is exactly `public | private`;
- creating requires a creation deadline and has no activity lease;
- active managed caches require an activity lease;
- durable caches never have an activity lease;
- active, retiring and deleted caches have no creation deadline;
- deleted caches have neither deadline;
- durable rows have no policy, revision or group;
- managed rows have all three;
- D1 and DO management values agree before writes.

Creating, active and retiring are per-cache states. Groups have no cache
lifecycle. A creating cache is invisible to reads and reuse views but consumes
capacity.

### Creation and recovery

1. Reserve capacity and the next generation atomically in D1.
2. Insert `creating` with a fixed 15-minute deadline.
3. Create or reconcile the exact generation in the DO.
4. Activate only when scope, generation, management and policy revision still
   agree.
5. Set the provisional activity lease at activation.
6. Make every operation idempotent.

Repeated provisioning resumes creation without extending its deadline.

Expired recovery activates a managed cache only while its policy revision
remains active. Otherwise it cancels the reservation or moves existing local
residue into generation-scoped retirement. Conflicting state produces a typed
invariant failure.

### Reads and edge cache

Every read resolves an exact active lifecycle:

- `nix-cache-info`;
- narinfo;
- availability;
- direct NAR;
- attestation metadata.

Workers Cache keys include tenant, cache scope, generation and read revision. An
access transition increments read revision. Recreation increments generation.
Purging remains an optimisation.

For a direct cache URL, the requested NAR hash must have a current-generation
reference from that exact cache. For a reuse-view URL, at least one cache chosen
by the view's bounded selector and same-access predicate must have that
current-generation reference. An active lifecycle, a tenant-wide reference or a
canonical R2 object does not grant NAR authority by itself. Reuse-view narinfo
and NAR lookup compile the same selector and source predicate.

### Generation-bearing R2 migration

Use generation-bearing keys for narinfo, attestation lists and all cache-local
mutable metadata. Shared content-addressed NAR bytes remain canonical.

Foundation-stage writers start writing generation-bearing metadata immediately.
They also maintain the legacy copy for rollback. Stage two retains the same
dual-write rule until the manifest closes the legacy R2 window.

Every mutation records its latest operation in a compacted delta table keyed by
tenant, cache scope, generation, object kind and object identity. Repeated
writes to one object replace its delta row, so journal growth follows the number
of currently changed object identities rather than the number of mutations.
Cache and tenant storage quotas bound that cardinality. A write which cannot
record its delta returns typed migration backpressure before changing R2.

The migrator:

1. Captures a scan high-water mark.
2. Enumerates authoritative cache-local rows.
3. Re-renders narinfo from authoritative fields.
4. Parses legacy bytes only when necessary and compares every authoritative
   field.
5. Writes new objects conditionally.
6. Rejects divergent existing destination objects.
7. Verifies bytes and metadata.
8. Rebuilds attestation lists from current references.
9. Replays the compacted durable delta table.
10. Revalidates lifecycle generation and mutation sequence before completion.
11. Records local progress and the global tenant result.
12. Retains legacy objects until the final rollback boundary closes.

After verifying one object at a sequence, the runner deletes its compacted delta
row conditionally on the sequence remaining unchanged. A concurrent mutation
therefore leaves a newer row for the next pass.

Reads prefer the new key. Legacy fallback exists only in the migration adapter
while that tenant remains incomplete and authoritative rows prove ownership. An
R2 hit alone grants no authority.

Teardown carries scope and generation. It deletes only that generation's objects
and references. It rechecks shared NAR references immediately before deletion.

The manifest tracks three independent compatibility facts:

- legacy writes remain enabled while rollback to a generation-free writer is
  supported;
- legacy read fallback remains enabled while any tenant may still need an old
  key;
- legacy deletion remains forbidden until both earlier facts are disabled and
  every R2 migration is complete.

The `close-r2-compatibility-window` transition changes all three facts in one
declared operation. Its checks require native writes from every active runtime,
fleet-wide R2 completion, no legacy-only delta, a closed and drained application
fence, and a rollback state which no longer permits a generation-free writer. It
then disables legacy writes, disables fallback and marks legacy objects eligible
for bounded maintenance. Foundation and stage-two request admission reads this
deployment-state revision before choosing its R2 representation, so new work
cannot retain the old behaviour after the fence reopens. A `verify` transition
cannot make any of those changes. Stage three consumes the resulting native-only
state but does not implicitly create it.

## Retention

### Types and resolution

```ts
type CacheRootRetention =
  { kind: 'permanent' } | { kind: 'duration'; seconds: PositiveSeconds };

type RootRetentionRequest =
  | { kind: 'inherit' }
  | { kind: 'permanent' }
  | { kind: 'duration'; seconds: PositiveSeconds };
```

Resolution is:

1. Explicit `permanent` or `duration` wins.
2. `inherit` consults the longest matching prefix rule.
3. If no rule matches, use the mandatory cache default.

Prefix rules contain only `permanent | duration`. Existing roots retain their
stored deadlines when cache properties change. A later refresh resolves the
current configuration again.

Manual durable caches default to permanent retention and no grace unless the
administrator specifies otherwise. Managed defaults are policy-controlled.

CLI behaviour:

- omission means `inherit`;
- `--ttl <duration>` means explicit duration;
- `--permanent` means explicit permanence;
- supplying both is a typed usage error;
- presets which promise permanence send it explicitly.

### Immutable rule sets

A cache references one immutable rule set.

Canonicalisation:

- validates every prefix against the root-name-prefix type;
- rejects duplicate prefixes;
- sorts prefixes by UTF-8 byte order;
- includes the complete discriminated retention value in structural identity;
- represents no overrides through one canonical empty set.

A content digest narrows candidate lookup. Full canonical structural comparison
decides equality.

Updates use transactional copy-on-write:

1. Load and verify the current canonical list.
2. Apply the requested mutation.
3. Find digest candidates.
4. Compare complete structures.
5. Insert a new set when necessary.
6. Atomically rebind the cache.
7. Garbage-collect unreferenced sets asynchronously.

Ordinary cache commands may edit durable caches only. Managed cache retention
changes require a new policy revision.

### Retention migration

The current cross-product migration must be replaced before implementation.

Stage one creates additive fields, rule-set tables, local cursor state and
compatibility adapters. Stage two fences retention administration for an
incomplete tenant, then migrates bounded batches.

Conversion rules:

- exact-cache policies become mandatory cache defaults;
- all existing live caches reference one canonical copy of the legacy prefix
  rules;
- future caches do not inherit the legacy tenant-wide set;
- each existing public cache receives effective grace from the longest matching
  legacy rule;
- private caches receive no grace unless legacy semantics explicitly require it;
- deleted, dangling and inert rows are handled explicitly;
- existing root deadlines, grace deadlines and sticky operational state remain
  unchanged;
- `CUPBOARD_COLD_PATH_TTL_SECONDS` is not reinterpreted as a cache default.

A tenant completes only after its cursor reaches the high-water mark, no
configuration delta remains and the new representation passes structural checks.

## Managed ephemeral caches

### Policy families, revisions and groups

Separate mutable policy state from immutable configuration:

```ts
type ManagedPolicyFamily = {
  id: ManagedPolicyId;
  ownerId: GitHubOwnerId;
  repositoryId: GitHubRepositoryId;
  cacheNamespace: ManagedCacheNamespace;
  status: 'active' | 'updating' | 'update-failed' | 'retiring';
  currentRevision: ManagedPolicyRevisionId;
  pendingRevision: ManagedPolicyRevisionId | null;
  updateCursor: ManagedPolicyUpdateCursor | null;
};

type ManagedPolicyRevision = {
  id: ManagedPolicyRevisionId;
  policyId: ManagedPolicyId;
  configuration: ManagedPolicyConfiguration;
};
```

Managed caches bind to one immutable revision.

A managed group has immutable access. Every member cache has that access. A
reuse view retains explicit access and must equal its group's access. Durable
caches cannot join a managed group.

Owner ID, repository ID and reserved namespace belong to the family and cannot
change between revisions. Existing cache identity and OIDC claim matching never
depend on mutable revision configuration.

Several repository policies may share a group. Each group owns exactly one
canonical stable reuse view, and that view is the only interface which may
select the group directly. Other reuse views can select ordinary cache scopes,
but cannot acquire managed-group membership indirectly. Candidate lookup is
indexed and bounded by group, access, active lifecycle and selection state.

Use a persisted fail-closed transfer state for a group access change:

```ts
type ManagedCacheGroupTransferState =
  'source-active' | 'detached' | 'reconciling' | 'target-active';

type ManagedCacheGroupTransfer = {
  operationId: ManagedGroupAccessUpdateId;
  scope: CacheScope;
  generation: CacheGeneration;
  sourceGroup: ManagedCacheGroupId;
  targetGroup: ManagedCacheGroupId;
  targetAccess: CacheAccess;
  targetReadRevision: CacheReadRevision;
  leaseExpiresAt: IsoTimestamp;
  state: ManagedCacheGroupTransferState;
};
```

This record is separate from `CacheManagement`. It represents the temporary
cross-store operation without allowing one lifecycle row to claim membership of
two groups. Managed-group selectors exclude a cache whenever its transfer state
is `detached` or `reconciling`.

The coordinator must persist the source group, successor group, bounded policy
cohort and current phase before it changes a cache or policy. The maximum of 20
member policies permits the policy cohort to remain in the coordinator row.
Cache work belongs in a separate table keyed by transition, cache scope and
generation. The coordinator captures those rows with indexed keyset pagination
and retains a durable cursor. It must not serialise the complete cache worklist
into one D1 value or load the complete worklist into memory.

Each maintenance invocation performs one bounded phase: cancel one creating
cache, prepare one policy revision, capture one cache page, move one cache
batch, switch the view, release one hold page, or activate the prepared policy
cohort. Every phase transition uses compare-and-set state. The statement and
parameter budgets include the queries which select work and verify ambiguous
results, not only the final batch. A supported group with 20 policies and the
maximum cache population must therefore make progress without exceeding a D1
request or row-size limit.

An access change is one group-wide operation:

1. Create the coordinator and a target group with the new access in one D1
   transaction. Mark the source and target groups as transitioning so no policy
   can join either group.
2. Cancel or finish each cache in `creating` through a persisted, bounded
   coordinator phase. No creation cleanup may occur before the coordinator
   exists.
3. Create a successor revision for each policy in the frozen source-group cohort
   through bounded, checkpointed operations.
4. Keep provisioning, publication, root extension and lease renewal fenced for
   every member policy from the transaction which marks the source group as
   transitioning.
5. Refuse to start while a cache is already retiring. The caller can retry after
   retirement drains. Do not capture the worklist while a creating or retiring
   cache remains.
6. Capture one stable, paged worklist containing every active member cache, its
   generation and its unchanged lease deadline. Place an update hold on each
   captured entry in the same bounded transaction so automatic retirement cannot
   remove it during transfer.
7. Mark one cache `detached` in D1. Group selectors exclude it immediately. For
   public-to-private, set D1 access to private before changing the DO. For
   private-to-public, retain private D1 access until the DO change is complete.
8. Reconcile the DO's access, group and read revision, then record its
   generation-bound acknowledgement. A failure leaves the cache detached and
   resumable, so it cannot appear in either group.
9. Activate the cache in the target group only after the acknowledgement still
   matches the D1 generation. Set the target access at this point for a
   private-to-public transition.
10. After every cache is `target-active`, update the group's one stable view in
    one tenant-DO transaction and record its generation-bound acknowledgement in
    D1. A public-to-private update makes the view private before selecting the
    target group. A private-to-public update selects only the already-public
    target group before making the view public.
11. Activate every successor policy revision only after D1, every DO, every
    cache and the view agree.
12. Release the update holds without changing any lease deadline. Normal
    retirement eligibility is evaluated again, so an already expired cache may
    retire immediately after the transition.
13. Retain the old group's immutable access while historical policy revisions or
    caches still refer to it. Remove it only after no policy revision, cache or
    view references it.

No step assumes an atomic transaction across D1 and Durable Object SQLite. A
cache in `detached` or `reconciling` remains available for exact direct reads
under the more restrictive of the source and target access values, but it is
absent from managed-group reuse. The transition may therefore cause temporary
reuse misses, never temporary access widening.

One member policy cannot change access independently while it shares a group. It
must participate in the group-wide transition. This preserves the intended
tenant-wide pull-request view.

Ordinary `cache set-access`, priority and retention commands reject managed
caches.

### Policy configuration and defaults

A GitHub pull-request policy family defines immutable owner and repository IDs
and a non-overlapping literal cache namespace. Each policy revision defines:

- managed group;
- access;
- priority;
- mandatory default root retention;
- maximum root duration;
- whether permanence is allowed;
- grace;
- creation, provisional and activity lease durations;
- maximum live cache count.

Defaults:

- priority: 40;
- default root duration: 14 days;
- maximum root duration: 14 days;
- permanence: disallowed;
- grace: none;
- creation deadline: 15 minutes;
- provisional lease: 1 hour;
- activity lease: 24 hours;
- capacity: 100 caches per policy.

Access is required.

Policy activation validates defaults and every prefix override against the
maximum duration and permanence permission. Explicit and inherited root
retention are checked again when a root is written.

A permanent managed root prevents automatic cache retirement. If permanence is
enabled, capacity may require operator action. Policy retirement also waits for
explicit removal of permanent roots; it never silently shortens accepted
permanence.

### Namespaces and provisioning

Provisioning prepares the exact cache which a managed publication policy allows.
The operation creates the cache when necessary, resumes an incomplete creation,
or returns the existing cache after verifying its policy identity. It is not a
general cache-creation operation, and the publisher cannot use it to choose the
cache's access, retention or lifecycle properties.

The default namespace includes immutable repository ID. Cache names use the
server-defined namespace plus pull-request number.

Reject policy creation when:

- its literal prefix overlaps another reserved namespace;
- an existing durable cache occupies that namespace;
- the prefix cannot produce valid cache names.

Do not adopt existing durable caches automatically. The administrator must move
or delete them first. Keep a retiring policy's namespace reserved until all
managed caches drain.

OIDC trust grants `cache:provision` for a managed policy. The server selects the
policy from verified issuer and repository claims. It never trusts a
caller-supplied policy ID.

The GitHub workflow provisions the cache automatically before upload
negotiation. A user does not need to create each pull-request cache. Ordinary
push never provisions a missing cache.

Provisioning:

- accepts no cache properties;
- derives the exact name;
- reserves one policy capacity slot transactionally;
- creates from the active revision;
- succeeds idempotently for the same cache and revision;
- conflicts with durable or foreign-policy caches;
- sets the creation deadline once;
- never renews a lease.

Capacity counts creating, active and retiring caches. Retiring caches release
their slot only after final deletion.

```ts
type ManagedCacheCapacityFailure =
  | { kind: 'temporarily-full'; retryAt: IsoTimestamp }
  | { kind: 'operator-action-required' };
```

Use `temporarily-full` only when the server can derive a useful retry time.
Permanent roots and invariant failures require operator action.

Provisioning may mark a bounded number of eligible caches as retiring. It never
drains them synchronously.

### Lease transitions

Activation sets the provisional lease.

A successful non-empty publication commit renews the activity lease even when
its blobs or cache references were already present. This covers deduplicated and
grace-mode runs.

A successful root create, replacement or refresh renews the lease, including an
unchanged target set when the operation revalidates retention.

Provisioning, negotiation, upload creation, reads, empty commits and failed
publication do not renew it.

A commit session accepted before lease expiry may finish within its captured
deadline. Finalisation atomically checks that the cache remains active and the
policy remains active. If it succeeds before retirement wins, it renews the
lease. If retirement wins first, finalisation fails with a typed retiring-cache
error.

Updating, update-failed and retiring policies do not renew leases. Work accepted
before their fence may finish only within captured deadlines and does not renew.

Lease expiry alone does not fence the cache. It makes the cache eligible. A
concurrent successful commit or root refresh either renews before the retirement
CAS or observes the retiring state.

### Policy updates

A policy update:

1. Writes an immutable pending revision.
2. Resolves creating and retiring caches, then records a stable worklist and
   cursor.
3. Marks the family `updating`.
4. Fences provisioning, new publication, root creation and root extension.
5. Allows reads using each cache's current access.
6. Allows previously accepted work to finish within its deadline without
   renewal.
7. Places update holds on the worklist and reconciles caches in bounded batches.
8. Records the first-mutated boundary.
9. Activates only after D1, DO, group and view state agree.

A crash leaves an expiring update claim. Another runner resumes the same cursor.
An invariant failure records `update-failed` with a typed failure.

Cancellation is allowed only before the first cache mutation. Afterwards
recovery is forward-only: retry the revision or retire the policy. Mixed
revisions are never declared active.

Non-access updates may change priority, retention, grace, leases and capacity.
Existing root, grace and activity-lease deadlines remain unchanged. Automatic
retirement skips caches on an unfinished worklist. The update releases those
holds only after activation or after an allowed pre-mutation cancellation. An
`update-failed` operation retains its holds until an administrator retries the
same revision or retires the policy through a forward recovery path. Access
changes use the successor-group transition above.

### Retirement

Automatic cache retirement requires:

- expired activity lease;
- no root or root target;
- no permanent root;
- no grace-protected path;
- no cache-local narinfo;
- no upload, commit, attachment or verification work;
- no reconciliation or foreground deletion work.

Ordinary root expiry and cache-local collection remove retained references while
the cache remains active. When the predicate becomes true, one transaction
changes the cache to retiring and fences writes. Generation-scoped teardown then
removes residual operational state and releases capacity.

Policy retirement:

1. Resolves an unfinished update worklist. It may cancel the update before its
   first mutation; otherwise it completes the group transfer or non-access
   reconciliation before retirement continues.
2. Fences provisioning and new publication.
3. Fences root creation and extension.
4. Stops lease renewal.
5. Allows captured work to finish within its deadline.
6. Preserves accepted root, grace and activity-lease deadlines.
7. Waits for timed retention and grace to expire.
8. Reports permanent roots as operator blockers.
9. Retires eligible caches asynchronously.
10. Keeps namespace and group reservations until every cache drains.

Retirement cannot remove a cache from an unfinished update worklist or clear an
update hold. The policy first reaches one coherent revision and group state,
then evaluates retirement from the lease deadlines which the update preserved.

Managed caches cannot be deleted or mutated through ordinary cache
administration. Administrators use the typed policy-retirement operation. This
implementation adds no force-delete path.

No webhook or pull-request-close Action is required. A future close Action may
shorten an activity lease, but correctness cannot depend on it.

## GitHub, credentials and terminology

`cupboard github setup` creates or reconciles:

- the managed policy family and initial revision;
- its reserved namespace and homogeneous group;
- the group-backed reuse view;
- the OIDC provisioning and publication rules.

Initial support covers workflows whose verified `repository_id` matches the
configured repository. Fork workflows do not publish managed PR caches in this
release. Private fork publication would require a separate short-lived
read-authority design.

A private managed cache has no cache-specific verifier and uses the tenant
fallback credential.

Expose separate workflow inputs for:

- an optional destination-cache credential for durable destinations;
- the tenant fallback credential for private managed caches and private reuse
  views.

GitHub setup requires the operator to configure the fallback credential on the
tenant and store the matching values in the repository's Actions secrets for
private workflows. `github check` probes the destination and view with their
respective credentials. Setup does not print or recover stored secret material.

Represent cache-specific credentials as a duplicate-free list keyed by native
`CacheScope`, so one invocation can configure the default cache and named
caches.

Rename the complete internal Action chain:

- `cacheVisibility` to `cacheAccess`;
- `destinationVisibility` to `destinationAccess`;
- `destination-visibility` to `destination-access`.

Update documentation and help to:

- place access on caches and reuse views;
- call the tenant credential a fallback credential;
- state exact-cache direct NAR authority;
- state same-access reuse-view authority;
- prohibit credential userinfo in URLs;
- explain omission, duration and permanence correctly;
- remove active tenant read-mode and private-namespace terminology;
- retain legacy identifiers only where migration input is described;
- document every deployment state, recovery boundary and storage-specific
  limitation.

## Test and release acceptance

### Oldest-supported multi-stage fixture

Add one process-level fixture which upgrades the oldest supported populated
deployment through the complete declarative manifest. The fixture must exercise
the real bootstrap, transition runner, structural migration executor, Worker
stage changes and TypeScript fleet migrations. It must not replace those
boundaries with a scripted list of expected states.

Keep the fixture in three parts:

- `tests/fixtures/cache-deployment-predecessor/` contains the predecessor
  compatibility probe and its fixed expected state;
- `tests/support/staged-deployment-server.ts` owns the persistent Miniflare
  instance, stage changes, restart and fault injection;
- `tests/e2e/cache-deployment-upgrade.test.ts` drives the manifest and asserts
  the final deployment.

The predecessor fixture describes exactly the source state declared by the
manifest:

- D1 migration `0019_nar_read_authority.sql`;
- Durable Object migration `0041_pending_upload_recorded_verdict`;
- tenant and control Worker version tag `37bc799de0bc`;
- production script names, binding names and the `CupboardServer` class name.

The compatibility probe is not a copy of the old application. Its tenant Worker
supports only fixed, typed fixture operations which write the predecessor data
shape. Its control Worker exposes only the minimum health and service-binding
behaviour required to install and observe both scripts. Neither Worker accepts
SQL, a migration identifier, a handler name or another caller-selected
operation. The probe is test-only and must never enter a deployment artifact.

Use the retained immutable migration catalogues to create the predecessor D1 and
local SQLite schemas. Seed one fixed dataset which contains:

- active, suspended and offboarding tenants, plus an offboarded tenant whose
  references and work have drained;
- default, public named and private named caches;
- cache credentials and tenant-fallback read credentials;
- narinfo, blob and attestation references, including generation-free R2
  metadata;
- permanent and expiring roots, prefix retention rules and grace state;
- pending upload, commit, verification and deletion work stamped with the
  predecessor writer epoch.

The fixture must fail before deployment begins if its observed migration
history, Worker tags or durable schema differ from the manifest fingerprint.
After D1 expansion, but while the predecessor Worker remains active, perform one
late legacy write and prove that the compatibility representation records it.
After the foundation deployment, prove that the captured predecessor work drains
through durable authority rather than through a queued message payload.

Start Miniflare with separate temporary `d1Persist`, `durableObjectsPersist` and
`r2Persist` paths. Keep the D1 database ID, R2 bucket name, Worker script names,
Durable Object namespace and class name stable for the whole run. Build the
current tenant and control bundles once. A runtime transition calls
`Miniflare.setOptions()` with the exact bundle, upload-template settings,
deployment identity and `CUPBOARD_RUNTIME_STAGE` declared for that stage. Deploy
the tenant Worker before the control Worker and exercise the mixed pair between
those changes.

Drive the real deployment runner against the Miniflare control Worker. Its
external-action adapter may perform only the action returned by the claimed
manifest transition:

- apply the exact declared D1 migration files and verify their digests;
- install the exact registered runtime stage;
- record and verify the declared recovery point;
- run the registered data migration or check.

The adapter supplies Miniflare observations for Cloudflare Worker version IDs,
tags and traffic percentages. The control Worker must still verify its embedded
artifact and stage and probe the tenant Worker through the service binding.
Miniflare cannot prove Cloudflare's real deployment topology, so retain the
production topology smoke check.

Run one complete happy-path upgrade. In a second run, dispose and recreate
Miniflare from the same persistence paths after every completed manifest
transition. The resumed deployment must neither repeat completed work nor skip
incomplete work. Add lost-response failure injection after each category of
external side effect:

- D1 migration commit;
- tenant or control Worker replacement;
- tenant data-migration progress;
- recovery-point persistence;
- D1 or local contraction.

Use a canonical predecessor persistence snapshot for restart cases so the suite
builds bundles and seeds the large fixture once. Keep automatic maintenance
deadlines in the future and invoke the required maintenance wake explicitly.
Queue messages remain non-authoritative and need not survive a Miniflare
restart; the test must prove that the durable work record can be woken again.

The terminal assertion compares the complete relevant state:

- D1 deployment, migration, lifecycle, reference and admission rows;
- each tenant's local migration journal, cache identities, roots, retention
  properties and remaining work;
- generation-bearing R2 narinfo and attestation-list objects;
- removal or retention of legacy representations according to the closed
  compatibility window;
- zero missing, running, retrying or failed migration rows for the fixed cohort.

Use typed fixture builders and Miniflare configuration objects. Do not add type
casts to assemble the harness. Durable Object PITR and D1 Time Travel remain
injected locally because Miniflare cannot exercise the production recovery
services. The separate production PITR canary and deployment-topology smoke
check remain release requirements.

### Declarative deployment

Test:

- manifest and registry one-to-one validation;
- structural validation of every discriminated transition kind and target state;
- an explicit transition for every fence, recovery-point and compatibility state
  change;
- rejection of a `verify` transition which changes any state fact;
- separation of forward and recovery edges;
- legacy runtime fingerprints as source states without pretending they are
  registered stages;
- canonical `manifestId` changes for manifest data and stable canonical JSON;
- `artifactId` changes when either complete bundle changes, including a change
  made only in an imported migration helper;
- `artifactId` changes for compatibility settings, upload templates and the CLI
  deployment executor, but remains identical across installations with different
  resolved topology;
- `instanceId` changes when the resolved account or resource topology changes;
- persistence of Cloudflare-assigned version IDs only after upload and exact
  binding of those IDs to the deployment instance;
- rejection of undeclared handlers and checks;
- artifact and migration checksum drift;
- invalid, skipped, previous and foreign target states;
- strict rejection of extra endpoint fields;
- two deploy commands racing to claim one external action;
- external action resumption with the same attempt ID;
- control self-metadata, tenant service-binding metadata and Cloudflare topology
  disagreement;
- lost response after transition side effects;
- transition lease expiry and resumption;
- observed external actions instead of client-reported completion;
- exact D1 migration application rather than all pending files;
- exact legacy bootstrap and rejection of unknown legacy fingerprints;
- interruption after the bootstrap claim, ledger creation, additive SQL and each
  Worker deployment;
- fresh-install resumption after resource creation, schema application, each
  Worker upload and before administrator onboarding;
- topology identity remaining unset until every required resource exists,
  sealing exactly once and rejecting later resource drift;
- fresh claim creation against the exact empty D1 fingerprint after the process
  which created the database has exited;
- fresh-install challenge rotation by the same Cloudflare account authority and
  rejection for different resources or deployment identities;
- a failed deployment superseded by an artifact whose manifest accepts the exact
  predecessor state;
- a successor manifest accepting a compatible predecessor artifact while the
  preparation claim binds the exact predecessor deployment instance;
- racing successor-preparation claims and rejection of an undeclared
  predecessor;
- rejection of successor preparation while the predecessor claim remains active;
- terminal-failure and declared expired-claim successor recovery;
- observation and repair of an issued external action before successor adoption,
  with late predecessor callbacks and completion reports rejected;
- revalidation, rerun, compatible resume, checkpoint restart and invariant
  repair for predecessor migration results;
- `not-applicable` revalidation both when a tenant remains inapplicable and when
  it becomes eligible;
- rejection of successor adoption when a cursor or retained source
  representation is incompatible;
- every runtime stage from every supported old local watermark;
- a production-backed stage-three cutover with an existing hibernated commit
  WebSocket, proving that the first event enters the migration barrier;
- both mixed tenant/control version pairs;
- tenant-local admission enabled before the stage-three tenant upload and
  enforced by the stage-two control Worker;
- tenant-local admission remaining required in the terminal state and available
  to a later local migration;
- stage two against D1 before and after contraction;
- fresh installation versus existing partial-database recovery;
- unavailable operator authority before mutation;
- wildcard authority from a configurable rule rejected for a principal which is
  not the global administrator;
- enforced statement, row, parameter, R2-operation and byte budgets;
- reservation of each statement's worst-case returned-row and mutation bounds;
- indexed keyset or checked query-plan enforcement, rejection of a result limit
  as the only scan bound, and post-execution auditing of D1 `rows_read`;
- denial of raw database, storage, environment and unrelated R2-key access to a
  data-migration handler.

### Catalogue and writer drainage

Test:

- active, suspended and offboarding tenants;
- offboarding-to-offboarded during a claimed batch;
- offboarded residue rejection;
- dormant tenants with no initial ledger row;
- native tenant creation during migration;
- transactional fleet absence proof;
- old writes after additive expansion;
- credential orphans from old and new writers;
- stale and duplicated queue wake-ups;
- earlier-epoch records blocking contraction without queue inspection;
- token, WebSocket, upload and persistent-work drainage;
- D1 mutation admitted immediately before the fence revision advances;
- deployment-control ledger and checksum writes while ordinary application
  writes remain fenced;
- conditional D1 rejection after a successful DO write, followed by
  expanded-schema repair or local rollback before contraction;
- unresolved and failed repair intents blocking contraction;
- cross-store mutations blocked until the target tenant's local contract is
  complete;
- a D1-first operation racing bookmark capture, contraction and restoration;
- tenant-admission revision loss after a successful DO write, followed by
  generation-bound repair;
- one tenant's local contraction leaving unrelated tenants available;
- global and per-tenant claim revisions, delayed retries and fixed cohort
  completion.

Keep every D1 statement at or below the production 100-parameter limit.

### Incarnation and R2

Test:

- private deletion followed by public recreation with stale narinfo;
- stale availability;
- Workers Cache across access changes and recreation;
- old teardown after recreation and recommit;
- direct NAR rejection without an exact current-generation cache reference;
- reuse-view NAR authority from a current-generation reference in a selected
  same-access source cache;
- stale attestation-list deletion;
- incomplete and expired creation;
- policy status during creation recovery;
- legacy and generation-bearing keys together;
- authoritative narinfo re-rendering;
- divergent destination R2 objects;
- crash after object write but before progress;
- lifecycle change during migration;
- foundation-stage generation-bearing and legacy dual writes;
- repeated mutations compacting to one latest delta row;
- typed backpressure before an unjournalled R2 mutation;
- writes, updates and deletes on both sides of the scan cursor;
- GC and reaper activity during migration;
- legacy object retention through the rollback window;
- independent legacy-write, fallback and deletion-eligibility facts;
- the explicit compatibility transition stopping legacy writes and fallback
  before legacy deletion;
- rejection of compatibility closure while application writes or an admitted
  legacy writer remain active;
- foundation rollback before compatibility closure and rejection of that target
  after closure;
- native-only recovery after compatibility closure and after legacy deletion has
  started;
- rejection of a stage-three deployment before the compatibility window has
  closed.

### Retention

Test:

- inherit, duration and permanence at root, prefix and cache-default levels;
- longest-prefix selection;
- mandatory defaults;
- explicit and inherited managed-policy bounds;
- existing deadlines across configuration changes;
- duplicate prefixes and canonical order;
- deliberate digest collision followed by structural comparison;
- canonical empty set;
- copy-on-write and asynchronous set collection;
- a large legacy fixture without cache-by-rule multiplication;
- fenced policy administration during migration;
- cursor, high-water and crash recovery.

### Managed caches and GitHub

Test:

- fresh publication to the default repository-derived pull-request cache name;
- fresh `pr-1` publication under an explicitly configured `pr-` namespace;
- verified-claim policy selection;
- durable and foreign-policy conflicts;
- namespace overlap and durable-cache collision;
- repeated provisioning without deadline or lease extension;
- concurrent capacity reservation;
- creating and retiring caches consuming capacity;
- both capacity failure variants;
- exact lease renewal and non-renewal operations;
- finalisation racing retirement;
- permanent roots blocking retirement;
- private managed cache and private view using the fallback credential;
- same-repository enforcement and fork rejection;
- access-homogeneous groups;
- group-wide successor revisions and a complete successor-group access
  transition across several policies;
- creating and retiring cache resolution before a group worklist is fixed;
- `detached` and `reconciling` caches excluded from both managed groups;
- public-to-private and private-to-public transfer failures at every D1/DO
  boundary without access widening;
- exactly one stable managed-group view and one transaction which repoints it;
- unchanged lease deadlines and paused automatic retirement throughout an
  unfinished worklist;
- rejection of one policy's independent access update inside a shared group;
- policy update success, crash, failure, retry and retirement;
- temporary reuse misses without access widening;
- asynchronous retirement and capacity release.

### Recovery

Test:

- interruption after every deployment transition;
- D1 contraction failure while writes remain fenced;
- a D1 recovery envelope which remains available after the D1 ledger is
  restored;
- control-only recovery-bucket authority and coexistence of envelopes from
  several deployments, transitions and attempts;
- envelope checksum, conditional-update and expected-revision failures;
- persistence of the D1 restore undo bookmark before restored state is adopted;
- D1 writes after the fence is lifted, proving Time Travel is no longer offered
  as rollback;
- PITR crash before persistence;
- crash after persistence but before local contract;
- failure during local contract;
- crash after contract before completion;
- every persisted local-contract phase, including restoration scheduling and
  restored verification;
- persistence and use of both pre-contract and restore-undo bookmarks;
- no replacement of the pre-contract bookmark;
- a post-contract write proving later PITR restore is forbidden;
- production-backed PITR canary;
- runbook and preview agreement on every rollback target.

Before publishing the rewritten stack:

- validate every commit in a disposable worktree;
- run the relevant focused gates at each commit;
- run `pnpm check` at the final tip;
- run the persistence-backed oldest-supported populated fixture through the
  complete manifest, including restart after every transition and lost-response
  injection at each external side-effect boundary;
- rebase every branch onto the correct predecessor based on current
  `origin/main`;
- push the stack and verify every PR base, head and hosted check;
- do not deploy an intermediate stack commit.

The release is ready when one final artifact can stop and resume at every
declared state, every contraction rejects incomplete work, migration code
remains available, the production PITR canary passes, and the runbook describes
D1, DO and R2 recovery without implying that Worker rollback restores storage.

## Assumptions and chosen defaults

- The supported direct upgrade begins at the current production release before
  this stack.
- `cupboard.supply` is the only production deployment affected.
- The project remains pre-1.0, so removed CLI and Action vocabulary needs no
  compatibility alias.
- Administrator-created caches are durable.
- Manual named-cache creation requires explicit access.
- Durable cache retention defaults to permanent.
- Managed PR retention defaults to 14 days and disallows permanence.
- A permitted permanent managed root prevents automatic retirement.
- Managed capacity counts caches per policy, not bytes, paths or groups.
- Managed group access is immutable; an access change uses a successor group.
- Initial GitHub managed publication supports the configured repository, not
  forks.
- No webhook, pull-request-close Action or emergency managed-cache force
  deletion is included.
- PITR and Time Travel protect migration failures only while writes or event
  admission remain fenced. They are not normal post-deployment rollback
  mechanisms.
- Migration code introduced by this release remains until a later, explicit
  minimum-upgrade-version decision removes the corresponding supported fixture.
