import { execFile } from 'node:child_process';
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const transportScript = new URL(
	'../actions/prepare/ssh-transport.sh',
	import.meta.url
);
const embeddedHostKey = Buffer.from('ssh-ed25519 AAAAC3NzaFixture').toString(
	'base64'
);
const home = process.env.HOME;

if (home === undefined) {
	throw new Error('HOME is required to test the generated Nix configuration');
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	const directories = [...temporaryDirectories];
	temporaryDirectories.length = 0;
	await Promise.all(
		directories.map((directory) =>
			rm(directory, { force: true, recursive: true })
		)
	);
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-ssh-'));
	temporaryDirectories.push(directory);

	return directory;
}

async function quotedRunnerTemporaryDirectory(): Promise<string> {
	const parent = await temporaryDirectory();
	const directory = path.join(
		parent,
		String.raw`runner temp 'single' "double" \slash`
	);
	await mkdir(directory);

	return directory;
}

function openSshWord(value: string): string {
	const backslash = String.fromCodePoint(0x5c);
	const escaped = value
		.split(backslash)
		.join(backslash.repeat(2))
		.split('"')
		.join(`${backslash}"`);

	return `"${escaped}"`;
}

interface TransportEnvironment {
	readonly inputSshKey?: string;
	readonly inputKnownHosts?: string;
	readonly remote?: string;
	readonly store?: string;
	readonly builders?: string;
	readonly builderSshKey?: string;
	readonly builderSshConfig?: string;
	readonly builderKnownHosts?: string;
	readonly storeSshKey?: string;
	readonly storeSshConfig?: string;
	readonly storeKnownHosts?: string;
	readonly storeAmbientIdentity?: string;
}

async function runTransport(
	command: 'configure' | 'configure-input' | 'validate',
	directory: string,
	inputs: TransportEnvironment
) {
	const githubEnvironment = path.join(directory, 'github-env');
	await writeFile(githubEnvironment, '');

	return execFileAsync('bash', [transportScript.pathname, command], {
		env: {
			...process.env,
			RUNNER_TEMP: directory,
			GITHUB_ENV: githubEnvironment,
			INPUT_SSH_KEY: inputs.inputSshKey ?? '',
			INPUT_KNOWN_HOSTS: inputs.inputKnownHosts ?? '',
			REMOTE: inputs.remote ?? 'false',
			STORE: inputs.store ?? '',
			BUILDERS: inputs.builders ?? '',
			BUILDER_SSH_KEY: inputs.builderSshKey ?? '',
			BUILDER_SSH_CONFIG: inputs.builderSshConfig ?? '',
			BUILDER_KNOWN_HOSTS: inputs.builderKnownHosts ?? '',
			STORE_SSH_KEY: inputs.storeSshKey ?? '',
			STORE_SSH_CONFIG: inputs.storeSshConfig ?? '',
			STORE_KNOWN_HOSTS: inputs.storeKnownHosts ?? '',
			STORE_AMBIENT_IDENTITY: inputs.storeAmbientIdentity ?? 'false'
		}
	});
}

async function transportFailure(
	command: 'configure' | 'configure-input' | 'validate',
	directory: string,
	inputs: TransportEnvironment
): Promise<string> {
	try {
		await runTransport(command, directory, inputs);
	} catch (error: unknown) {
		if (
			error instanceof Error &&
			'stdout' in error &&
			typeof error.stdout === 'string'
		) {
			return error.stdout;
		}

		throw error;
	}

	throw new Error('Expected the transport process to fail');
}

describe('prepare SSH transport implementation', () => {
	it.each([
		{
			name: 'a line feed',
			builders:
				'ssh-ng://nix@builder.example.com x86_64-linux - 1 1\n!include /tmp/injected.conf'
		},
		{
			name: 'a carriage return',
			builders:
				'ssh-ng://nix@builder.example.com x86_64-linux - 1 1\r!include /tmp/injected.conf'
		}
	])('rejects builders containing $name', async ({ builders }) => {
		const directory = await temporaryDirectory();
		const failure = await transportFailure('validate', directory, {
			remote: 'true',
			builders,
			builderKnownHosts: 'builder.example.com ssh-ed25519 AAAAC3NzaFixture'
		});

		expect(failure).toContain(
			'builders must not contain line breaks; separate inline builders with semicolons'
		);
	});

	it('preserves semicolon-separated inline builders', async () => {
		const directory = await temporaryDirectory();
		const builders =
			'ssh-ng://nix@first.example.com x86_64-linux - 1 1; ssh-ng://nix@second.example.com x86_64-linux - 1 1';

		await runTransport('configure', directory, {
			remote: 'true',
			builders,
			builderKnownHosts: [
				'first.example.com ssh-ed25519 AAAAC3NzaFirst',
				'second.example.com ssh-ed25519 AAAAC3NzaSecond'
			].join('\n')
		});

		await expect(
			readFile(path.join(directory, 'cupboard-prepare-nix.conf'), 'utf8')
		).resolves.toContain(`builders = ${builders}\n`);
	});

	it.each(
		[
			{ directive: 'IdentityFile', config: 'IdentityFile /tmp/unmanaged-key' },
			{ directive: 'IdentityAgent', config: 'IdentityAgent /tmp/agent.sock' },
			{
				directive: 'CertificateFile',
				config: 'CertificateFile /tmp/unmanaged-cert'
			},
			{
				directive: 'PKCS11Provider',
				config: 'PKCS11Provider /tmp/provider.so'
			},
			{
				directive: 'SecurityKeyProvider',
				config: 'SecurityKeyProvider /tmp/provider.so'
			},
			{ directive: 'AddKeysToAgent', config: 'AddKeysToAgent yes' },
			{ directive: 'ControlMaster', config: 'ControlMaster auto' },
			{
				directive: 'ControlPath',
				config: 'ControlPath /tmp/cupboard-control'
			},
			{ directive: 'ControlPersist', config: 'ControlPersist 5m' },
			{
				directive: 'Match exec',
				config: 'Match host store.example.com exec "true"'
			},
			{ directive: 'Include', config: 'Include /tmp/unmanaged.conf' }
		].flatMap(({ directive, config }) => [
			{
				name: `${directive} in direct-store configuration`,
				directive,
				inputs: {
					store: 'ssh-ng://nix@store.example.com',
					storeSshConfig: `Host store.example.com\n  ${config}`,
					storeKnownHosts: 'store.example.com ssh-ed25519 AAAAC3NzaFixture'
				} satisfies TransportEnvironment,
				inputName: 'store-ssh-config'
			},
			{
				name: `${directive} in builder configuration`,
				directive,
				inputs: {
					remote: 'true',
					builders: 'ssh-ng://nix@builder.example.com x86_64-linux - 1 1',
					builderSshConfig: `Host builder.example.com\n  ${config}`,
					builderKnownHosts: 'builder.example.com ssh-ed25519 AAAAC3NzaFixture'
				} satisfies TransportEnvironment,
				inputName: 'builder-ssh-config'
			}
		])
	)('rejects $name', async ({ directive, inputs, inputName }) => {
		const directory = await temporaryDirectory();
		const failure = await transportFailure('validate', directory, inputs);

		expect(failure).toContain(`${inputName} must not use ${directive}`);
	});

	it.each([
		{
			directive: 'IdentityFile',
			config: 'iDeNtItYfIlE=/tmp/unmanaged-key'
		},
		{
			directive: 'Match exec',
			config: 'mAtCh host store.example.com !ExEc="false"'
		},
		{
			directive: 'Match exec',
			config: 'Match host store.example.com "exec" "true"'
		},
		{
			directive: 'Match exec',
			config: 'Match host store.example.com e"x"e"c" "true"'
		},
		{
			directive: 'Match exec',
			config: '"Match" exec "true"'
		},
		{
			directive: 'Match exec',
			config: "'Match' exec 'true'"
		},
		{
			directive: 'ControlMaster',
			config: 'cOnTrOlMaStEr=auto'
		},
		{
			directive: 'ControlPath',
			config: 'cOnTrOlPaTh=/tmp/cupboard-control'
		},
		{
			directive: 'ControlPersist',
			config: 'cOnTrOlPeRsIsT=yes'
		},
		{ directive: 'Include', config: 'iNcLuDe=/tmp/unmanaged.conf' }
	])('rejects obscured $directive syntax', async ({ directive, config }) => {
		const directory = await temporaryDirectory();
		const failure = await transportFailure('validate', directory, {
			store: 'ssh-ng://nix@store.example.com',
			storeSshConfig: config,
			storeKnownHosts: 'store.example.com ssh-ed25519 AAAAC3NzaFixture'
		});

		expect(failure).toContain(`store-ssh-config must not use ${directive}`);
	});

	it('accepts non-identity proxy configuration', async () => {
		const directory = await temporaryDirectory();

		await expect(
			runTransport('validate', directory, {
				store: 'ssh-ng://nix@store.example.com',
				storeSshConfig: [
					'Host store.example.com',
					'  ProxyJump bastion.example.com',
					'Host bastion.example.com',
					'  ProxyCommand ssh -W %h:%p gateway.example.com'
				].join('\n'),
				storeKnownHosts: 'store.example.com ssh-ed25519 AAAAC3NzaFixture'
			})
		).resolves.toMatchObject({ stdout: '' });
	});

	it.each([
		{
			name: 'plain parameter name',
			store: 'ssh-ng://nix@store.example.com?ssh-key=%2Frun%2Fstore-key'
		},
		{
			name: 'percent-encoded parameter name',
			store: 'ssh-ng://nix@store.example.com?ssh%2Dkey=%2Frun%2Fstore-key'
		}
	])('rejects a direct-store identity in the $name', async ({ store }) => {
		const directory = await temporaryDirectory();
		const failure = await transportFailure('validate', directory, {
			store,
			storeKnownHosts: 'store.example.com ssh-ed25519 AAAAC3NzaFixture'
		});

		expect(failure).toContain(
			'the store URI must not set ssh-key; pass the private key through store-ssh-key'
		);
	});

	it.each([
		{
			name: 'machine SSH-key column',
			builders:
				'ssh://nix@safe-builder.example.com x86_64-linux - 1 1; ssh://nix@builder.example.com x86_64-linux /run/builder-key 1 1',
			error:
				'the builders machine SSH-key column must be -; pass the private key through builder-ssh-key'
		},
		{
			name: 'store URI parameter',
			builders:
				'ssh-ng://nix@builder.example.com?ssh-key=%2Frun%2Fbuilder-key x86_64-linux - 1 1',
			error:
				'a builder store URI must not set ssh-key; pass the private key through builder-ssh-key'
		},
		{
			name: 'external machine file',
			builders: '@/run/cupboard-builders',
			error:
				'builders must be supplied inline rather than through @file so the action can enforce builder-ssh-key identity isolation'
		}
	])('rejects a builder identity in the $name', async ({ builders, error }) => {
		const directory = await temporaryDirectory();
		const failure = await transportFailure('validate', directory, {
			remote: 'true',
			builders,
			builderKnownHosts: 'builder.example.com ssh-ed25519 AAAAC3NzaFixture'
		});

		expect(failure).toContain(error);
	});

	it('preserves non-identity store and builder options', async () => {
		const directory = await temporaryDirectory();
		const store = `ssh-ng://nix@store.example.com?remote-program=ssh-key&ssh-key=&base64-ssh-public-host-key=${embeddedHostKey}`;

		await expect(
			runTransport('validate', directory, { store })
		).resolves.toMatchObject({ stdout: '' });
		await expect(
			runTransport('validate', directory, {
				remote: 'true',
				builders: 'ssh://nix@builder.example.com x86_64-linux - 1 1 ssh-key -',
				builderKnownHosts: 'builder.example.com ssh-ed25519 AAAAC3NzaFixture'
			})
		).resolves.toMatchObject({ stdout: '' });
	});

	it.each([
		{
			name: 'implicit default port',
			store: `ssh-ng://nix@store.example.com?base64-ssh-public-host-key=${embeddedHostKey}`
		},
		{
			name: 'explicit default port',
			store: `ssh-ng://nix@store.example.com:22?base64-ssh-public-host-key=${embeddedHostKey}`
		},
		{
			name: 'implicit default port on IPv6',
			store: `ssh-ng://nix@[2001:db8::1]?base64-ssh-public-host-key=${embeddedHostKey}`
		},
		{
			name: 'explicit default port on IPv6',
			store: `ssh-ng://nix@[2001:db8::1]:22?base64-ssh-public-host-key=${embeddedHostKey}`
		}
	])('accepts an embedded host key on the $name', async ({ store }) => {
		const directory = await temporaryDirectory();

		await expect(
			runTransport('validate', directory, { store })
		).resolves.toMatchObject({ stdout: '' });
	});

	it('requires an OpenSSH known-hosts entry for a nonstandard port', async () => {
		const directory = await temporaryDirectory();
		const store = `ssh-ng://nix@store.example.com:2222?base64-ssh-public-host-key=${embeddedHostKey}`;
		let failure: unknown;

		try {
			await runTransport('validate', directory, { store });
		} catch (error: unknown) {
			failure = error;
		}

		if (
			!(failure instanceof Error) ||
			!('stdout' in failure) ||
			typeof failure.stdout !== 'string'
		) {
			throw new Error('Expected the transport process to fail with stdout');
		}

		expect(failure.stdout).toContain(
			'URI-only host-key pinning supports only the default SSH port'
		);
		await expect(
			runTransport('validate', directory, {
				store,
				storeKnownHosts: '[store.example.com]:2222 ssh-ed25519 AAAAC3NzaFixture'
			})
		).resolves.toMatchObject({ stdout: '' });
	});

	it('keeps URI-only host-key pinning on the default port despite caller config', async () => {
		const directory = await temporaryDirectory();
		const store = `ssh-ng://nix@store.example.com?base64-ssh-public-host-key=${embeddedHostKey}`;

		await runTransport('configure', directory, {
			store,
			storeSshConfig: 'Host store.example.com\n  Port 2222'
		});
		const { stdout } = await execFileAsync('ssh', [
			'-G',
			'-F',
			path.join(directory, 'cupboard_ssh_config'),
			'store.example.com'
		]);

		expect(stdout.split('\n').find((line) => line.startsWith('port '))).toBe(
			'port 22'
		);
	});

	it('generates the key, known-hosts file and authoritative OpenSSH policy it exports', async () => {
		const directory = await quotedRunnerTemporaryDirectory();
		const key =
			'-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----';
		const knownHost = '[store.example.com]:2222 ssh-ed25519 AAAAC3NzaFixture';

		await runTransport('configure', directory, {
			store: 'ssh-ng://nix@store.example.com:2222',
			storeSshKey: key,
			storeKnownHosts: knownHost,
			storeSshConfig: [
				'Host store.example.com',
				'  StrictHostKeyChecking no',
				'  UserKnownHostsFile /dev/null',
				'  GlobalKnownHostsFile /tmp/caller-known-hosts',
				'  KnownHostsCommand /bin/false',
				'  IdentitiesOnly no'
			].join('\n')
		});

		const config = path.join(directory, 'cupboard_ssh_config');
		const knownHosts = path.join(directory, 'cupboard_known_hosts');
		const knownHostsOption = `-oUserKnownHostsFile=${openSshWord(knownHosts)}`;
		const identity = path.join(directory, 'cupboard_store_key');
		const identityMetadata = await stat(identity);
		const githubEnvironment = await readFile(
			path.join(directory, 'github-env'),
			'utf8'
		);
		const nixSshOptions = await effectiveNixSshOptions(githubEnvironment);
		const { stdout } = await execFileAsync('ssh', [
			'-G',
			'-F',
			config,
			'store.example.com'
		]);
		const { stdout: uriOutput } = await execFileAsync('ssh', [
			'-G',
			...nixSshOptions,
			'-oUserKnownHostsFile=/tmp/nix-uri-known-hosts',
			'store.example.com'
		]);
		const effective = new Map(
			stdout
				.split('\n')
				.filter((line) => line !== '')
				.map((line) => {
					const separator = line.indexOf(' ');

					return [line.slice(0, separator), line.slice(separator + 1)] as const;
				})
		);
		const uriEffective = new Map(
			uriOutput
				.split('\n')
				.filter((line) => line !== '')
				.map((line) => {
					const separator = line.indexOf(' ');

					return [line.slice(0, separator), line.slice(separator + 1)] as const;
				})
		);

		expect({
			identity: await readFile(identity, 'utf8'),
			identityMode: identityMetadata.mode & 0o777,
			knownHosts: await readFile(knownHosts, 'utf8'),
			exported: githubEnvironment.split('\n').filter((line) => line !== ''),
			nixSshOptions,
			uriUserKnownHostsFile: uriEffective.get('userknownhostsfile'),
			batchMode: effective.get('batchmode'),
			strictHostKeyChecking: effective.get('stricthostkeychecking'),
			userKnownHostsFile: effective.get('userknownhostsfile'),
			globalKnownHostsFile: effective.get('globalknownhostsfile'),
			knownHostsCommand: effective.get('knownhostscommand'),
			identitiesOnly: effective.get('identitiesonly'),
			identityAgent: effective.get('identityagent'),
			identityFiles: effective.get('identityfile')
		}).toStrictEqual({
			identity: `${key}\n`,
			identityMode: 0o600,
			knownHosts: `${knownHost}\n`,
			exported: [
				`NIX_SSHOPTS='${knownHostsOption.replaceAll("'", String.raw`'\''`)}' -F '${config.replaceAll("'", String.raw`'\''`)}'`,
				`NIX_USER_CONF_FILES=${directory}/cupboard-prepare-nix.conf:${home}/.config/nix/nix.conf`
			],
			nixSshOptions: [knownHostsOption, '-F', config],
			uriUserKnownHostsFile: knownHosts,
			batchMode: 'yes',
			strictHostKeyChecking: 'true',
			userKnownHostsFile: knownHosts,
			globalKnownHostsFile: '/dev/null',
			knownHostsCommand: undefined,
			identitiesOnly: 'yes',
			identityAgent: 'none',
			identityFiles: identity
		});
	});

	it('exports an isolated pinned private-input command whose runner paths survive shell parsing', async () => {
		const directory = await quotedRunnerTemporaryDirectory();
		const privateKey =
			'-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----';
		const knownHost = 'input.example.com ssh-ed25519 AAAAC3NzaInputFixture';

		await runTransport('configure-input', directory, {
			inputSshKey: privateKey,
			inputKnownHosts: knownHost
		});

		const githubEnvironment = path.join(directory, 'github-env');
		const exported = await readFile(githubEnvironment, 'utf8');
		const command = exported
			.split('\n')
			.find((line) => line.startsWith('GIT_SSH_COMMAND='))
			?.slice('GIT_SSH_COMMAND='.length);

		if (command === undefined) {
			throw new Error('The prepare transport exported no GIT_SSH_COMMAND');
		}

		const { stdout } = await execFileAsync('bash', [
			'-c',
			String.raw`ssh() { printf '%s\n' "$@"; }; ${command} destination`
		]);
		const key = path.join(directory, 'cupboard_input_key');
		const knownHosts = path.join(directory, 'cupboard_input_known_hosts');
		const config = path.join(directory, 'cupboard_input_ssh_config');
		const keyMetadata = await stat(key);
		const knownHostsMetadata = await stat(knownHosts);
		const configMetadata = await stat(config);
		const { stdout: effectiveOutput } = await execFileAsync('ssh', [
			'-G',
			'-F',
			config,
			'input.example.com'
		]);
		const effective = new Map(
			effectiveOutput
				.split('\n')
				.filter((line) => line !== '')
				.map((line) => {
					const separator = line.indexOf(' ');

					return [line.slice(0, separator), line.slice(separator + 1)] as const;
				})
		);

		expect({
			arguments: stdout.trim().split('\n'),
			config: await readFile(config, 'utf8'),
			key: await readFile(key, 'utf8'),
			keyMode: keyMetadata.mode & 0o777,
			knownHosts: await readFile(knownHosts, 'utf8'),
			knownHostsMode: knownHostsMetadata.mode & 0o777,
			configMode: configMetadata.mode & 0o777,
			batchMode: effective.get('batchmode'),
			strictHostKeyChecking: effective.get('stricthostkeychecking'),
			userKnownHostsFile: effective.get('userknownhostsfile'),
			globalKnownHostsFile: effective.get('globalknownhostsfile'),
			knownHostsCommand: effective.get('knownhostscommand'),
			identitiesOnly: effective.get('identitiesonly'),
			identityFile: effective.get('identityfile')
		}).toStrictEqual({
			arguments: ['-F', config, 'destination'],
			config: [
				'Host *',
				'  BatchMode yes',
				'  StrictHostKeyChecking yes',
				`  UserKnownHostsFile ${openSshWord(knownHosts)}`,
				'  GlobalKnownHostsFile /dev/null',
				'  KnownHostsCommand none',
				`  IdentityFile ${openSshWord(key)}`,
				'  IdentityAgent none',
				'  IdentitiesOnly yes',
				''
			].join('\n'),
			key: `${privateKey}\n`,
			keyMode: 0o600,
			knownHosts: `${knownHost}\n`,
			knownHostsMode: 0o600,
			configMode: 0o600,
			batchMode: 'yes',
			strictHostKeyChecking: 'true',
			userKnownHostsFile: knownHosts,
			globalKnownHostsFile: '/dev/null',
			knownHostsCommand: undefined,
			identitiesOnly: 'yes',
			identityFile: key
		});
	});

	it('refuses a private-input key without pinned host-key evidence', async () => {
		const directory = await temporaryDirectory();
		let failure: unknown;

		try {
			await runTransport('configure-input', directory, {
				inputSshKey: 'private-key',
				inputKnownHosts: ' \n\t'
			});
		} catch (error: unknown) {
			failure = error;
		}

		if (
			!(failure instanceof Error) ||
			!('stdout' in failure) ||
			typeof failure.stdout !== 'string'
		) {
			throw new Error('Expected the transport process to fail with stdout');
		}

		expect(failure.stdout).toContain(
			'input-known-hosts is required when the private flake input SSH key is supplied'
		);
	});

	it('fails closed when a private-input key is withheld from a managed transport', async () => {
		const directory = await temporaryDirectory();
		const knownHost = 'input.example.com ssh-ed25519 AAAAC3NzaInputFixture';

		await runTransport('configure-input', directory, {
			inputKnownHosts: knownHost
		});

		const config = path.join(directory, 'cupboard_input_ssh_config');
		const { stdout } = await execFileAsync('ssh', [
			'-G',
			'-F',
			config,
			'input.example.com'
		]);
		const identityPolicy = stdout
			.split('\n')
			.filter((line) =>
				/^(identitiesonly|identityagent|identityfile) /.test(line)
			);

		expect({
			knownHosts: await readFile(
				path.join(directory, 'cupboard_input_known_hosts'),
				'utf8'
			),
			identityPolicy,
			exported: await readFile(path.join(directory, 'github-env'), 'utf8')
		}).toStrictEqual({
			knownHosts: `${knownHost}\n`,
			identityPolicy: [
				'identitiesonly yes',
				'identityagent none',
				'identityfile none'
			],
			exported: `GIT_SSH_COMMAND=ssh -F '${config}'\n`
		});
	});

	it('disables ambient private-input SSH when no credentials are supplied', async () => {
		const directory = await temporaryDirectory();

		await runTransport('configure-input', directory, {});

		const config = path.join(directory, 'cupboard_input_ssh_config');
		const { stdout } = await execFileAsync('ssh', [
			'-G',
			'-F',
			config,
			'input.example.com'
		]);
		const effective = new Map(
			stdout
				.split('\n')
				.filter((line) => line !== '')
				.map((line) => {
					const separator = line.indexOf(' ');

					return [line.slice(0, separator), line.slice(separator + 1)] as const;
				})
		);

		expect({
			knownHosts: await readFile(
				path.join(directory, 'cupboard_input_known_hosts'),
				'utf8'
			),
			identityAgent: effective.get('identityagent'),
			identityFile: effective.get('identityfile'),
			identitiesOnly: effective.get('identitiesonly'),
			strictHostKeyChecking: effective.get('stricthostkeychecking'),
			exported: await readFile(path.join(directory, 'github-env'), 'utf8')
		}).toStrictEqual({
			knownHosts: '\n',
			identityAgent: 'none',
			identityFile: 'none',
			identitiesOnly: 'yes',
			strictHostKeyChecking: 'true',
			exported: `GIT_SSH_COMMAND=ssh -F '${config}'\n`
		});
	});

	it.each([
		{
			name: 'store',
			inputs: {
				store: 'ssh-ng://nix@store.example.com:2222',
				storeKnownHosts:
					'[store.example.com]:2222 ssh-ed25519 AAAAC3NzaStoreFixture'
			}
		},
		{
			name: 'builder',
			inputs: {
				remote: 'true',
				builders: 'ssh-ng://nix@builder.example.com:2222',
				builderKnownHosts:
					'[builder.example.com]:2222 ssh-ed25519 AAAAC3NzaBuilderFixture'
			}
		}
	])(
		'fails closed when a managed $name key is withheld',
		async ({ inputs }) => {
			const directory = await temporaryDirectory();

			await runTransport('configure', directory, inputs);

			const config = path.join(directory, 'cupboard_ssh_config');
			const { stdout } = await execFileAsync('ssh', [
				'-G',
				'-F',
				config,
				'example.com'
			]);

			expect(
				stdout
					.split('\n')
					.filter((line) =>
						/^(identitiesonly|identityagent|identityfile) /.test(line)
					)
			).toStrictEqual([
				'identitiesonly yes',
				'identityagent none',
				'identityfile none'
			]);
		}
	);

	it('fails closed for a URI-pinned keyless store by default', async () => {
		const directory = await temporaryDirectory();

		await runTransport('configure', directory, {
			store: `ssh-ng://nix@store.example.com?base64-ssh-public-host-key=${embeddedHostKey}`
		});

		const config = path.join(directory, 'cupboard_ssh_config');
		const contents = await readFile(config, 'utf8');
		const { stdout } = await execFileAsync('ssh', [
			'-G',
			'-F',
			config,
			'store.example.com'
		]);

		expect(
			stdout
				.split('\n')
				.filter((line) =>
					/^(identitiesonly|identityagent|identityfile) /.test(line)
				)
		).toStrictEqual([
			'identitiesonly yes',
			'identityagent none',
			'identityfile none'
		]);
		expect(contents).toContain('  IdentityAgent none\n');
	});

	it('preserves ambient identities only when explicitly requested', async () => {
		const directory = await temporaryDirectory();

		await runTransport('configure', directory, {
			store: `ssh-ng://nix@store.example.com?base64-ssh-public-host-key=${embeddedHostKey}`,
			storeAmbientIdentity: 'true'
		});

		const config = path.join(directory, 'cupboard_ssh_config');
		const contents = await readFile(config, 'utf8');
		const { stdout } = await execFileAsync('ssh', [
			'-G',
			'-F',
			config,
			'store.example.com'
		]);

		expect({
			managedIdentityPolicy: contents
				.split('\n')
				.filter((line) => /Identity(File|Agent|iesOnly)/.test(line)),
			identitiesOnly: stdout
				.split('\n')
				.find((line) => line.startsWith('identitiesonly '))
		}).toStrictEqual({
			managedIdentityPolicy: [],
			identitiesOnly: 'identitiesonly no'
		});
	});

	it.each([
		{
			name: 'a non-boolean ambient-identity input',
			inputs: {
				store: 'ssh-ng://nix@store.example.com',
				storeKnownHosts: 'store.example.com ssh-ed25519 AAAAC3NzaFixture',
				storeAmbientIdentity: 'yes'
			},
			error: 'store-ambient-identity must be true or false'
		},
		{
			name: 'ambient identity without a direct store',
			inputs: { storeAmbientIdentity: 'true' },
			error: 'store-ambient-identity requires the store input'
		},
		{
			name: 'ambient identity alongside a managed store key',
			inputs: {
				store: 'ssh-ng://nix@store.example.com',
				storeKnownHosts: 'store.example.com ssh-ed25519 AAAAC3NzaFixture',
				storeSshKey: 'fixture-key',
				storeAmbientIdentity: 'true'
			},
			error:
				'store-ambient-identity and store-ssh-key select different identity modes and are mutually exclusive'
		}
	])('rejects $name', async ({ inputs, error }) => {
		const directory = await temporaryDirectory();
		const failure = await transportFailure('validate', directory, inputs);

		expect(failure).toContain(error);
	});

	it('keeps private-input and direct-store host pins and identities isolated', async () => {
		const directory = await temporaryDirectory();

		await runTransport('configure-input', directory, {
			inputSshKey: 'input-private-key',
			inputKnownHosts: 'input.example.com ssh-ed25519 AAAAC3NzaInputFixture'
		});
		await runTransport('configure', directory, {
			store: 'ssh-ng://nix@store.example.com',
			storeSshKey: 'store-private-key',
			storeKnownHosts: 'store.example.com ssh-ed25519 AAAAC3NzaStoreFixture'
		});

		const inputConfig = await readFile(
			path.join(directory, 'cupboard_input_ssh_config'),
			'utf8'
		);
		const storeConfig = await readFile(
			path.join(directory, 'cupboard_ssh_config'),
			'utf8'
		);

		expect({
			inputUsesInputIdentity: inputConfig.includes('cupboard_input_key'),
			inputUsesStoreIdentity: inputConfig.includes('cupboard_store_key'),
			inputUsesInputPins: inputConfig.includes('cupboard_input_known_hosts'),
			inputUsesStorePins: inputConfig.includes('cupboard_known_hosts'),
			storeUsesStoreIdentity: storeConfig.includes('cupboard_store_key'),
			storeUsesInputIdentity: storeConfig.includes('cupboard_input_key'),
			storeUsesStorePins: storeConfig.includes('cupboard_known_hosts'),
			storeUsesInputPins: storeConfig.includes('cupboard_input_known_hosts')
		}).toStrictEqual({
			inputUsesInputIdentity: true,
			inputUsesStoreIdentity: false,
			inputUsesInputPins: true,
			inputUsesStorePins: false,
			storeUsesStoreIdentity: true,
			storeUsesInputIdentity: false,
			storeUsesStorePins: true,
			storeUsesInputPins: false
		});
	});
});

async function effectiveNixSshOptions(
	githubEnvironment: string
): Promise<readonly string[]> {
	const options = githubEnvironment
		.split('\n')
		.find((line) => line.startsWith('NIX_SSHOPTS='))
		?.slice('NIX_SSHOPTS='.length);

	if (options === undefined) {
		throw new Error('The prepare transport exported no NIX_SSHOPTS');
	}

	const { stdout } = await execFileAsync('bash', [
		'-c',
		String.raw`printf '%s\n' ${options}`
	]);

	return stdout.trim().split('\n');
}
