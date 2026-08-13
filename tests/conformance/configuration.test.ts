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
 * rather than passing over them, and asserting the list keeps a setting from
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
	'# the line below names one more\n' +
	'ssh://builder-three aarch64-darwin\n';

describeConformance('the resolved Nix configuration', (oracle) => {
	// Exact: both sides resolve one fixture, and every field the adapter table
	// maps has to come out the same.
	it.each<{ name: string; fixture: ConfigurationFixture }>([
		{
			name: 'a configuration that assigns nothing',
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
			name: 'further platforms appended to the ones this machine runs',
			fixture: { nixConf: 'extra-extra-platforms = riscv64-linux\n' }
		},
		{
			name: 'builders written out in full',
			fixture: {
				nixConf: 'builders = ssh://only-builder aarch64-darwin\n'
			}
		},
		{
			name: 'builders named by a machines file',
			fixture: { nixConf: '', machines: machinesFile }
		},
		{
			name: 'transfer settings counted in the units Nix counts them in',
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
			// Nix holds these as lists rather than sets, so an entry stated
			// twice is held twice and the resolved value says so.
			name: 'a substituter and a trusted key each stated twice',
			fixture: {
				nixConf:
					'substituters = https://twice.invalid/ https://once.invalid/ https://twice.invalid/\n' +
					'trusted-public-keys = twice-1:AAA= once-1:BBB= twice-1:AAA=\n'
			}
		},
		{
			name: 'a substituter appended over one the list already names',
			fixture: {
				nixConf: 'substituters = https://both.invalid/\n',
				inlineConfig: 'extra-substituters = https://both.invalid/'
			}
		},
		{
			// The platforms and the features Nix does hold as sets, so the same
			// document states one of each however often it names them.
			name: 'a platform and a feature each stated twice',
			fixture: {
				nixConf:
					'extra-platforms = riscv64-linux riscv64-linux\n' +
					'system-features = kvm kvm\n'
			}
		},
		{
			// A store reference is a URI, a name nix has for a store, or a path
			// to one. A scheme nix has no store for is read all the same: what
			// refuses that is opening the store, not reading the setting. A path
			// names a local store rooted there, and both sides resolve it to
			// that store's `local://` URI.
			name: 'substituters named every way a store URI can be named',
			fixture: {
				nixConf:
					'substituters = https://cache.invalid/ weird://elsewhere daemon ' +
					'auto local /var/cache/nix /var/cache/nix/ /var//cache///nix\n'
			}
		},
		{
			// Both sides resolve a relative path against the directory they run
			// in. Both run in the same directory here.
			name: 'substituters named by relative paths',
			fixture: {
				nixConf: 'substituters = ./cache ../cache cache/nix\n'
			}
		},
		{
			name: 'a store setting naming a path',
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
			// The comparison reads the oracle's answer from JSON, which carries no
			// count past the range a number states exactly, so the widths compared
			// here are the ones that fit.
			name: 'the widest counts the compared settings hold',
			fixture: { nixConf: 'download-attempts = 4294967295\n' }
		},
		{
			name: 'a count a unit multiplies past its width, which wraps',
			fixture: { nixConf: 'download-attempts = 4294967295K\n' }
		},
		{
			name: 'a netrc file and a certificate named by absolute paths',
			fixture: {
				nixConf:
					'netrc-file = /etc/nix/netrc\nssl-cert-file = /etc/ssl/ca.pem\n'
			}
		},
		{
			name: 'a configuration directory NIX_CONF_DIR moved',
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
			name: 'an optional include naming nothing',
			fixture: {
				nixConf:
					'!include /does/not/exist.conf\n' +
					'substituters = https://included.invalid/\n'
			}
		}
	])('resolves $name the way nix does', async ({ fixture }) => {
		const comparison = comparisonOf(await resolveFixture(oracle, fixture));

		expect(comparison.client).toStrictEqual(comparison.oracle);
	});

	// Exact: each spelling moves all four booleans off their defaults, so a
	// spelling either side read differently changes the resolved value.
	it.each(booleanSpellings)(
		'reads $affirmative and $negative as nix reads them',
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
			name: 'a line carrying no value',
			fixture: { nixConf: 'substituters\n' }
		},
		{
			name: 'a line that is not an assignment at all',
			fixture: { nixConf: 'this line has no equals sign\n' }
		},
		{
			name: 'a boolean setting given a value that spells neither',
			fixture: { nixConf: 'substitute = maybe\n' }
		},
		{
			name: 'a numeric setting given a value that is not a number',
			fixture: { nixConf: 'http-connections = many\n' }
		},
		// Nix refuses a configuration over any setting it knows, so a value it
		// refuses is refused whether or not this client reads that setting for
		// anything of its own.
		{
			name: 'a boolean it reads for nothing given a value spelling neither',
			fixture: { nixConf: 'keep-outputs = maybe\n' }
		},
		{
			name: 'a numeric setting it reads for nothing given a word',
			fixture: { nixConf: 'log-lines = many\n' }
		},
		// Nix reads a few settings by a shape their kind of value does not
		// carry, and refuses a configuration stating one any other way.
		{
			name: 'a netrc file that is not an absolute path',
			fixture: { nixConf: 'netrc-file = netrc\n' }
		},
		{
			name: 'a certificate file that is not an absolute path',
			fixture: { nixConf: 'ssl-cert-file = certs/ca.pem\n' }
		},
		{
			name: 'a substituter naming no store',
			fixture: { nixConf: 'substituters = notastore\n' }
		},
		{
			name: 'one substituter of several naming no store',
			fixture: {
				nixConf: 'substituters = https://ok.invalid/ notastore\n'
			}
		},
		{
			name: 'a trusted substituter naming no store',
			fixture: { nixConf: 'trusted-substituters = notastore\n' }
		},
		{
			name: 'an include naming a file that does not exist',
			fixture: { nixConf: 'include /does/not/exist.conf\n' }
		},
		// Nix reads an integer into the width it declared the setting with, and
		// refuses a value that width could not hold.
		{
			name: 'a count above the width nix declared for the setting',
			fixture: { nixConf: 'cores = 4294967296\n' }
		},
		{
			name: 'a count above that width even with a unit after it',
			fixture: { nixConf: 'cores = 4294967296K\n' }
		},
		{
			name: 'a negative for a setting nix counts unsigned',
			fixture: { nixConf: 'http-connections = -1\n' }
		},
		{
			name: 'a unit nix has none of',
			fixture: { nixConf: 'http-connections = 1P\n' }
		},
		{
			name: 'a unit set apart from its number',
			fixture: { nixConf: 'http-connections = 1 K\n' }
		}
	])('refuses $name the way nix does', async ({ fixture }) => {
		const acceptance = acceptanceOf(await resolveFixture(oracle, fixture));

		expect(acceptance).toStrictEqual({
			oracleAccepted: false,
			clientAccepted: false
		});
	});

	// Exact: nix joins a relative include onto the directory of the file the
	// line was written in and then requires an absolute path. NIX_CONFIG is a
	// value rather than a file, so the refusal is about the path itself and
	// stands whatever the working directory happens to hold.
	it('refuses a relative include written in NIX_CONFIG over the path itself', async () => {
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

	it('maps every setting it claims onto one the oracle reports', async () => {
		const settings = settingsOf(await resolveFixture(oracle, { nixConf: '' }));

		expect(settingsMissingFromOracle(settings)).toStrictEqual([]);
	});

	it('reports the settings in scope that these groups leave unmodelled', async (context) => {
		const settings = settingsOf(await resolveFixture(oracle, { nixConf: '' }));
		const unmodelled = unmodelledSettings(settings);

		await context.annotate(unmodelled.join('\n'), 'unmodelled settings');

		expect(unmodelled).toStrictEqual(recordedUnmodelledSettings);
	});

	it('finds the transfer settings it holds fields for still absent', async () => {
		const settings = settingsOf(await resolveFixture(oracle, { nixConf: '' }));

		expect(
			settingsAbsentFromTheOracle.filter((setting) => settings.has(setting))
		).toStrictEqual([]);
	});

	// The microarchitecture levels come from this machine's own CPU, so only an
	// x86-64 Linux machine states any and only there does comparing the
	// platforms police how they are derived. Elsewhere the case reports what
	// ruled it out rather than passing on a comparison it never made. Nix
	// states levels only when it was built against libcpuid, so a run naming
	// none on such a machine says how this oracle was built.
	it('states the microarchitecture levels nix states', async (context) => {
		if (process.platform !== 'linux' || process.arch !== 'x64') {
			context.skip(`${process.platform}/${process.arch} states no levels`);
		}

		const platforms = comparisonOf(
			await resolveFixture(oracle, { nixConf: '' })
		);
		const stated = platforms.oracle['building.systems'];

		await context.annotate(JSON.stringify(stated), 'the platforms nix named');

		expect(platforms.client['building.systems']).toStrictEqual(stated);
	});
});
