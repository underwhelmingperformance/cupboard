#!/usr/bin/env bash
set -uo pipefail

if [[ ${RUNNER_DEBUG:-} != 1 ]]; then
	exit 0
fi

exec 1>&2
parent_pid=${1:-$$}
trap 'exit 0' INT TERM
journal_since=$(date -u +%FT%TZ)

while :; do
	printf '\n[evaluation resource-sample] %s\n' "$(date -u +%FT%TZ)"
	if [[ -r /proc/meminfo ]]; then
		awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/' /proc/meminfo
	fi
	for resource in /proc/pressure/memory /proc/pressure/cpu /proc/pressure/io; do
		if [[ -r $resource ]]; then
			printf '%s\n' "$resource"
			cat "$resource"
		fi
	done
	if [[ -r /proc/${parent_pid}/cgroup ]]; then
		group=$(awk -F: '$1 == "0" {print $3}' "/proc/${parent_pid}/cgroup")
		for resource in memory.current memory.peak memory.max memory.events; do
			file="/sys/fs/cgroup${group}/${resource}"
			if [[ -r $file ]]; then
				printf '%s\n' "$file"
				cat "$file"
			fi
		done
	fi
	df -Pk / /nix
	printf 'PID PPID RSS %%CPU COMMAND\n'
	ps -axo pid=,ppid=,rss=,pcpu=,comm= | sort -k3,3nr | head -n 20

	if [[ $parent_pid != --once ]] && [[ $(uname -s) == Linux ]]; then
		next_since=$(date -u +%FT%TZ)
		sudo -n journalctl --since "$journal_since" --no-pager --output=short-iso \
			_TRANSPORT=kernel + _SYSTEMD_UNIT=systemd-oomd.service 2>/dev/null || true
		journal_since=$next_since
	fi

	if [[ $parent_pid == --once ]] || ! kill -0 "$parent_pid" 2>/dev/null; then
		exit 0
	fi
	sleep 5
done
