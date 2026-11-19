# Foliome: controlled local access

This fork develops a trusted local application for controlled reading of a source in Chrome. Its kernel mediates preparation sessions, filters page snapshots, controls permitted reads, and records decisions. An owner interface and an isolated executor channel are included. The current implementation is an early local candidate, not a complete financial synchronization product.

The first-install command below prepares the local application, the system boundary, and a Codex sign-in for the local executor. End-to-end acceptance uses a synthetic source in the owner's session on the intended Mac. Failure and interruption cases run in tests or CI with synthetic state. Bank integrations, scheduled collection, transaction accounting, and the legacy dashboard are not part of the trusted application. The retained legacy source is not the trusted execution path; its standalone dashboard dependency manifests are not included.

## First install on macOS

Run this from the owner's administrator account in the Mac's local Terminal on Apple silicon. Use the reviewed command and the full 40-character Git commit SHA independently supplied by the release operator for the approved first release. Use that exact SHA on every retry. The release must have its version tag on that SHA and a successful release workflow for the tag. Stock Git must be available, Google Chrome must be installed, and the ChatGPT account or workspace must allow [Codex device-code sign-in](https://learn.chatgpt.com/docs/auth?surface=cli#login-on-headless-devices).

First installation replaces SSH configuration and managed authorization files, installs a packet-filter anchor and its startup job, and requires a compatible local executor account if one already exists. Before running the command, verify the existing account and SSH settings against the installer and record how to restore any affected local SSH configuration from the Mac's Terminal. After installation and reboot, verify the normal developer SSH connection and try controlled reading with the synthetic source.

Prepare `~/foliome-first-install.json` in the owner's private home with mode `0600`. Replace all illustrative values with the approved public key for the local `dev` account and the source settings supplied for this installation. An HTTPS synthetic fixture can supply the source. Keep passwords, tokens, and private SSH keys out of this file. The installed boundary supplies the executor UID.

```json
{
  "developerPublicKey": "ssh-ed25519 APPROVED_DEVELOPER_PUBLIC_KEY",
  "source": {
    "url": "https://fixture.example.invalid/start",
    "sessionId": "fixture-session",
    "sourceId": "fixture-source",
    "accessId": "fixture-access",
    "instruction": "Read the synthetic fixture."
  }
}
```

Replace `APPROVED_INITIAL_SHA` in the command below. Enter the administrator password at the Terminal prompt. Then open the official device sign-in link shown by Codex and complete sign-in in the browser. The command opens Foliome when sign-in succeeds.

```sh
/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C HOME=/dev/null \
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
  GIT_ALLOW_PROTOCOL=https /bin/sh -se -- 'APPROVED_INITIAL_SHA' "$HOME/foliome-first-install.json" <<'FOLIOME'
sha=$1
input=$2
case "$sha" in *[!0-9a-f]*|'') echo 'Use the approved 40-character SHA.' >&2; exit 1 ;; esac
[ "${#sha}" -eq 40 ] || { echo 'Use the approved 40-character SHA.' >&2; exit 1; }
umask 077
cd /
work=$(/usr/bin/mktemp -d /private/tmp/foliome-first.XXXXXXXX)
trap '/bin/rm -rf -- "$work"' 0
trap 'exit 1' HUP INT TERM
git_object_store() {
  /usr/bin/git --no-optional-locks --no-replace-objects -C "$work" \
    -c core.hooksPath=/dev/null -c protocol.allow=never -c protocol.https.allow=always \
    -c credential.helper= -c http.followRedirects=false -c http.sslVerify=true -c http.proxy= \
    -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=15 -c fetch.fsckObjects=true "$@"
}
git_object_store init --quiet --bare --template= --object-format=sha1
git_object_store fetch --quiet --no-tags --depth=1 --no-recurse-submodules \
  --no-auto-maintenance --no-write-fetch-head -- https://github.com/daniilmann/foliome.git "$sha"
git_object_store cat-file commit "$sha" > "$work/commit"
[ "$(git_object_store hash-object -t commit --stdin < "$work/commit")" = "$sha" ]
git_object_store fsck --strict --no-reflogs --no-dangling "$sha"
git_object_store ls-tree --full-tree -r -z "$sha" -- base/bootstrap-root.pl > "$work/entry"
blob=$(/usr/bin/perl -0777 -ne 'if (/\A100644 blob ([a-f0-9]{40})\tbase\/bootstrap-root\.pl\0\z/) { print $1 } else { exit 1 }' "$work/entry")
[ "${#blob}" -eq 40 ]
git_object_store cat-file blob "$blob" > "$work/bootstrap-root.pl"
[ "$(git_object_store hash-object -t blob --stdin < "$work/bootstrap-root.pl")" = "$blob" ]
/usr/bin/env -i /usr/bin/perl "$work/bootstrap-root.pl" --owner "$sha" "$input" "$work"
FOLIOME
```

The installer checks the approved Git objects before loading the installer and obtains a signed Node binary without npm. It prepares the owner stage, installs the exact approved dispatcher through one administrator authorization, and independently checks the release again under root. The first release's workflow and CI file hashes are recorded under root ownership.

If inputs or verification fail, check the approved SHA, the private file's format and permissions, and the release status. For a cancelled password prompt, interruption, or failed sign-in, rerun the same command with the same SHA and keys. If an installed dispatcher or existing keys differ, stop and report the error code to the release operator. A valid existing source configuration is preserved. If device sign-in is blocked, have the account or workspace enable it before retrying.

In Finder, open `~/Library/Application Support/Foliome/app/Система.app` to launch Foliome. To return to the previous release, hold Option (⌥) while opening **Система** and keep it held until the launcher dialog appears. Select **Вернуть и подтвердить** to confirm. The launcher asks for an administrator password only if the rollback changes system files.

You can also launch Foliome from Terminal. Add `--previous` to open the same rollback dialog.

```sh
"/Library/Application Support/Foliome/base/launch"
```

Development uses Node.js 26.13.1 and the locked dependencies: `npm ci --ignore-scripts`, followed by `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run test:stand`, and `npm run test:attacks`. The stand uses system Google Chrome and synthetic pages on macOS.

For the earlier project, see the [fixed upstream README](https://github.com/daniilmann/foliome/blob/a9a6d99e4cba4ac054e4ccbd7d3be7904ff053de/README.md), including its legacy setup, workflows, and documentation. Its attachments remain available at that revision: [icon](https://github.com/daniilmann/foliome/blob/a9a6d99e4cba4ac054e4ccbd7d3be7904ff053de/assets/leaf-icon.png), [architecture](https://github.com/daniilmann/foliome/blob/a9a6d99e4cba4ac054e4ccbd7d3be7904ff053de/docs/architecture-flow.png), [browser automation](https://github.com/daniilmann/foliome/blob/a9a6d99e4cba4ac054e4ccbd7d3be7904ff053de/docs/browser-automation.png), [comparison](https://github.com/daniilmann/foliome/blob/a9a6d99e4cba4ac054e4ccbd7d3be7904ff053de/docs/computer-use-comparison.png), [financial statement sample](https://github.com/daniilmann/foliome/blob/a9a6d99e4cba4ac054e4ccbd7d3be7904ff053de/docs/pfs-sample.pdf), and [statement sample](https://github.com/daniilmann/foliome/blob/a9a6d99e4cba4ac054e4ccbd7d3be7904ff053de/docs/statements-sample.pdf).
