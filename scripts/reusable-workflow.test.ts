import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const flakeWorkflow = new URL(
	'../.github/workflows/cupboard-flake-publish.yml',
	import.meta.url
);
const publishWorkflow = new URL(
	'../.github/workflows/cupboard-publish.yml',
	import.meta.url
);
const releaseCacheWorkflow = new URL(
	'../.github/workflows/release-cache.yml',
	import.meta.url
);
const cachePublishWorkflow = new URL(
	'../.github/workflows/cache-publish.yml',
	import.meta.url
);
const ciWorkflow = new URL('../.github/workflows/ci.yml', import.meta.url);
const prepareAction = new URL('../actions/prepare/action.yml', import.meta.url);
const prepareTransport = new URL(
	'../actions/prepare/ssh-transport.sh',
	import.meta.url
);
const legacyPublishCaller = new URL(
	'../tests/fixtures/github-actions/cupboard-publish-legacy-caller.yml',
	import.meta.url
);
const githubActionsDocumentation = new URL(
	'../docs/github-actions.md',
	import.meta.url
);
const releasesDocumentation = new URL('../docs/releases.md', import.meta.url);
const trustRulesDocumentation = new URL(
	'../docs/trust-rules.md',
	import.meta.url
);
const reuseViewsDocumentation = new URL(
	'../docs/reuse-views.md',
	import.meta.url
);
const remoteStoreDockerfile = new URL(
	'../tests/fixtures/nix-ssh-store/Dockerfile',
	import.meta.url
);

function actionSteps(lines: readonly string[], action: RegExp): string[][] {
	const steps: string[][] = [];

	for (const [index, line] of lines.entries()) {
		if (!action.test(line)) {
			continue;
		}

		const end = lines.findIndex(
			(candidate, candidateIndex) =>
				candidateIndex > index && candidate.startsWith('      - ')
		);
		steps.push(lines.slice(index, end === -1 ? undefined : end));
	}

	return steps;
}

function stepText(step: readonly string[] | undefined): string {
	return (step ?? []).map((line) => line.trim()).join(' ');
}

describe('reusable workflow action checkout isolation', () => {
	it.each([
		{ name: 'flake publish', workflow: flakeWorkflow, checkoutCount: 3 },
		{ name: 'publish', workflow: publishWorkflow, checkoutCount: 1 }
	])(
		'reserves every workflow-source checkout in $name',
		async ({ workflow, checkoutCount }) => {
			const contents = await readFile(workflow, 'utf8');
			const lines = contents.split('\n');
			const workflowCheckouts = actionSteps(
				lines,
				/^ {6}- uses: actions\/checkout@/u
			).filter((step) =>
				step.some(
					(line) => line.trim() === 'repository: ${{ job.workflow_repository }}'
				)
			);
			const reservations = actionSteps(
				lines,
				/^ {6}- name: Reserve the cupboard workflow checkout$/u
			);
			const checkoutLines = lines.flatMap((line, index) =>
				line.trim() === 'repository: ${{ job.workflow_repository }}'
					? [index]
					: []
			);
			const reservationLines = lines.flatMap((line, index) =>
				line === '      - name: Reserve the cupboard workflow checkout'
					? [index]
					: []
			);

			expect({
				workflowCheckouts: workflowCheckouts.map((step) =>
					step
						.map((line) => line.trim())
						.find((line) => line.startsWith('path:'))
				),
				reservationCount: reservations.length,
				guardsImmediatelyPrecedeTheirCheckout: checkoutLines.every(
					(checkoutLine, index) => {
						const reservationLine = reservationLines[index];
						const previousCheckoutLine = checkoutLines[index - 1] ?? -1;

						return (
							reservationLine !== undefined &&
							reservationLine > previousCheckoutLine &&
							reservationLine < checkoutLine
						);
					}
				),
				reservations: reservations.map((step) => ({
					checkoutPath: stepText(step).includes(
						'${{ github.workspace }}/.cupboard-workflow'
					),
					ordinaryPathGuard: stepText(step).includes(
						'[ -e "${CUPBOARD_WORKFLOW_CHECKOUT}" ]'
					),
					symlinkGuard: stepText(step).includes(
						'[ -L "${CUPBOARD_WORKFLOW_CHECKOUT}" ]'
					),
					failClosed: stepText(step).includes('refusing to replace')
				})),
				legacyCheckoutDestination: contents.includes('path: .cupboard\n'),
				legacyActionReference: contents.includes('./.cupboard/actions/')
			}).toStrictEqual({
				workflowCheckouts: Array.from(
					{ length: checkoutCount },
					() => 'path: .cupboard-workflow'
				),
				reservationCount: checkoutCount,
				guardsImmediatelyPrecedeTheirCheckout: true,
				reservations: Array.from({ length: checkoutCount }, () => ({
					checkoutPath: true,
					ordinaryPathGuard: true,
					symlinkGuard: true,
					failClosed: true
				})),
				legacyCheckoutDestination: false,
				legacyActionReference: false
			});
		}
	);
});

describe('cupboard flake publish release coordinates', () => {
	it('lets configure refresh only its own prior workflow checkout', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const lines = contents.split('\n');
		const [configureReservation] = actionSteps(
			lines,
			/^ {6}- name: Reserve the cupboard workflow checkout$/u
		);
		const text = stepText(configureReservation);

		expect({
			identity: text.includes(
				'WORKFLOW_REPOSITORY: ${{ job.workflow_repository }}'
			),
			origin: text.includes('remote get-url origin'),
			acceptsExact: text.includes('[ "${origin}" != "${expected}" ]'),
			acceptsGitSuffix: text.includes('[ "${origin}" != "${expected}.git" ]'),
			rejectsSymlink: text.includes('[ -L "${CUPBOARD_WORKFLOW_CHECKOUT}" ]')
		}).toStrictEqual({
			identity: true,
			origin: true,
			acceptsExact: true,
			acceptsGitSuffix: true,
			rejectsSymlink: true
		});
	});

	it('refuses unsupported GitHub Enterprise Server execution before using workflow identity', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const cloudGuard = contents.indexOf(
			'      - name: Require GitHub Cloud workflow identity'
		);
		const workflowCheckout = contents.indexOf(
			'          repository: ${{ job.workflow_repository }}'
		);

		expect({
			guardPresent: cloudGuard !== -1,
			guardPrecedesIdentityUse:
				cloudGuard !== -1 &&
				workflowCheckout !== -1 &&
				cloudGuard < workflowCheckout,
			checksServerUrl: contents.includes(
				'if [ "${GITHUB_SERVER_URL}" != https://github.com ]; then'
			)
		}).toStrictEqual({
			guardPresent: true,
			guardPrecedesIdentityUse: true,
			checksServerUrl: true
		});
	});

	it('resolves one canonical cupboard coordinate for every consuming job', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const lines = contents.split('\n');
		const [resolver] = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard-workflow\/actions\/resolve-cupboard$/u
		);
		const setups = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard-workflow\/actions\/setup$/u
		);
		const versionInput = contents.slice(
			contents.indexOf('      cupboard-version:'),
			contents.indexOf('      maximise-space:')
		);

		expect({
			versionOptional: contents.includes(
				'      cupboard-version:\n        description:'
			),
			versionRequired: versionInput.includes('required: true'),
			configurePermission:
				contents.includes(
					'configure:\n    name: Resolve the publication inputs\n'
				) &&
				contents.includes(
					'permissions:\n      contents: read # resolve cupboard'
				),
			canonicalOutput: contents.includes(
				'cupboard: ${{ steps.resolve-cupboard.outputs.cupboard }}'
			),
			resolver: (resolver ?? [])
				.map((line) => line.trim())
				.filter((line) => line !== ''),
			setupCoordinates: setups.map((step) =>
				step
					.map((line) => line.trim())
					.find((line) => line.startsWith('cupboard:'))
			)
		}).toStrictEqual({
			versionOptional: true,
			versionRequired: false,
			configurePermission: true,
			canonicalOutput: true,
			resolver: [
				'- uses: ./.cupboard-workflow/actions/resolve-cupboard',
				'id: resolve-cupboard',
				'with:',
				'cupboard-version: ${{ inputs.cupboard-version }}',
				'workflow-repository: ${{ job.workflow_repository }}',
				'workflow-ref: ${{ job.workflow_ref }}',
				'workflow-sha: ${{ job.workflow_sha }}',
				'github-token: ${{ github.token }}',
				'github-api-url: ${{ github.api_url }}',
				'github-graphql-url: ${{ github.graphql_url }}'
			],
			setupCoordinates: Array.from(
				{ length: 2 },
				() => 'cupboard: ${{ needs.configure.outputs.cupboard }}'
			)
		});
	});

	it('configures classic builders only when no direct store is selected', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const lines = contents.split('\n');
		const prepares = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard-workflow\/actions\/prepare$/u
		);
		const planPrepare = prepares[0]?.map((line) => line.trim());
		const planPrepareText = planPrepare?.join(' ');
		const cohortPrepareText = prepares[1]?.map((line) => line.trim()).join(' ');
		const input = (name: string) =>
			planPrepare?.find((line) => line.startsWith(`${name}:`));

		expect({
			remote: input('remote'),
			store: input('store'),
			buildersIsolated: planPrepareText?.includes(
				"builders: ${{ inputs.store == '' && inputs.builders || '' }}"
			),
			builderSshKeyIsolated: planPrepareText?.includes(
				"builder-ssh-key: ${{ inputs.builders != '' && inputs.store == '' && secrets.builder_ssh_key || '' }}"
			),
			builderSshConfigIsolated: planPrepareText?.includes(
				"builder-ssh-config: ${{ inputs.builders != '' && inputs.store == '' && secrets.builder_ssh_config || '' }}"
			),
			builderKnownHostsIsolated: planPrepareText?.includes(
				"builder-known-hosts: ${{ inputs.builders != '' && inputs.store == '' && inputs.builder-known-hosts || '' }}"
			),
			cohortBuilderInputsIsolated: [
				'builders: ${{ matrix.remote',
				'builder-ssh-key: ${{ matrix.remote',
				'builder-ssh-config: ${{ matrix.remote',
				'builder-known-hosts: ${{ matrix.remote'
			].map((input) => cohortPrepareText?.includes(input))
		}).toStrictEqual({
			remote: "remote: ${{ inputs.builders != '' && inputs.store == '' }}",
			store: 'store: ${{ inputs.store }}',
			buildersIsolated: true,
			builderSshKeyIsolated: true,
			builderSshConfigIsolated: true,
			builderKnownHostsIsolated: true,
			cohortBuilderInputsIsolated: [true, true, true, true]
		});
	});

	it('threads direct-store SSH credentials independently of classic builders', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const lines = contents.split('\n');
		const prepares = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard-workflow\/actions\/prepare$/u
		);
		const values = prepares.map((step) =>
			step.map((line) => line.trim()).join(' ')
		);

		expect({
			keySecret: contents.includes('      store_ssh_key:\n'),
			configSecret: contents.includes('      store_ssh_config:\n'),
			knownHostsInput: contents.includes('      store-known-hosts:\n'),
			ambientIdentityInput: contents.includes(
				'      store-ambient-identity:\n'
			),
			allPrepareSteps: values.map((step) => ({
				store: step.includes('store: ${{ inputs.store }}'),
				key: step.includes(
					"store-ssh-key: ${{ inputs.store != '' && secrets.store_ssh_key || '' }}"
				),
				config: step.includes(
					"store-ssh-config: ${{ inputs.store != '' && secrets.store_ssh_config || '' }}"
				),
				knownHosts: step.includes(
					"store-known-hosts: ${{ inputs.store != '' && inputs.store-known-hosts || '' }}"
				),
				ambientIdentity: step.includes(
					"store-ambient-identity: ${{ inputs.store != '' && inputs.store-ambient-identity || false }}"
				)
			}))
		}).toStrictEqual({
			keySecret: true,
			configSecret: true,
			knownHostsInput: true,
			ambientIdentityInput: true,
			allPrepareSteps: [
				{
					store: true,
					key: true,
					config: true,
					knownHosts: true,
					ambientIdentity: true
				},
				{
					store: true,
					key: true,
					config: true,
					knownHosts: true,
					ambientIdentity: true
				}
			]
		});
	});

	it('threads private-input host pins independently into every prepare step', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const lines = contents.split('\n');
		const prepares = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard-workflow\/actions\/prepare$/u
		);

		expect({
			workflowInput: contents.includes('      input-known-hosts:\n'),
			prepareSteps: prepares.map((step) =>
				step
					.map((line) => line.trim())
					.includes('input-known-hosts: ${{ inputs.input-known-hosts }}')
			)
		}).toStrictEqual({
			workflowInput: true,
			prepareSteps: [true, true]
		});
	});

	it('refuses simultaneous direct-store and classic-builder modes', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');

		expect(contents).toContain(
			'if [ -n "${STORE}" ] && [ -n "${BUILDERS}" ]; then'
		);
	});

	it('refuses ambient store identity without a direct store', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');

		expect({
			inputAvailable: contents.includes('      store-ambient-identity:\n'),
			validationEnvironment: contents.includes(
				'STORE_AMBIENT_IDENTITY: ${{ inputs.store-ambient-identity }}'
			),
			validation: contents.includes(
				'if [ "${STORE_AMBIENT_IDENTITY}" = true ] && [ -z "${STORE}" ]; then'
			),
			actionableError: contents.includes(
				'store-ambient-identity requires the store input'
			)
		}).toStrictEqual({
			inputAvailable: true,
			validationEnvironment: true,
			validation: true,
			actionableError: true
		});
	});

	it('rejects multiline builders before resolving workflow outputs', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const validation = `if [[ "\${BUILDERS}" == *$'\\n'* || "\${BUILDERS}" == *$'\\r'* ]]; then`;
		const outputWrite = 'echo "cache=${CACHE}"';

		expect({
			validation: contents.includes(validation),
			actionableError: contents.includes(
				'builders must not contain line breaks; separate inline builders with semicolons'
			),
			beforeOutputs:
				contents.indexOf(validation) < contents.indexOf(outputWrite)
		}).toStrictEqual({
			validation: true,
			actionableError: true,
			beforeOutputs: true
		});
	});

	it('requires pinned host-key evidence before planning remote work', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');

		expect({
			builderKnownHostsAvailable: contents.includes(
				'BUILDER_KNOWN_HOSTS: ${{ inputs.builder-known-hosts }}'
			),
			storeKnownHostsAvailable: contents.includes(
				'STORE_KNOWN_HOSTS: ${{ inputs.store-known-hosts }}'
			),
			requiresBuilderHostKeyEvidence: contents.includes(
				'builder-known-hosts is required when builders are enabled'
			),
			requiresStoreHostKeyEvidence: contents.includes(
				'store-known-hosts is required unless the store URI supplies base64-ssh-public-host-key'
			),
			acceptsStoreUriHostKeyEvidence: contents.includes(
				'base64-ssh-public-host-key=?*'
			),
			restrictsUriHostKeyToDefaultPort: contents.includes(
				'URI-only host-key pinning supports only the default SSH port'
			)
		}).toStrictEqual({
			builderKnownHostsAvailable: true,
			storeKnownHostsAvailable: true,
			requiresBuilderHostKeyEvidence: true,
			requiresStoreHostKeyEvidence: true,
			acceptsStoreUriHostKeyEvidence: true,
			restrictsUriHostKeyToDefaultPort: true
		});
	});
});

describe('cupboard publish release coordinates', () => {
	it('refuses unsupported GitHub Enterprise Server execution before using workflow identity', async () => {
		const contents = await readFile(publishWorkflow, 'utf8');
		const cloudGuard = contents.indexOf(
			'      - name: Require GitHub Cloud workflow identity'
		);
		const workflowCheckout = contents.indexOf(
			'          repository: ${{ job.workflow_repository }}'
		);

		expect({
			guardPresent: cloudGuard !== -1,
			guardPrecedesIdentityUse:
				cloudGuard !== -1 &&
				workflowCheckout !== -1 &&
				cloudGuard < workflowCheckout,
			checksServerUrl: contents.includes(
				'if [ "${GITHUB_SERVER_URL}" != https://github.com ]; then'
			)
		}).toStrictEqual({
			guardPresent: true,
			guardPrecedesIdentityUse: true,
			checksServerUrl: true
		});
	});

	it('documents tag-pinned resolution without duplicate coordinates', async () => {
		const documentation = await readFile(githubActionsDocumentation, 'utf8');
		const reusableWorkflowSection = documentation.slice(
			documentation.indexOf('## The reusable workflow\n'),
			documentation.indexOf('### Publishing a target manifest\n')
		);

		expect({
			tagPinned: reusableWorkflowSection.includes(
				'uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@vX.Y.Z'
			),
			versionOverride: reusableWorkflowSection.includes('cupboard-version:'),
			sourceCommit: reusableWorkflowSection.includes('cupboard-source-commit:')
		}).toStrictEqual({
			tagPinned: true,
			versionOverride: false,
			sourceCommit: false
		});
	});

	it('documents literal-first legacy version fallback and the Cloud boundary', async () => {
		const documentation = await readFile(githubActionsDocumentation, 'utf8');
		const prose = documentation.replaceAll(/\s+/gu, ' ');

		expect({
			literalFirst: prose.includes(
				'`1.2.3` first resolves the literal `1.2.3` tag.'
			),
			legacyFallback: prose.includes(
				'the actions try the legacy `v1.2.3` spelling.'
			),
			cloudOnly: prose.includes('The reusable workflows require GitHub Cloud.'),
			identityReason: prose.includes(
				'GHES does not expose the `job.workflow_*` identity fields'
			)
		}).toStrictEqual({
			literalFirst: true,
			legacyFallback: true,
			cloudOnly: true,
			identityReason: true
		});
	});

	it('loads its action code from the called workflow commit', async () => {
		const contents = await readFile(publishWorkflow, 'utf8');
		const lines = contents.split('\n');
		const checkouts = actionSteps(lines, /^ {6}- uses: actions\/checkout@/u);
		const cupboardCheckout = checkouts[1]?.map((line) => line.trim());
		const [setup] = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard-workflow\/actions\/setup$/u
		);
		const [push] = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard-workflow\/actions\/push$/u
		);
		const [resolver] = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard-workflow\/actions\/resolve-cupboard$/u
		);
		const versionInput = contents.slice(
			contents.indexOf('      cupboard-version:'),
			contents.indexOf('\n# The caller grants')
		);
		expect({
			checkoutRepository: cupboardCheckout?.find((line) =>
				line.startsWith('repository:')
			),
			checkoutRef: cupboardCheckout?.find((line) => line.startsWith('ref:')),
			versionOptional: contents.includes(
				'      cupboard-version:\n        description:'
			),
			versionDefault: /cupboard-version:[\s\S]*?default:/u.test(versionInput),
			sourceCommitInput: contents.includes('cupboard-source-commit:'),
			resolverCoordinate: stepText(resolver).includes(
				'cupboard-version: ${{ inputs.cupboard-version }} workflow-repository: ${{ job.workflow_repository }} workflow-ref: ${{ job.workflow_ref }} workflow-sha: ${{ job.workflow_sha }}'
			),
			setupCoordinate: stepText(setup).includes(
				'cupboard: ${{ steps.resolve-cupboard.outputs.cupboard }}'
			),
			pushReusesSetup: stepText(push).includes(
				'cupboard-path: ${{ steps.setup.outputs.cupboard-path }}'
			)
		}).toStrictEqual({
			checkoutRepository: 'repository: ${{ job.workflow_repository }}',
			checkoutRef: 'ref: ${{ job.workflow_sha }}',
			versionOptional: true,
			versionDefault: false,
			sourceCommitInput: false,
			resolverCoordinate: true,
			setupCoordinate: true,
			pushReusesSetup: true
		});
	});

	it('requires complete current-run provenance when attestation is enabled', async () => {
		const contents = await readFile(publishWorkflow, 'utf8');
		const lines = contents.split('\n');
		const [build] = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard-workflow\/actions\/build-paths$/u
		);
		const buildInputs = new Set((build ?? []).map((line) => line.trim()));

		expect(buildInputs.has('require-provenance: ${{ inputs.attest }}')).toBe(
			true
		);
	});

	it('resolves an omitted version from the called workflow SHA', async () => {
		const caller = await readFile(legacyPublishCaller, 'utf8');
		const workflow = await readFile(publishWorkflow, 'utf8');

		expect({
			callsMovingWorkflow: caller.includes(
				'uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@main'
			),
			omitsVersion: !caller.includes('cupboard-version:'),
			omitsSource: !caller.includes('cupboard-source-commit:'),
			automaticResolution:
				workflow.includes(
					'- uses: ./.cupboard-workflow/actions/resolve-cupboard'
				) && workflow.includes('workflow-sha: ${{ job.workflow_sha }}')
		}).toStrictEqual({
			callsMovingWorkflow: true,
			omitsVersion: true,
			omitsSource: true,
			automaticResolution: true
		});
	});
});

describe('cupboard release asset compatibility', () => {
	it('documents stable new names and legacy installer lookup', async () => {
		const documentation = await readFile(releasesDocumentation, 'utf8');
		const prose = documentation.replaceAll(/\s+/gu, ' ');

		expect({
			stablePlatforms: [
				'cupboard-linux-x64.tar.gz',
				'cupboard-linux-arm64.tar.gz',
				'cupboard-macos-x64.tar.gz',
				'cupboard-macos-arm64.tar.gz'
			].every((name) => documentation.includes(`\`${name}\``)),
			legacyLookup: prose.includes(
				'lookup support for the older `cupboard-vX.Y.Z-<platform>-<arch>.tar.gz` assets.'
			)
		}).toStrictEqual({ stablePlatforms: true, legacyLookup: true });
	});
});

describe('cupboard release cache', () => {
	it('keeps every release binary publication required', async () => {
		const releaseCacheRead = readFile(releaseCacheWorkflow, 'utf8');
		const reusablePublishRead = readFile(publishWorkflow, 'utf8');
		const releaseCache = await releaseCacheRead;
		const reusablePublish = await reusablePublishRead;
		const publishJob = releaseCache.slice(
			releaseCache.indexOf('  publish:\n'),
			releaseCache.indexOf('\n  flakehub:\n')
		);
		const flakehubJob = releaseCache.slice(
			releaseCache.indexOf('  flakehub:\n')
		);

		expect({
			allRequiredPlatformsSettle: publishJob.includes('fail-fast: false'),
			stableReleaseCache: publishJob.includes('cache: releases'),
			versionedRetentionRoot: publishJob.includes(
				'root: github:${{ github.repository }}/${{ github.event.release.tag_name }}'
			),
			callerTolerance: publishJob.includes('continue-on-error:'),
			callerBestEffort: /best-?effort/iu.test(publishJob),
			reusableTolerance: reusablePublish.includes('continue-on-error:'),
			releaseVersionPinned: publishJob.includes(
				'cupboard-version: ${{ github.event.release.tag_name }}'
			),
			releaseSourcePinned: publishJob.includes('cupboard-source-commit:'),
			flakehubRequiresCacheMatrix: flakehubJob.includes('    needs: publish')
		}).toStrictEqual({
			allRequiredPlatformsSettle: true,
			stableReleaseCache: true,
			versionedRetentionRoot: true,
			callerTolerance: false,
			callerBestEffort: false,
			reusableTolerance: false,
			releaseVersionPinned: true,
			releaseSourcePinned: false,
			flakehubRequiresCacheMatrix: true
		});
	});
});

describe('cupboard repository cache publishing', () => {
	it('keeps the moving-main caller compatible with one released CLI', async () => {
		const [contents, reusableWorkflow] = await Promise.all([
			readFile(cachePublishWorkflow, 'utf8'),
			readFile(publishWorkflow, 'utf8')
		]);
		const versions = contents.match(/cupboard-version: v0\.0\.19/g)?.length;
		const versionInput = reusableWorkflow.slice(
			reusableWorkflow.indexOf('      cupboard-version:'),
			reusableWorkflow.indexOf('\n# The caller grants')
		);

		expect({
			versionPins: versions,
			callerAvoidsFutureInput: !contents.includes('cupboard-source-commit:'),
			reusableVersionDefault: /cupboard-version:[\s\S]*?default:/u.test(
				versionInput
			),
			explainsDeliberateSkew: contents.includes(
				'The reusable workflow stays on @main for the tenant trust rule, while'
			)
		}).toStrictEqual({
			versionPins: 2,
			callerAvoidsFutureInput: true,
			reusableVersionDefault: false,
			explainsDeliberateSkew: true
		});
	});
});

describe('tag-pinned reusable-workflow documentation', () => {
	it.each([
		['trust rules', trustRulesDocumentation],
		['reuse views', reuseViewsDocumentation]
	])('derives the release from the pin in %s', async (_name, documentation) => {
		const contents = await readFile(documentation, 'utf8');
		const prose = contents.replaceAll(/\s+/gu, ' ');
		const examples = contents.match(
			/```yaml\n[\s\S]*?uses: underwhelmingperformance\/cupboard\/\.github\/workflows\/cupboard-flake-publish\.yml@vX\.Y\.Z[\s\S]*?```/gu
		);

		expect({
			examples: examples?.map((example) => ({
				tagPinned: example.includes('@vX.Y.Z'),
				versionOverride: example.includes('cupboard-version:')
			})),
			explainsOverride: prose.includes(
				'Set `cupboard-version` only when you deliberately want to run a release other than the one the workflow is pinned to.'
			)
		}).toStrictEqual({
			examples: [{ tagPinned: true, versionOverride: false }],
			explainsOverride: true
		});
	});
});

describe('cupboard flake publish cohort job', () => {
	it('replaces the target fan-out with a cohort job gated on the cohort matrix', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');

		expect({
			planOutputsCohortMatrix: contents.includes(
				'cohort-matrix: ${{ steps.plan.outputs.cohort-matrix }}'
			),
			planOutputsCohortCount: contents.includes(
				'cohort-count: ${{ steps.plan.outputs.cohort-count }}'
			),
			cohortJob: contents.includes('\n  cohort:\n'),
			gatedOnCohortCount: contents.includes(
				"if: ${{ needs.plan.outputs.cohort-count != '0' }}"
			),
			matrixFromCohortMatrix: contents.includes(
				'matrix: ${{ fromJSON(needs.plan.outputs.cohort-matrix) }}'
			),
			targetJobRemoved: !contents.includes('\n  target:\n'),
			targetMatrixOutputRemoved: !contents.includes('target-matrix:'),
			targetCountOutputRemoved: !contents.includes('target-count:')
		}).toStrictEqual({
			planOutputsCohortMatrix: true,
			planOutputsCohortCount: true,
			cohortJob: true,
			gatedOnCohortCount: true,
			matrixFromCohortMatrix: true,
			targetJobRemoved: true,
			targetMatrixOutputRemoved: true,
			targetCountOutputRemoved: true
		});
	});

	it('builds and publishes through build-cohort alone', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');

		expect({
			usesBuildCohort: contents.includes(
				'./.cupboard-workflow/actions/build-cohort'
			),
			usesPush: contents.includes('./.cupboard-workflow/actions/push'),
			usesBuildPaths: contents.includes(
				'./.cupboard-workflow/actions/build-paths'
			),
			rootGroupingStepRemoved: !contents.includes('root-groups')
		}).toStrictEqual({
			usesBuildCohort: true,
			usesPush: false,
			usesBuildPaths: false,
			rootGroupingStepRemoved: true
		});
	});

	it('routes cohort tolerance into build-cohort without suppressing the step', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const lines = contents.split('\n');
		const cohortJob = lines.indexOf('  cohort:');
		const nextJob = lines.findIndex(
			(line, index) =>
				index > cohortJob && /^ {2}\S/u.test(line) && line.endsWith(':')
		);

		const jobLines = lines.slice(
			cohortJob,
			nextJob === -1 ? undefined : nextJob
		);
		const [buildCohortStep] = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard-workflow\/actions\/build-cohort$/u
		);
		const buildCohortInputs = new Set(
			(buildCohortStep ?? []).map((line) => line.trim())
		);

		expect({
			jobLevel: jobLines
				.slice(0, jobLines.indexOf('    steps:'))
				.map((line) => line.trim())
				.filter((line) => line.startsWith('continue-on-error:')),
			buildCohortStep: (buildCohortStep ?? [])
				.map((line) => line.trim())
				.filter((line) => line.startsWith('continue-on-error:')),
			bestEffortInput: buildCohortInputs.has(
				'best-effort: ${{ matrix.bestEffort }}'
			)
		}).toStrictEqual({
			jobLevel: [],
			buildCohortStep: [],
			bestEffortInput: true
		});
	});

	it('carries no artifact upload or download steps', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');

		expect({
			uploadArtifact: contents.includes('actions/upload-artifact'),
			downloadArtifact: contents.includes('actions/download-artifact')
		}).toStrictEqual({
			uploadArtifact: false,
			downloadArtifact: false
		});
	});

	it('threads the packing opt-in and its capacity through to the plan action', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');

		expect({
			enablePackingWorkflowInput: contents.includes(
				'      enable-packing:\n        description:'
			),
			packCapacityWorkflowInput: contents.includes(
				'      pack-capacity:\n        description:'
			),
			enablePackingActionInput: contents.includes(
				'enable-packing: ${{ inputs.enable-packing }}'
			),
			packCapacityActionInput: contents.includes(
				'pack-capacity: ${{ inputs.pack-capacity }}'
			)
		}).toStrictEqual({
			enablePackingWorkflowInput: true,
			packCapacityWorkflowInput: true,
			enablePackingActionInput: true,
			packCapacityActionInput: true
		});
	});

	it('prices the packing measurement against the store the cohorts build against', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const lines = contents.split('\n');
		const [planStep] = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard-workflow\/actions\/plan$/u
		);
		const trimmed = new Set((planStep ?? []).map((line) => line.trim()));

		expect({
			storeThreadedIntoPlan: trimmed.has('store: ${{ inputs.store }}'),
			packingThreadedIntoPlan: trimmed.has(
				'enable-packing: ${{ inputs.enable-packing }}'
			)
		}).toStrictEqual({
			storeThreadedIntoPlan: true,
			packingThreadedIntoPlan: true
		});
	});

	it('threads the remote store into the cohort build', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const lines = contents.split('\n');
		const [buildCohortStep] = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard-workflow\/actions\/build-cohort$/u
		);
		const trimmed = (buildCohortStep ?? []).map((line) => line.trim());

		expect({
			storeWorkflowInput: contents.includes(
				'      store:\n        description:'
			),
			storeThreadedIntoBuildCohort: trimmed.includes(
				'store: ${{ inputs.store }}'
			)
		}).toStrictEqual({
			storeWorkflowInput: true,
			storeThreadedIntoBuildCohort: true
		});
	});

	it('leaves direct-store concurrency to the selected daemon', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const lines = contents.split('\n');
		const prepares = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard-workflow\/actions\/prepare$/u
		);
		const cohortPrepare = prepares[1]?.map((line) => line.trim());
		const [buildCohortStep] = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard-workflow\/actions\/build-cohort$/u
		);
		const build = (buildCohortStep ?? []).map((line) => line.trim());

		expect({
			classicBuilderPreparation: cohortPrepare?.find((line) =>
				line.startsWith('remote:')
			),
			maxJobs: build.find((line) => line.startsWith('max-jobs:'))
		}).toStrictEqual({
			classicBuilderPreparation:
				"remote: ${{ matrix.remote && inputs.store == '' }}",
			maxJobs:
				"max-jobs: ${{ matrix.remote && inputs.store == '' && '0' || '' }}"
		});
	});

	it('threads publication and the shared run root into build-cohort', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const [buildCohortStep] = actionSteps(
			contents.split('\n'),
			/^ {6}- uses: \.\/\.cupboard-workflow\/actions\/build-cohort$/u
		);
		const buildCohortText = stepText(buildCohortStep);

		expect({
			pushThreaded: contents.includes('push: ${{ inputs.push }}'),
			gcThreaded: buildCohortText.includes(
				"gc-between-cohorts: ${{ inputs.gc-between-cohorts && runner.environment == 'github-hosted' && inputs.store == '' }}"
			),
			gcWorkflowInput: contents.includes(
				'      gc-between-cohorts:\n        description:'
			),
			runRootPerRun: contents.includes("format('{0}/_cupboard-run/{1}',"),
			runRootTtlInput: contents.includes(
				'run-root-ttl: ${{ inputs.run-root-ttl }}'
			),
			runRootTtlWorkflowInput: contents.includes(
				'      run-root-ttl:\n        description:'
			)
		}).toStrictEqual({
			pushThreaded: true,
			gcThreaded: true,
			gcWorkflowInput: true,
			runRootPerRun: true,
			runRootTtlInput: true,
			runRootTtlWorkflowInput: true
		});
	});
});

describe('prepare SSH transport', () => {
	it('exercises the shipped Nix client against the pinned remote daemon', async () => {
		const [contents, dockerfile] = await Promise.all([
			readFile(ciWorkflow, 'utf8'),
			readFile(remoteStoreDockerfile, 'utf8')
		]);
		const e2e = contents.slice(
			contents.indexOf('  e2e:\n'),
			contents.indexOf('  action-e2e:\n')
		);

		expect({
			installer: e2e.includes(
				'uses: nixbuild/nix-quick-install-action@9f63be77f412a248c9d9a65a4c82cf066cdf8f0c # v35'
			),
			clientVersion: e2e.includes('nix_version: 2.34.7'),
			remoteDaemonVersion: dockerfile.includes('FROM nixos/nix:2.34.8@sha256:')
		}).toStrictEqual({
			installer: true,
			clientVersion: true,
			remoteDaemonVersion: true
		});
	});

	it('pins a Nix client version supported by the installer release', async () => {
		const contents = await readFile(prepareAction, 'utf8');
		const start = contents.indexOf(
			'- uses: nixbuild/nix-quick-install-action@'
		);
		const next = contents.indexOf('\n    - ', start + 1);
		const install = contents.slice(start, next === -1 ? undefined : next);

		expect({
			stepFound: start !== -1,
			version: install
				.split('\n')
				.map((line) => line.trim())
				.find((line) => line.startsWith('nix_version:'))
		}).toStrictEqual({ stepFound: true, version: 'nix_version: 2.34.7' });
	});

	it('exports the selected SSH mode into the exact configure step', async () => {
		const contents = await readFile(prepareAction, 'utf8');
		const start = contents.indexOf('- name: Configure Nix SSH transport');
		const next = contents.indexOf('\n    - name:', start + 1);
		const configureStep = contents.slice(start, next === -1 ? undefined : next);

		expect({
			stepFound: start !== -1,
			remote: configureStep.includes('REMOTE: ${{ inputs.remote }}'),
			command: configureStep.includes(
				'bash "${GITHUB_ACTION_PATH}/ssh-transport.sh" configure'
			)
		}).toStrictEqual({ stepFound: true, remote: true, command: true });
	});

	it('exposes and validates the selected SSH credential policy', async () => {
		const contents = await readFile(prepareAction, 'utf8');
		const implementation = await readFile(prepareTransport, 'utf8');
		expect({
			inputKnownHostsInput: contents.includes('  input-known-hosts:\n'),
			inputKnownHostsEnvironment: contents.includes(
				'INPUT_KNOWN_HOSTS: ${{ inputs.input-known-hosts }}'
			),
			storeInput: contents.includes('  store:\n'),
			storeKeyInput: contents.includes('  store-ssh-key:\n'),
			storeConfigInput: contents.includes('  store-ssh-config:\n'),
			storeKnownHostsInput: contents.includes('  store-known-hosts:\n'),
			storeAmbientIdentityInput: contents.includes(
				'  store-ambient-identity:\n'
			),
			refusesBothModes: implementation.includes(
				'remote and store select different SSH modes and are mutually exclusive'
			),
			refusesBuilderCredentialsOutsideBuilderMode: implementation.includes(
				'builder SSH inputs require remote to be true'
			),
			refusesStoreCredentialsOutsideStoreMode: implementation.includes(
				'store SSH inputs require the store input'
			),
			refusesPersistentMultiplexing: [
				'controlmaster)',
				'controlpath)',
				'controlpersist)'
			].every((directive) => implementation.includes(directive)),
			usesTransportImplementation: contents.match(
				/ssh-transport\.sh" (?:validate|configure)/gu
			)?.length,
			requiresBuilderHostKeyEvidence: implementation.includes(
				'builder-known-hosts is required when remote builders are enabled'
			),
			requiresStoreHostKeyEvidence: implementation.includes(
				'store-known-hosts is required unless the store URI supplies base64-ssh-public-host-key'
			),
			requiresInputHostKeyEvidence: implementation.includes(
				'input-known-hosts is required when the private flake input SSH key is supplied'
			),
			restrictsUriHostKeyEvidenceToDefaultPort: implementation.includes(
				'URI-only host-key pinning supports only the default SSH port'
			),
			passesActionPath: contents.includes(
				'bash "${GITHUB_ACTION_PATH}/ssh-transport.sh" configure'
			),
			passesPrivateInputActionPath: contents.includes(
				'bash "${GITHUB_ACTION_PATH}/ssh-transport.sh" configure-input'
			)
		}).toStrictEqual({
			inputKnownHostsInput: true,
			inputKnownHostsEnvironment: true,
			storeInput: true,
			storeKeyInput: true,
			storeConfigInput: true,
			storeKnownHostsInput: true,
			storeAmbientIdentityInput: true,
			refusesBothModes: true,
			refusesBuilderCredentialsOutsideBuilderMode: true,
			refusesStoreCredentialsOutsideStoreMode: true,
			refusesPersistentMultiplexing: true,
			usesTransportImplementation: 3,
			requiresBuilderHostKeyEvidence: true,
			requiresStoreHostKeyEvidence: true,
			requiresInputHostKeyEvidence: true,
			restrictsUriHostKeyEvidenceToDefaultPort: true,
			passesActionPath: true,
			passesPrivateInputActionPath: true
		});
	});
});

describe('cupboard cohort collection boundary', () => {
	it('collects only an ephemeral local store and explains unsupported requests', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const lines = contents.split('\n');
		const [skipStep] = actionSteps(
			lines,
			/^ {6}- name: Explain skipped local store collection$/u
		);
		const [collectStep] = actionSteps(
			lines,
			/^ {6}- name: Collect the local store$/u
		);
		const [buildCohortStep] = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard-workflow\/actions\/build-cohort$/u
		);
		const skip = lines.indexOf(
			'      - name: Explain skipped local store collection'
		);
		const collect = lines.indexOf('      - name: Collect the local store');
		const attach = lines.indexOf(
			'      - uses: ./.cupboard-workflow/actions/attest-attach'
		);
		const collectText = stepText(collectStep);
		const skipText = stepText(skipStep);
		const buildCohortText = stepText(buildCohortStep);
		const releases = collectText.indexOf('rm -rf -- "${OUT_LINK_DIRECTORY}"');
		const collects = collectText.indexOf('if ! nix store gc; then');

		expect({
			followsTheAttachStep: attach !== -1 && skip > attach && collect > skip,
			collectsOnlyGithubHosted: collectText.includes(
				"runner.environment == 'github-hosted'"
			),
			collectsOnlyTheLocalStore: collectText.includes("inputs.store == ''"),
			internalCollectionUsesTheSameGate: buildCohortText.includes(
				"gc-between-cohorts: ${{ inputs.gc-between-cohorts && runner.environment == 'github-hosted' && inputs.store == '' }}"
			),
			skipCoversSelfHosted: skipText.includes(
				"runner.environment != 'github-hosted'"
			),
			skipCoversDirectStore: skipText.includes("inputs.store != ''"),
			skipReportsSelfHosted: skipText.includes(
				'local store collection is unsupported on self-hosted runners'
			),
			skipReportsDirectStore: skipText.includes(
				'the build uses a direct remote store'
			),
			takesTheOutLinksFromBuildCohort: collectText.includes(
				'${{ steps.build-cohort.outputs.out-link-directory }}'
			),
			releasesTheOutLinksBeforeCollecting:
				releases !== -1 && collects !== -1 && releases < collects,
			warnsWithoutFailingTheJob: collectText.includes(
				"echo '::warning::nix store gc failed"
			)
		}).toStrictEqual({
			followsTheAttachStep: true,
			collectsOnlyGithubHosted: true,
			collectsOnlyTheLocalStore: true,
			internalCollectionUsesTheSameGate: true,
			skipCoversSelfHosted: true,
			skipCoversDirectStore: true,
			skipReportsSelfHosted: true,
			skipReportsDirectStore: true,
			takesTheOutLinksFromBuildCohort: true,
			releasesTheOutLinksBeforeCollecting: true,
			warnsWithoutFailingTheJob: true
		});
	});
});

describe('cupboard build provenance', () => {
	it('keeps rooted cohort targets rebuildable until this run attaches provenance', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const lines = contents.split('\n');
		const [planStep] = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard-workflow\/actions\/plan$/u
		);
		const [buildStep] = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard-workflow\/actions\/build-cohort$/u
		);

		expect({
			plan: stepText(planStep).includes(
				'require-provenance: ${{ inputs.push }}'
			),
			build: stepText(buildStep).includes(
				'require-provenance: ${{ inputs.push }}'
			)
		}).toStrictEqual({ plan: true, build: true });
	});

	it('documents release updates without routine tenant administration', async () => {
		const contents = await readFile(githubActionsDocumentation, 'utf8');
		const prose = contents.replaceAll(/\s+/gu, ' ');

		expect({
			tagPatternDefault: prose.includes(
				'When the tenant trusts the workflow at `refs/tags/v*`, check the new immutable release before updating the caller'
			),
			noTenantWrite: prose.includes(
				'the release update requires no tenant write or administrator credential'
			),
			exactTrustRequiresSetup: prose.includes(
				'A tenant that deliberately trusts one exact tag or commit instead must run `github setup` for each release before updating its caller.'
			)
		}).toStrictEqual({
			tagPatternDefault: true,
			noTenantWrite: true,
			exactTrustRequiresSetup: true
		});
	});

	it('documents verification against committed destination narinfos', async () => {
		const contents = await readFile(githubActionsDocumentation, 'utf8');

		expect({
			committedDestination: contents.includes(
				"destination's committed narinfos"
			),
			staleLiveStoreClaim: contents.includes(
				'against the live store, then signs'
			)
		}).toStrictEqual({
			committedDestination: true,
			staleLiveStoreClaim: false
		});
	});

	it('verifies every provenance subject against its committed destination', async () => {
		const workflows = await Promise.all(
			[flakeWorkflow, publishWorkflow].map(async (file) => {
				const contents = await readFile(file, 'utf8');

				return {
					file: file.pathname.split('/').at(-1),
					lines: contents.split('\n')
				};
			})
		);
		const attestations = workflows.flatMap(({ file, lines }) =>
			actionSteps(
				lines,
				/^\s+(?:- )?uses: \.\/\.cupboard-workflow\/actions\/attest$/u
			).map((step) => ({ file, step }))
		);

		expect(
			attestations.map(({ file, step }) => ({
				file,
				receipt: step
					.map((line) => line.trim())
					.find((line) => line.startsWith('receipt-file:')),
				url: step
					.map((line) => line.trim())
					.find((line) => line.startsWith('url:')),
				cache: step
					.map((line) => line.trim())
					.find((line) => line.startsWith('cache:')),
				readUser: step
					.map((line) => line.trim())
					.find((line) => line.startsWith('read-user:'))
			}))
		).toStrictEqual([
			{
				file: 'cupboard-flake-publish.yml',
				receipt: 'receipt-file: ${{ steps.build-cohort.outputs.receipt-file }}',
				url: 'url: ${{ inputs.url }}',
				cache: 'cache: ${{ needs.configure.outputs.cache }}',
				readUser: 'read-user: ${{ secrets.read_user }}'
			},
			{
				file: 'cupboard-publish.yml',
				receipt: 'receipt-file: ${{ steps.build.outputs.receipt-file }}',
				url: 'url: ${{ inputs.url }}',
				cache: 'cache: ${{ inputs.cache }}',
				readUser: undefined
			}
		]);
	});

	it('attests the cohort job only when it streamed a build to publish', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');

		expect(
			contents.includes(
				"inputs.push && steps.build-cohort.outputs.receipt-file != ''"
			)
		).toBe(true);
	});

	it('attaches the signed bundle to the published paths after the attest step', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const lines = contents.split('\n');
		const [attachStep] = actionSteps(
			lines,
			/^ {6}- uses: \.\/\.cupboard-workflow\/actions\/attest-attach$/u
		);
		const trimmed = (attachStep ?? []).map((line) => line.trim());
		const stepText = trimmed.join(' ');

		expect({
			attestStepNamed: contents.includes(
				'- uses: ./.cupboard-workflow/actions/attest\n        id: attest\n'
			),
			followsAttest:
				contents.indexOf('./.cupboard-workflow/actions/attest-attach') >
				contents.indexOf('./.cupboard-workflow/actions/attest\n'),
			gatedLikeAttestPlusBundle: stepText.includes(
				"if: ${{ inputs.push && steps.build-cohort.outputs.receipt-file != '' && steps.attest.outputs.bundle-path != '' }}"
			),
			url: trimmed.includes('url: ${{ inputs.url }}'),
			cupboardPath: trimmed.includes(
				'cupboard-path: ${{ steps.setup.outputs.cupboard-path }}'
			),
			cache: trimmed.includes('cache: ${{ needs.configure.outputs.cache }}'),
			readUser: trimmed.includes('read-user: ${{ secrets.read_user }}'),
			readPassword: trimmed.includes(
				'read-password: ${{ secrets.read_password }}'
			),
			remoteStore: trimmed.some((line) => line.startsWith('store:')),
			receipt: trimmed.includes(
				'receipt-file: ${{ steps.build-cohort.outputs.receipt-file }}'
			),
			// The workflow passes both bundles of the run in the single
			// repeatable `bundle` input.
			bundleLines: trimmed.filter(
				(line) =>
					line.startsWith('bundle:') ||
					line.startsWith('${{ steps.attest.outputs.')
			)
		}).toStrictEqual({
			attestStepNamed: true,
			followsAttest: true,
			gatedLikeAttestPlusBundle: true,
			url: true,
			cupboardPath: true,
			cache: true,
			readUser: true,
			readPassword: true,
			remoteStore: false,
			receipt: true,
			bundleLines: [
				'bundle: |',
				'${{ steps.attest.outputs.bundle-path }}',
				'${{ steps.attest.outputs.origin-bundle-path }}'
			]
		});
	});

	it('publishes before signing and attaches the resulting bundle in the simple workflow', async () => {
		const contents = await readFile(publishWorkflow, 'utf8');
		const push = contents.indexOf('- uses: ./.cupboard-workflow/actions/push');
		const attest = contents.indexOf(
			'uses: ./.cupboard-workflow/actions/attest\n'
		);
		const attach = contents.indexOf(
			'- uses: ./.cupboard-workflow/actions/attest-attach'
		);

		expect({
			pushBeforeAttest: push !== -1 && push < attest,
			attestBeforeAttach: attest !== -1 && attest < attach,
			pushDoesNotReceiveAnUnsignedBundle: !contents.includes(
				'attestations: ${{ steps.attest.outputs.bundle-path'
			)
		}).toStrictEqual({
			pushBeforeAttest: true,
			attestBeforeAttach: true,
			pushDoesNotReceiveAnUnsignedBundle: true
		});
	});
});

describe('cupboard flake publish event preset', () => {
	it('rejects line breaks before writing resolved outputs', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');
		const validation =
			'for name in PRESET CACHE ROOT_PREFIX TTL REUSE_VIEW BRANCH; do';
		const outputWrite = 'echo "cache=${CACHE}"';

		expect({
			validation: contents.includes(validation),
			lineFeed: contents.includes(`"\${!name}" == *$'\\n'*`),
			carriageReturn: contents.includes(`"\${!name}" == *$'\\r'*`),
			beforeOutputs:
				contents.indexOf(validation) < contents.indexOf(outputWrite)
		}).toStrictEqual({
			validation: true,
			lineFeed: true,
			carriageReturn: true,
			beforeOutputs: true
		});
	});

	it('refuses non-pull-request runs outside the trusted branch', async () => {
		const contents = await readFile(flakeWorkflow, 'utf8');

		expect({
			branchInput: contents.includes('      branch:\n'),
			trustedRefCheck: contents.includes(
				'elif [ "${REF}" = "refs/heads/${BRANCH}" ]; then'
			),
			unsupportedRefError: contents.includes(
				"preset 'pull-request-and-branch' accepts pull_request runs or refs/heads/${BRANCH}"
			)
		}).toStrictEqual({
			branchInput: true,
			trustedRefCheck: true,
			unsupportedRefError: true
		});
	});
});
