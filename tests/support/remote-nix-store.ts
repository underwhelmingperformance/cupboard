import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
	GenericContainer,
	type StartedTestContainer,
	Wait
} from 'testcontainers';

import { onceAsync } from './cleanup.ts';
import { runCommand } from './process.ts';

const fixtureDirectory = path.resolve('tests/fixtures/nix-ssh-store');
const sshPort = 22;
const ryukImage =
	'testcontainers/ryuk:0.14.0@sha256:7c1a8a9a47c780ed0f983770a662f80deb115d95cce3e2daa3d12115b8cd28f0';

export interface NixSshStoreFixture {
	readonly blockingStoreUri: string;
	readonly blockingTransportConfiguredStoreUri: string;
	readonly environment: { readonly NIX_SSHOPTS: string };
	readonly mismatchedHostKeyStoreUri: string;
	readonly storeUri: string;
	readonly transportConfiguredStoreUri: string;
	readonly transportInputs: {
		readonly privateKey: string;
		readonly knownHosts: string;
		readonly mismatchedKnownHosts: string;
	};
	close(): Promise<void>;
	exec(arguments_: readonly string[]): Promise<string>;
	waitForBlockingDaemonEvent(event: 'started' | 'stopped'): Promise<void>;
}

class FixtureEvent {
	private pending = 0;
	private readonly waiters: (() => void)[] = [];

	emit(): void {
		const waiter = this.waiters.shift();

		if (waiter !== undefined) {
			waiter();
			return;
		}

		this.pending += 1;
	}

	wait(): Promise<void> {
		if (this.pending > 0) {
			this.pending -= 1;
			return Promise.resolve();
		}

		return new Promise((resolve) => {
			this.waiters.push(resolve);
		});
	}
}

/**
 * Starts an isolated Nix store whose daemon is reachable only through a real
 * OpenSSH server. Testcontainers owns the image and container lifecycle; the
 * matching private key remains in the fixture workspace on the host.
 */
export async function startNixSshStore(): Promise<NixSshStoreFixture> {
	const workspace = await mkdtemp(path.join(tmpdir(), 'cupboard-nix-ssh-'));
	const identityFile = path.join(workspace, 'id_ed25519');
	const hostKeyFile = path.join(workspace, 'ssh_host_ed25519_key');
	let container: StartedTestContainer | undefined;
	const blockingEvents = {
		started: new FixtureEvent(),
		stopped: new FixtureEvent()
	};
	let logBuffer = '';
	const consumeLogs = (chunk: Buffer | string): void => {
		const text = chunk.toString();
		process.stderr.write(text);
		logBuffer += text;
		const lines = logBuffer.split('\n');
		logBuffer = lines.pop() ?? '';

		for (const line of lines) {
			if (line.includes('cupboard-blocking-daemon-started')) {
				blockingEvents.started.emit();
			}

			if (line.includes('cupboard-blocking-daemon-stopped')) {
				blockingEvents.stopped.emit();
			}
		}
	};

	const closeOnce = async (): Promise<void> => {
		try {
			await container?.stop({ remove: true, removeVolumes: true });
		} finally {
			await rm(workspace, { force: true, recursive: true });
		}
	};
	const close = onceAsync(closeOnce);

	try {
		await runCommand('ssh-keygen', [
			'-q',
			'-t',
			'ed25519',
			'-N',
			'',
			'-f',
			identityFile
		]);
		await runCommand('ssh-keygen', [
			'-q',
			'-t',
			'ed25519',
			'-N',
			'',
			'-f',
			hostKeyFile
		]);
		const publicKey = await readFile(`${identityFile}.pub`, 'utf8');
		const privateKey = await readFile(identityFile, 'utf8');
		const hostPrivateKey = await readFile(hostKeyFile);
		const hostPublicKeyFile = await readFile(`${hostKeyFile}.pub`, 'utf8');
		const hostPublicKey = hostPublicKeyFile.trim();
		const previousRyukImage = process.env.RYUK_CONTAINER_IMAGE;
		process.env.RYUK_CONTAINER_IMAGE = ryukImage;

		try {
			const image =
				await GenericContainer.fromDockerfile(fixtureDirectory).build();
			container = await image
				.withExposedPorts(sshPort)
				// Nix GC inspects process mappings and environments for runtime roots.
				// Give the fixture the same process view as a system Nix daemon.
				.withPrivilegedMode()
				.withLogConsumer((stream) => {
					stream.on('data', consumeLogs);
				})
				.withCopyContentToContainer([
					{
						content: publicKey,
						target: '/root/.ssh/authorized_keys',
						mode: 0o600
					},
					{
						content: hostPrivateKey,
						target: '/etc/ssh/ssh_host_ed25519_key',
						mode: 0o600
					},
					{
						content: `${hostPublicKey}\n`,
						target: '/etc/ssh/ssh_host_ed25519_key.pub',
						mode: 0o644
					}
				])
				.withWaitStrategy(Wait.forLogMessage(/Server listening on/u))
				.start();
		} finally {
			restoreRyukImage(previousRyukImage);
		}

		const runningContainer = container;
		const host = runningContainer.getHost();
		const port = runningContainer.getMappedPort(sshPort);
		const knownHostsFile = path.join(workspace, 'known_hosts');
		const knownHosts = `${knownHostsToken(host, port)} ${hostPublicKey}`;
		const mismatchedKnownHosts = `${knownHostsToken(host, port)} ${publicKey.trim()}`;
		await writeFile(knownHostsFile, `${knownHosts}\n`, { mode: 0o600 });
		const sshOptions = [
			'-i',
			identityFile,
			'-o',
			'BatchMode=yes',
			'-o',
			'StrictHostKeyChecking=yes',
			'-o',
			`UserKnownHostsFile=${knownHostsFile}`,
			'-o',
			'GlobalKnownHostsFile=/dev/null'
		];
		const storeUri = sshStoreUri(host, port, identityFile, hostPublicKey);
		const transportConfiguredStoreUri = sshStoreAuthority(host, port);
		const blockingStoreUri = sshStoreUri(
			host,
			port,
			identityFile,
			hostPublicKey,
			'/usr/local/bin/cupboard-blocking-daemon'
		);
		const blockingTransportConfiguredStoreUri =
			`${transportConfiguredStoreUri}?remote-program=` +
			encodeURIComponent('/usr/local/bin/cupboard-blocking-daemon');
		const mismatchedHostKeyStoreUri = sshStoreUri(
			host,
			port,
			identityFile,
			publicKey.trim()
		);
		const environment = { NIX_SSHOPTS: sshOptions.join(' ') };

		return {
			blockingStoreUri,
			blockingTransportConfiguredStoreUri,
			environment,
			mismatchedHostKeyStoreUri,
			storeUri,
			transportConfiguredStoreUri,
			transportInputs: { privateKey, knownHosts, mismatchedKnownHosts },
			close,
			exec: async (arguments_) =>
				containerCommand(runningContainer, arguments_),
			waitForBlockingDaemonEvent: (event) => blockingEvents[event].wait()
		};
	} catch (error) {
		await close();
		throw error;
	}
}

function sshStoreUri(
	host: string,
	port: number,
	identityFile: string,
	hostPublicKey: string,
	remoteProgram?: string
): string {
	return (
		sshStoreAuthority(host, port) +
		`?ssh-key=${encodeURIComponent(identityFile)}` +
		`&base64-ssh-public-host-key=${encodeURIComponent(Buffer.from(hostPublicKey).toString('base64'))}` +
		(remoteProgram === undefined
			? ''
			: `&remote-program=${encodeURIComponent(remoteProgram)}`)
	);
}

function sshStoreAuthority(host: string, port: number): string {
	return `ssh-ng://root@${authorityHost(host)}:${String(port)}`;
}

function restoreRyukImage(value: string | undefined): void {
	if (value === undefined) {
		delete process.env.RYUK_CONTAINER_IMAGE;
		return;
	}

	process.env.RYUK_CONTAINER_IMAGE = value;
}

function authorityHost(host: string): string {
	return host.includes(':') ? `[${host}]` : host;
}

function knownHostsToken(host: string, port: number): string {
	return port === sshPort ? host : `[${host}]:${String(port)}`;
}

async function containerCommand(
	container: StartedTestContainer,
	arguments_: readonly string[]
): Promise<string> {
	const result = await container.exec([...arguments_]);

	if (result.exitCode !== 0) {
		throw new Error(
			`Container command failed (${String(result.exitCode)}): ${arguments_.join(' ')}\n${result.stderr.trim()}`
		);
	}

	return result.stdout.trim();
}
