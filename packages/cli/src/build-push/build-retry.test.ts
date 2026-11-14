import { Derivation } from '@cupboard/nix-store/derivation';
import { MalformedDerivationError } from '@cupboard/nix-store/errors';
import { describe, expect, it } from 'vitest';

import { canRetryBuild } from './build-retry.ts';

const sandboxed = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv';
const fixedOutput = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-src.drv';
const outputPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';

function buildStart(derivation: string, machine: string): string {
	return JSON.stringify({
		action: 'start',
		type: 105,
		fields: [derivation, machine, 1, 1]
	});
}

function builderFailure(derivation: string, note = ''): string {
	return JSON.stringify({
		action: 'msg',
		level: 0,
		msg: `error: Cannot build '${derivation}'.\nReason: builder failed with exit code 1.${note}`
	});
}

function message(text: string): string {
	return JSON.stringify({ action: 'msg', level: 0, msg: text });
}

// The form that a build through the daemon logs: only `msg`, with ANSI codes
// around the prefix and the arguments, and the lines after the first indented.
function failure(derivation: string, reason: string): string {
	const [first = '', ...rest] = reason.split('\n');

	return message(
		[
			`\u{1B}[31;1merror:\u{1B}[0m Cannot build '\u{1B}[35;1m${derivation}\u{1B}[0m'.`,
			`       Reason: \u{1B}[31;1m${first}\u{1B}[0m`,
			...rest.map((line) => `       ${line}`)
		].join('\n')
	);
}

function timedOut(): string {
	return JSON.stringify({
		action: 'msg',
		level: 0,
		msg: '\u{1B}[31;1merror:\u{1B}[0m timed out after 3600 seconds',
		raw_msg: 'timed out after 3600 seconds'
	});
}

const unreachableBuilder = message(
	"cannot build on 'ssh-ng://builder.example': failed to start SSH connection"
);

const noMachineFound = JSON.stringify({
	action: 'msg',
	level: 1,
	msg: `Failed to find a machine for remote build!\nderivation: ${sandboxed}\nrequired (system, features): (aarch64-linux, [])\n1 available machines:\n(systems, maxjobs, supportedFeatures, mandatoryFeatures)\n([x86_64-linux], 1, [], [])\n`
});

function notDeterministic(derivation: string): string {
	return JSON.stringify({
		action: 'msg',
		level: 0,
		raw_msg: `derivation '${derivation}' may not be deterministic: output "${outputPath}" differs`,
		msg: `error: derivation '${derivation}' may not be deterministic: output "${outputPath}" differs`
	});
}

const store = {
	readDerivation: (derivation: string) =>
		Promise.resolve(
			Derivation.parse(
				derivation === fixedOutput
					? `Derive([("out","${outputPath}","r:sha256","0f2s1n0i8g6b9a3c")],[],[],"aarch64-darwin","/bin/sh",[],[])`
					: `Derive([("out","${outputPath}","","")],[],[],"aarch64-darwin","/bin/sh",[],[])`
			)
		)
};

describe('canRetryBuild', () => {
	it.each([
		{
			name: 'a local builder failure of a sandboxed derivation',
			lines: [buildStart(sandboxed, ''), builderFailure(sandboxed)],
			expected: false
		},
		{
			name: 'a local builder failure of a fixed-output derivation',
			lines: [buildStart(fixedOutput, ''), builderFailure(fixedOutput)],
			expected: true
		},
		{
			name: 'a builder failure on a remote builder',
			lines: [
				buildStart(sandboxed, 'ssh://builder'),
				builderFailure(sandboxed)
			],
			expected: true
		},
		{
			name: 'a local builder failure that Nix attributes to a full disk',
			lines: [
				buildStart(sandboxed, ''),
				builderFailure(
					sandboxed,
					'\nnote: build failure may have been caused by lack of free disk space'
				)
			],
			expected: true
		},
		{
			name: 'a builder failure without build activity',
			lines: [builderFailure(sandboxed)],
			expected: true
		},
		{
			name: 'a failure without a builder message',
			lines: [buildStart(sandboxed, '')],
			expected: true
		},
		{
			name: 'a permanent failure alongside a transient one',
			lines: [
				buildStart(sandboxed, ''),
				buildStart(fixedOutput, ''),
				builderFailure(sandboxed),
				builderFailure(fixedOutput)
			],
			expected: true
		},
		{
			name: 'a non-deterministic rebuild',
			lines: [buildStart(sandboxed, ''), notDeterministic(sandboxed)],
			expected: false
		},
		{
			name: 'a non-deterministic rebuild of a fixed-output derivation',
			lines: [buildStart(fixedOutput, ''), notDeterministic(fixedOutput)],
			expected: false
		},
		{
			name: 'a non-deterministic rebuild alongside a transient failure',
			lines: [
				buildStart(sandboxed, ''),
				buildStart(fixedOutput, ''),
				notDeterministic(sandboxed),
				builderFailure(fixedOutput)
			],
			expected: false
		},
		{
			name: 'missing system features',
			lines: [
				failure(
					sandboxed,
					'missing system features\nRequired features: {kvm}\nAvailable features: {benchmark}'
				)
			],
			expected: false
		},
		{
			name: 'a platform mismatch',
			lines: [
				failure(
					sandboxed,
					"platform mismatch\nRequired system: 'riscv64-linux'\nCurrent system: 'aarch64-darwin'"
				)
			],
			expected: false
		},
		{
			name: 'missing system features that no remote builder provides',
			lines: [
				noMachineFound,
				failure(
					sandboxed,
					'missing system features\nRequired features: {kvm}\nAvailable features: {}'
				)
			],
			expected: false
		},
		{
			name: 'a platform mismatch after a remote builder could not be reached',
			lines: [
				unreachableBuilder,
				noMachineFound,
				failure(
					sandboxed,
					"platform mismatch\nRequired system: 'aarch64-linux'\nCurrent system: 'x86_64-linux'"
				)
			],
			expected: true
		},
		{
			name: 'missing system features after a remote builder could not be reached',
			lines: [
				unreachableBuilder,
				failure(
					sandboxed,
					'missing system features\nRequired features: {kvm}\nAvailable features: {}'
				)
			],
			expected: true
		},
		{
			name: 'disabled local builds after a remote builder could not be reached',
			lines: [
				unreachableBuilder,
				failure(sandboxed, 'local builds are disabled')
			],
			expected: true
		},
		{
			name: 'a timeout of a sandboxed derivation',
			lines: [buildStart(sandboxed, ''), timedOut()],
			expected: false
		},
		{
			name: 'a timeout of a fixed-output derivation',
			lines: [buildStart(fixedOutput, ''), timedOut()],
			expected: true
		},
		{
			name: 'a timeout after a sandboxed and a fixed-output derivation were built',
			lines: [
				buildStart(sandboxed, ''),
				buildStart(fixedOutput, ''),
				timedOut()
			],
			expected: true
		},
		{
			name: 'a timeout without a build activity',
			lines: [timedOut()],
			expected: false
		},
		{
			name: 'a timeout that the build hook reports for a sandboxed derivation',
			lines: [
				buildStart(sandboxed, 'ssh-ng://builder.example'),
				message(
					`build of '${sandboxed}' on 'ssh-ng://builder.example' failed: timed out after 3600 seconds`
				)
			],
			expected: false
		},
		{
			name: 'a timeout that the build hook reports for a fixed-output derivation',
			lines: [
				buildStart(fixedOutput, 'ssh-ng://builder.example'),
				message(
					`build of '${fixedOutput}' on 'ssh-ng://builder.example' failed: timed out after 3600 seconds`
				)
			],
			expected: true
		},
		{
			name: 'a builder that exceeded the log limit',
			lines: [
				buildStart(fixedOutput, ''),
				message(
					`error: building derivation '${fixedOutput}' killed after writing more than 67108864 bytes of log output`
				)
			],
			expected: false
		},
		{
			name: 'a fixed-output hash mismatch',
			lines: [
				buildStart(fixedOutput, ''),
				message(
					`error: hash mismatch in fixed-output derivation '${fixedOutput}':\n  specified: sha256-AAAA\n     got:    sha256-BBBB`
				)
			],
			expected: false
		},
		{
			name: 'a hash mismatch that the build hook reports for a remote machine',
			lines: [
				buildStart(fixedOutput, 'ssh-ng://builder.example'),
				message(
					`build of '${fixedOutput}' on 'ssh-ng://builder.example' failed: hash mismatch in fixed-output derivation '${fixedOutput}':\n  specified: sha256-AAAA\n     got:    sha256-BBBB`
				)
			],
			expected: false
		},
		{
			name: 'a fixed-output builder that produced no output',
			lines: [
				buildStart(fixedOutput, ''),
				message(
					`error: builder for '${fixedOutput}' failed to produce output path for output 'out' at '${outputPath}'`
				)
			],
			expected: false
		},
		{
			name: 'a failed dependency without a recorded cause',
			lines: [failure(sandboxed, '1 dependency failed')],
			expected: true
		},
		{
			name: 'a failed dependency whose own build failed permanently',
			lines: [
				buildStart(sandboxed, ''),
				builderFailure(sandboxed),
				failure(fixedOutput, '1 dependency failed')
			],
			expected: false
		},
		{
			name: 'a failed dependency whose own build failed transiently',
			lines: [
				buildStart(fixedOutput, ''),
				builderFailure(fixedOutput),
				failure(sandboxed, '1 dependency failed')
			],
			expected: true
		},
		{
			name: 'a builder log tail that quotes a timeout',
			lines: [
				buildStart(fixedOutput, ''),
				message(
					`error: Cannot build '${fixedOutput}'.\nReason: builder failed with exit code 1.\nOutput paths:\n  ${outputPath}\nLast 1 log lines:\n> curl: timed out after 30 seconds`
				)
			],
			expected: true
		}
	])('returns $expected after $name', async ({ lines, expected }) => {
		await expect(canRetryBuild(lines.join('\n'), store)).resolves.toBe(
			expected
		);
	});

	it.each([
		{ name: 'a missing derivation', error: new Error('not found') },
		{
			name: 'a derivation that cannot be parsed',
			error: new MalformedDerivationError('the outputs are not a list')
		}
	])(
		'returns true after a local builder failure of $name',
		async ({ error }) => {
			await expect(
				canRetryBuild(
					[buildStart(sandboxed, ''), builderFailure(sandboxed)].join('\n'),
					{ readDerivation: () => Promise.reject(error) }
				)
			).resolves.toBe(true);
		}
	);
});
