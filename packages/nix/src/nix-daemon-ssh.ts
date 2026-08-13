import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { storeUriParameters } from './local-store-uri.ts';
import type { NixDaemonConnector } from './nix-daemon.ts';
import {
	createProcessNixDaemonConnector,
	type DaemonCommandRunner,
	spawnDaemonProcess
} from './nix-daemon-process.ts';
import { listOf } from './setting-types.ts';
import { isEnabledSettingValue } from './store-config.ts';

const sshNgScheme = 'ssh-ng://';
const defaultRemoteProgram = ['nix-daemon'] as const;

/** The remote daemon an `ssh-ng` store URI names. */
export interface NixSshStoreSpec {
	/** The ssh destination: `host` or `user@host`. */
	readonly destination: string;
	/** The host, without a user or port. */
	readonly host?: string;
	/** The SSH port stated by the authority. */
	readonly port?: number;
	/** The private key named by the store. */
	readonly sshKey?: string;
	/** The decoded public host key named by the store. */
	readonly sshPublicHostKey?: string;
	/** Whether SSH transport compression is enabled. */
	readonly compress?: boolean;
	/** The daemon command started on the remote host. */
	readonly remoteProgram?: readonly string[];
	/** The store reference the remote daemon opens. */
	readonly remoteStore?: string;
}

/**
 * The connection spec an `ssh-ng` store URI carries: the destination from
 * its authority and the daemon command from its `remote-program` query
 * parameter. `undefined` for any other URI, including an `ssh-ng` one with
 * no destination.
 */
export function parseSshNgStoreUri(uri: string): NixSshStoreSpec | undefined {
	if (!uri.startsWith(sshNgScheme)) {
		return undefined;
	}

	let parsed: URL;

	try {
		parsed = new URL(uri);
	} catch {
		return undefined;
	}

	if (parsed.hostname === '' || parsed.password !== '') {
		return undefined;
	}

	const user = decodeAuthorityPart(parsed.username);
	const decodedHost = decodeAuthorityPart(parsed.hostname);

	if (user === undefined || decodedHost === undefined) {
		return undefined;
	}

	const host = withoutIpv6Brackets(decodedHost);

	if (user.startsWith('-') || host.startsWith('-')) {
		return undefined;
	}

	const destination = user === '' ? host : `${user}@${host}`;

	const query = storeUriParameters(parsed.search.slice(1));
	const remoteProgramValue = query.get('remote-program');
	const remoteProgram =
		remoteProgramValue === undefined ? [] : listOf(remoteProgramValue);
	const remoteStore = query.get('remote-store');
	const sshKey = query.get('ssh-key');
	const encodedHostKey = query.get('base64-ssh-public-host-key');
	const sshPublicHostKey =
		encodedHostKey === undefined || encodedHostKey === ''
			? undefined
			: decodeHostKey(encodedHostKey);
	const compressValue = query.get('compress');
	const compress =
		compressValue === undefined
			? undefined
			: isEnabledSettingValue('compress', compressValue);
	const port = parsed.port === '' ? undefined : Number(parsed.port);

	if (
		sshPublicHostKey === undefined &&
		compress === undefined &&
		port === undefined &&
		remoteProgram.length === 0 &&
		(remoteStore === undefined || remoteStore === '') &&
		(sshKey === undefined || sshKey === '')
	) {
		return { destination, host };
	}

	return {
		destination,
		host,
		...(port !== undefined && { port }),
		...(sshKey !== undefined && sshKey !== '' && { sshKey }),
		...(sshPublicHostKey !== undefined && { sshPublicHostKey }),
		...(compress !== undefined && { compress }),
		...(remoteProgram.length > 0 && { remoteProgram }),
		...(remoteStore !== undefined && remoteStore !== '' && { remoteStore })
	};
}

function decodeAuthorityPart(value: string): string | undefined {
	try {
		return decodeURIComponent(value);
	} catch {
		return undefined;
	}
}

function withoutIpv6Brackets(host: string): string {
	return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

interface KnownHostsFile {
	readonly path: string;
	dispose(): void;
}

/** Process environment and filesystem seams used while opening SSH. */
export interface NixSshConnectorDependencies {
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly knownHostsFile?: (host: string, publicKey: string) => KnownHostsFile;
}

/**
 * A connector that reaches the daemon an `ssh-ng` store names: each
 * connection starts `ssh <destination> <remote-program> --stdio` and speaks
 * the worker protocol over the child's pipes.
 */
export function createSshNixDaemonConnector(
	spec: NixSshStoreSpec,
	run: DaemonCommandRunner = spawnDaemonProcess,
	dependencies: NixSshConnectorDependencies = {}
): NixDaemonConnector {
	const remoteProgram = spec.remoteProgram ?? defaultRemoteProgram;
	const remoteStoreArguments =
		spec.remoteStore === undefined ? [] : ['--store', spec.remoteStore];

	return (socketPath, signal) => {
		const sshOptions = shellSplit(
			(dependencies.env ?? process.env).NIX_SSHOPTS ?? ''
		);
		const knownHosts =
			spec.sshPublicHostKey === undefined
				? undefined
				: (dependencies.knownHostsFile ?? createKnownHostsFile)(
						knownHostsToken(spec),
						spec.sshPublicHostKey
					);
		const knownHostOptions =
			knownHosts === undefined
				? []
				: [
						`-oUserKnownHostsFile=${knownHosts.path}`,
						'-oStrictHostKeyChecking=yes',
						'-oGlobalKnownHostsFile=/dev/null'
					];
		const commandArguments = [
			spec.destination,
			'-x',
			...knownHostOptions,
			...sshOptions,
			...(spec.sshKey === undefined ? [] : ['-i', spec.sshKey]),
			...(spec.compress === true ? ['-C'] : []),
			...(spec.port === undefined ? [] : [`-p${String(spec.port)}`]),
			'--',
			...remoteProgram,
			...remoteStoreArguments,
			'--stdio'
		];

		try {
			return createProcessNixDaemonConnector(
				'ssh',
				commandArguments,
				run,
				() => {
					knownHosts?.dispose();
				}
			)(socketPath, signal);
		} catch (error) {
			knownHosts?.dispose();
			throw error;
		}
	};
}

function knownHostsToken(spec: NixSshStoreSpec): string {
	const host = spec.host ?? hostOf(spec.destination);

	return spec.port === undefined || spec.port === 22
		? host
		: `[${host}]:${String(spec.port)}`;
}

function hostOf(destination: string): string {
	return destination.slice(destination.lastIndexOf('@') + 1);
}

function decodeHostKey(encoded: string): string {
	const decoded = Buffer.from(encoded, 'base64');
	const canonicalInput = encoded.replace(/=+$/u, '');
	const canonicalDecoded = decoded.toString('base64').replace(/=+$/u, '');

	if (canonicalInput !== canonicalDecoded || decoded.length === 0) {
		throw new Error('base64-ssh-public-host-key is not valid base64');
	}

	return decoded.toString('utf8');
}

function createKnownHostsFile(host: string, publicKey: string): KnownHostsFile {
	const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-nix-ssh-'));
	const file = path.join(directory, 'host-key');
	writeFileSync(file, `${host} ${publicKey}\n`, { mode: 0o600 });

	return {
		path: file,
		dispose: () => {
			rmSync(directory, { recursive: true, force: true });
		}
	};
}

function shellSplit(source: string): readonly string[] {
	const words: string[] = [];
	let word = '';
	let quote: "'" | '"' | undefined;
	let isEscaping = false;
	let isStarted = false;

	for (const character of source) {
		if (isEscaping) {
			word +=
				quote === '"' && !['$', '`', '"', '\\'].includes(character)
					? `\\${character}`
					: character;
			isEscaping = false;
			isStarted = true;
			continue;
		}

		if (character === '\\' && quote !== "'") {
			isEscaping = true;
			isStarted = true;
			continue;
		}

		if (quote !== undefined) {
			if (character === quote) {
				quote = undefined;
				continue;
			}

			word += character;
			continue;
		}

		if (character === "'" || character === '"') {
			quote = character;
			isStarted = true;
			continue;
		}

		if (character === ' ' || character === '\t') {
			if (isStarted) {
				words.push(word);
				word = '';
				isStarted = false;
			}
			continue;
		}

		word += character;
		isStarted = true;
	}

	if (quote !== undefined) {
		throw new Error(`cannot split NIX_SSHOPTS: unfinished quote`);
	}

	if (isStarted) {
		words.push(word);
	}

	return words;
}
