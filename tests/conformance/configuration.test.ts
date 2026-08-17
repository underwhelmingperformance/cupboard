import { expect, it } from 'vitest';

import { NixConfigIncludeError } from '../../packages/nix/src/nix-store.ts';

import {
	acceptanceOf,
	comparisonOf,
	type ConfigurationFixture,
	resolveFixture,
	settingsAbsentFromTheOracle,
	settingsMissingFromOracle,
	settingsOf,
	unmodelledSettings
} from './configuration.ts';
import { describeConformance } from './oracle.ts';

/**
 * The in-scope settings these four groups do not model. The suite reports them
 * rather than ignoring them. Asserting the list prevents a setting from
 * being modelled, or dropped by Nix, without the record moving with it.
 */
const recordedUnmodelledSettings: readonly string[] = [
	'build-hook',
	'build-poll-interval',
	'builders-use-substitutes',
	'connect-timeout',
	'cores',
	'download-buffer-size',
	'download-speed',
	'external-builders',
	'http2',
	'max-jobs',
	'max-substitution-jobs',
	'narinfo-cache-meta-ttl',
	'narinfo-cache-negative-ttl',
	'narinfo-cache-positive-ttl',
	'ssl-cert-file',
	'tarball-ttl',
	'trusted-substituters',
	'user-agent-suffix'
];

const booleanSpellings: readonly { affirmative: string; negative: string }[] = [
	{ affirmative: 'true', negative: 'false' },
	{ affirmative: 'yes', negative: 'no' },
	{ affirmative: '1', negative: '0' }
];

const machinesFile =
	'ssh://builder-one x86_64-linux ; ssh://builder-two aarch64-linux\n' +
	'# the line below adds another builder\n' +
	'ssh://builder-three aarch64-darwin\n';

describeConformance('the resolved Nix configuration', (oracle) => {
	// Exact: both sides resolve one fixture, and every field the adapter table
	// maps has to come out the same.
	it.each<{ name: string; fixture: ConfigurationFixture }>([
		{
			name: 'an empty configuration',
			fixture: { nixConf: '' }
		},
		{
			name: 'assigned lists',
			fixture: {
				nixConf:
					'substituters = https://one.invalid/ https://two.invalid/\n' +
					'trusted-public-keys = one-1:QUFB two-1:QkJC\n' +
					'secret-key-files = /keys/one.key /keys/two.key\n' +
					'system-features = big-parallel uid-range\n'
			}
		},
		{
			name: 'a list appended to after it was assigned',
			fixture: {
				nixConf:
					'substituters = https://assigned.invalid/\n' +
					'extra-substituters = https://appended.invalid/\n'
			}
		},
		{
			name: 'a list assigned after it was appended to',
			fixture: {
				nixConf:
					'extra-substituters = https://appended.invalid/\n' +
					'substituters = https://assigned.invalid/\n'
			}
		},
		{
			name: 'the deprecated spellings of a setting name',
			fixture: {
				nixConf:
					'binary-caches = https://alias.invalid/\n' +
					'binary-cache-public-keys = alias-1:QUFB\n' +
					'binary-caches-parallel-connections = 7\n' +
					'build-use-substitutes = false\n' +
					'build-fallback = true\n'
			}
		},
		{
			name: 'an assigned system and further platforms',
			fixture: {
				nixConf:
					'system = x86_64-linux\n' +
					'extra-platforms = aarch64-linux i686-linux\n'
			}
		},
		{
			name: 'additional platforms appended to the local system',
			fixture: { nixConf: 'extra-extra-platforms = riscv64-linux\n' }
		},
		{
			name: 'builders written out in full',
			fixture: {
				nixConf: 'builders = ssh://only-builder aarch64-darwin\n'
			}
		},
		{
			name: 'builders read from a machines file',
			fixture: { nixConf: '', machines: machinesFile }
		},
		{
			name: 'transfer settings expressed in Nix units',
			fixture: {
				nixConf:
					'download-attempts = 9\n' +
					'stalled-download-timeout = 42\n' +
					'http-connections = 3\n'
			}
		},
		{
			name: 'NIX_CONFIG applied over the configuration file',
			fixture: {
				nixConf: 'substituters = https://file.invalid/\n',
				inlineConfig: 'substituters = https://inline.invalid/'
			}
		},
		{
			// Nix preserves duplicate entries in these list settings.
			name: 'a substituter and trusted key each repeated',
			fixture: {
				nixConf:
					'substituters = https://twice.invalid/ https://once.invalid/ https://twice.invalid/\n' +
					'trusted-public-keys = twice-1:AAA= once-1:BBB= twice-1:AAA=\n'
			}
		},
		{
			name: 'a substituter appended after an existing matching entry',
			fixture: {
				nixConf: 'substituters = https://both.invalid/\n',
				inlineConfig: 'extra-substituters = https://both.invalid/'
			}
		},
		{
			// Nix stores platforms and features as sets, so duplicates collapse.
			name: 'a platform and feature each repeated',
			fixture: {
				nixConf:
					'extra-platforms = riscv64-linux riscv64-linux\n' +
					'system-features = kvm kvm\n'
			}
		},
		{
			// A store reference can be a URI, a recognised store type, or a path.
			// Nix parses an unsupported URI scheme as a store reference and rejects
			// the scheme only when it opens the store. A path refers to a local
			// store rooted at that path, and both clients convert it to a `local://`
			// URI.
			name: 'substituters expressed as store types, URIs, and paths',
			fixture: {
				nixConf:
					'substituters = https://cache.invalid/ weird://elsewhere daemon ' +
					'auto local /var/cache/nix /var/cache/nix/ /var//cache///nix\n'
			}
		},
		{
			// Both sides resolve a relative path against the directory they run
			// in. Both run in the same directory here.
			name: 'substituters expressed as relative paths',
			fixture: {
				nixConf: 'substituters = ./cache ../cache cache/nix\n'
			}
		},
		{
			name: 'a store setting containing a path',
			fixture: { nixConf: 'store = /var/cache/nix\n' }
		},
		{
			// Nix reads an integer as a sign, digits and an optional binary unit,
			// in either case, so a count written with one resolves multiplied.
			name: 'counts written with binary units',
			fixture: {
				nixConf:
					'http-connections = 1K\n' +
					'download-attempts = 2k\n' +
					'stalled-download-timeout = 1M\n'
			}
		},
		{
			// The oracle returns JSON numbers, which cannot represent integers above
			// the safe integer range exactly. This case uses the largest value that
			// the setting accepts and JSON can represent exactly.
			name: 'the largest exactly representable count',
			fixture: { nixConf: 'download-attempts = 4294967295\n' }
		},
		{
			name: 'a count a unit multiplies past its width, which wraps',
			fixture: { nixConf: 'download-attempts = 4294967295K\n' }
		},
		{
			name: 'absolute paths for the netrc and certificate files',
			fixture: {
				nixConf:
					'netrc-file = /etc/nix/netrc\nssl-cert-file = /etc/ssl/ca.pem\n'
			}
		},
		{
			name: 'a configuration directory selected by NIX_CONF_DIR',
			fixture: {
				nixConf: 'substituters = https://relocated.invalid/\n',
				configDirectory: 'elsewhere'
			}
		},
		{
			name: 'a setting neither side knows',
			fixture: {
				nixConf:
					'no-such-setting = 1\nsubstituters = https://unknown.invalid/\n'
			}
		},
		{
			name: 'an optional include for a missing file',
			fixture: {
				nixConf:
					'!include /does/not/exist.conf\n' +
					'substituters = https://included.invalid/\n'
			}
		}
	])('resolves $name as Nix does', async ({ fixture }) => {
		const comparison = comparisonOf(await resolveFixture(oracle, fixture));

		expect(comparison.client).toStrictEqual(comparison.oracle);
	});

	// Exact: each spelling moves all four booleans off their defaults, so a
	// spelling either side read differently changes the resolved value.
	it.each(booleanSpellings)(
		'reads $affirmative and $negative as Nix does',
		async ({ affirmative, negative }) => {
			const comparison = comparisonOf(
				await resolveFixture(oracle, {
					nixConf:
						`always-allow-substitutes = ${affirmative}\n` +
						`fallback = ${affirmative}\n` +
						`substitute = ${negative}\n` +
						`require-sigs = ${negative}\n`
				})
			);

			expect(comparison.client).toStrictEqual(comparison.oracle);
		}
	);

	it.each<{ name: string; fixture: ConfigurationFixture }>([
		{
			name: 'an assignment with no value',
			fixture: { nixConf: 'substituters\n' }
		},
		{
			name: 'a line that is not an assignment at all',
			fixture: { nixConf: 'this line has no equals sign\n' }
		},
		{
			name: 'a boolean setting with an invalid value',
			fixture: { nixConf: 'substitute = maybe\n' }
		},
		{
			name: 'a numeric setting given a value that is not a number',
			fixture: { nixConf: 'http-connections = many\n' }
		},
		// Nix validates every known setting. Our client must therefore reject an
		// invalid value even when it does not otherwise use that setting.
		{
			name: 'an unused boolean setting with an invalid value',
			fixture: { nixConf: 'keep-outputs = maybe\n' }
		},
		{
			name: 'an enabled experimental boolean with an invalid value',
			fixture: {
				nixConf: 'experimental-features = flakes\naccept-flake-config = maybe\n'
			}
		},
		{
			name: 'an unused numeric setting with a non-numeric value',
			fixture: { nixConf: 'log-lines = many\n' }
		},
		// Some settings have constraints beyond their general value type. Nix
		// rejects values that do not satisfy those constraints.
		{
			name: 'a netrc file that is not an absolute path',
			fixture: { nixConf: 'netrc-file = netrc\n' }
		},
		{
			name: 'a certificate file that is not an absolute path',
			fixture: { nixConf: 'ssl-cert-file = certs/ca.pem\n' }
		},
		{
			name: 'a substituter that is not a store reference',
			fixture: { nixConf: 'substituters = notastore\n' }
		},
		{
			name: 'one invalid store reference among several substituters',
			fixture: {
				nixConf: 'substituters = https://ok.invalid/ notastore\n'
			}
		},
		{
			name: 'a trusted substituter that is not a store reference',
			fixture: { nixConf: 'trusted-substituters = notastore\n' }
		},
		{
			name: 'an include for a missing file',
			fixture: { nixConf: 'include /does/not/exist.conf\n' }
		},
		// Nix parses an integer using the width declared for the setting and
		// rejects values outside that range.
		{
			name: 'a count above the range declared for the setting',
			fixture: { nixConf: 'cores = 4294967296\n' }
		},
		{
			name: 'a count above that width even with a unit after it',
			fixture: { nixConf: 'cores = 4294967296K\n' }
		},
		{
			name: 'a negative value for an unsigned setting',
			fixture: { nixConf: 'http-connections = -1\n' }
		},
		{
			name: 'an unsupported unit',
			fixture: { nixConf: 'http-connections = 1P\n' }
		},
		{
			name: 'a unit set apart from its number',
			fixture: { nixConf: 'http-connections = 1 K\n' }
		}
	])('rejects $name as Nix does', async ({ fixture }) => {
		const acceptance = acceptanceOf(await resolveFixture(oracle, fixture));

		expect(acceptance).toStrictEqual({
			oracleAccepted: false,
			clientAccepted: false
		});
	});

	// Exact: Nix resolves a relative include from the directory containing the
	// configuration file. NIX_CONFIG is not a file, so it provides no base
	// directory and requires an absolute include path.
	it('rejects a relative include in NIX_CONFIG', async () => {
		const resolved = await resolveFixture(oracle, {
			nixConf: '',
			inlineConfig: 'include extra.conf'
		});

		expect({
			oracleAccepted: resolved.oracleAccepted,
			clientRefusal:
				resolved.clientError instanceof NixConfigIncludeError
					? resolved.clientError.reason
					: resolved.clientError
		}).toStrictEqual({
			oracleAccepted: false,
			clientRefusal: 'not-an-absolute-path'
		});
	});

	it('maps only settings reported by the oracle', async () => {
		const settings = settingsOf(await resolveFixture(oracle, { nixConf: '' }));

		expect(settingsMissingFromOracle(settings)).toStrictEqual([]);
	});

	it('reports the settings in scope that these groups leave unmodelled', async (context) => {
		const settings = settingsOf(await resolveFixture(oracle, { nixConf: '' }));
		const unmodelled = unmodelledSettings(settings);

		await context.annotate(
			unmodelled.join('\n'),
			'Settings not represented by the client'
		);

		expect(unmodelled).toStrictEqual(recordedUnmodelledSettings);
	});

	it('confirms that the renamed transfer settings remain absent', async () => {
		const settings = settingsOf(await resolveFixture(oracle, { nixConf: '' }));

		expect(
			settingsAbsentFromTheOracle.filter((setting) => settings.has(setting))
		).toStrictEqual([]);
	});

	// Nix derives the microarchitecture levels from the local CPU and reports
	// them only on x86_64 Linux. Other systems skip this comparison and include
	// the system in the reason. A Nix build without libcpuid can report an empty
	// list on x86_64 Linux.
	it('reports the same microarchitecture levels as Nix', async (context) => {
		if (oracle.system !== 'x86_64-linux') {
			context.skip(`Nix does not report CPU levels on ${oracle.system}`);
		}

		const platforms = comparisonOf(
			await resolveFixture(oracle, { nixConf: '' })
		);
		const stated = platforms.oracle['building.systems'];

		await context.annotate(
			JSON.stringify(stated),
			'Build systems reported by Nix'
		);

		expect(platforms.client['building.systems']).toStrictEqual(stated);
	});
});
