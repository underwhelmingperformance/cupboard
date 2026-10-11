# Pin the fixture's complete userspace, including Nix and OpenSSH, to the
# official multi-platform image manifest.
FROM nixos/nix:2.35.2@sha256:7a007c766426c1877758ddc5cb87a965ac131fc78c582ce0083d922d51ae945c

RUN cp /etc/passwd /tmp/passwd \
	&& cp /etc/group /tmp/group \
	&& cp /etc/shadow /tmp/shadow \
	&& grep -v '^root:' /tmp/shadow > /tmp/shadow-unlocked \
	&& printf '%s\n' 'root:x:1::::::' >> /tmp/shadow-unlocked \
	&& cp --remove-destination /tmp/passwd /etc/passwd \
	&& cp --remove-destination /tmp/group /etc/group \
	&& cp --remove-destination /tmp/shadow-unlocked /etc/shadow \
	&& printf '%s\n' \
		'experimental-features = nix-command flakes' \
		'sandbox = false' \
		> /tmp/nix.conf \
	&& cp --remove-destination /tmp/nix.conf /etc/nix/nix.conf \
	&& printf '%s\n' 'sshd:x:74:74:OpenSSH privilege separation:/var/empty:/bin/false' >> /etc/passwd \
	&& printf '%s\n' 'sshd:x:74:' >> /etc/group \
	&& mkdir -p \
		/root/.ssh \
		/run/sshd \
		/var/empty \
		/etc/ssh \
		/usr/bin \
		/usr/local/bin \
	&& chmod 0700 /root/.ssh \
	&& ln -s "$(command -v nix-daemon)" /usr/bin/nix-daemon \
	&& printf '%s\n' \
		'#!/bin/sh' \
		'cleanup() { printf "cupboard-blocking-daemon-stopped\\n" > /proc/1/fd/2; }' \
		'trap cleanup EXIT' \
		'trap "exit 0" HUP INT TERM' \
		'printf "cupboard-blocking-daemon-started\\n" > /proc/1/fd/2' \
		'while IFS= read -r _; do :; done' \
		> /usr/local/bin/cupboard-blocking-daemon \
	&& chmod 0755 /usr/local/bin/cupboard-blocking-daemon \
	&& printf '%s\n' \
		'HostKey /etc/ssh/ssh_host_ed25519_key' \
		'PermitRootLogin prohibit-password' \
		'PasswordAuthentication no' \
		'KbdInteractiveAuthentication no' \
		'AllowTcpForwarding no' \
		'X11Forwarding no' \
		> /etc/ssh/sshd_config

EXPOSE 22

ENTRYPOINT []

CMD ["/nix/var/nix/profiles/default/bin/sshd", "-D", "-e", "-f", "/etc/ssh/sshd_config"]
