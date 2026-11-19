use strict;
use warnings;
use Fcntl qw(:flock O_CREAT O_DIRECTORY O_NOFOLLOW O_NONBLOCK O_RDONLY O_RDWR O_EXCL O_WRONLY);
use POSIX ();
use Digest::SHA qw(sha1_hex);
use File::Path qw(remove_tree);
use File::Temp qw(tempdir);
use IO::Handle ();
use JSON::PP qw(decode_json);

# Trust entry provisioned by the administrator independently of the release.
# Run with stock Perl, an empty environment and exactly the approved Git SHA.
my $root = '/Library/Application Support/Foliome';
my $base = "$root/base";
my $node = "$base/node";
my $entry = "$base/install-root.js";
my ($sha) = @ARGV;
my ($real_group) = split ' ', $(;
my ($effective_group) = split ' ', $);
$^O eq 'darwin' && $< == 0 && $> == 0 && $real_group == 0 && $effective_group == 0 &&
  $0 eq "$root/bootstrap-root.pl" && @ARGV == 1 && $sha =~ /\A[a-f0-9]{40}\z/ &&
  !keys(%ENV) or exit 1;
umask 0077;
chdir '/' or exit 1;
opendir(my $fds, '/dev/fd') or exit 1;
my @descriptors = grep { /\A[0-9]+\z/ && $_ > 2 } readdir($fds);
closedir($fds) or exit 1;
POSIX::close($_) for @descriptors;
open(my $report, '>&', \*STDERR) or exit 1;
open(STDIN, '<', '/dev/null') or exit 1;
open(STDOUT, '>', '/dev/null') or exit 1;
open(STDERR, '>', '/dev/null') or exit 1;

sub refuse { die "install-bootstrap\n"; }

sub info {
  my ($file, $expected, $directory) = @_;
  my @s = lstat($file);
  @s && ($directory ? -d _ : (-f _ && $s[3] == 1)) &&
    $s[4] == 0 && $s[5] == 0 && ($s[2] & 07777) == $expected or refuse();
}

sub command {
  my $status = system {$_[0]} @_;
  $status == 0 or refuse();
}

sub capture {
  my ($limit, @args) = @_;
  open(my $child, '-|', @args) or refuse();
  binmode($child);
  my $bytes = '';
  while (1) {
    my $n = sysread($child, my $chunk, 65536);
    defined($n) or refuse();
    last unless $n;
    $bytes .= $chunk;
    length($bytes) <= $limit or refuse();
  }
  close($child) or refuse();
  return $bytes;
}

sub exclusive_write {
  my ($file, $bytes) = @_;
  sysopen(my $out, $file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600) or refuse();
  binmode($out);
  print $out $bytes or refuse();
  $out->sync() or refuse();
  close($out) or refuse();
}

sub sync_directory {
  my ($dir) = @_;
  sysopen(my $handle, $dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) or refuse();
  $handle->sync() or refuse();
  close($handle) or refuse();
}

sub sha256_file {
  my ($file, $limit) = @_;
  sysopen(my $handle, $file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) or refuse();
  my @s = stat($handle);
  @s && -f $handle && $s[3] == 1 && $s[7] > 0 && $s[7] <= $limit or refuse();
  binmode($handle);
  my $digest = Digest::SHA->new(256)->addfile($handle)->hexdigest;
  close($handle) or refuse();
  return $digest;
}

sub signed_node {
  my ($file) = @_;
  command('/usr/bin/codesign', '--verify', '--strict', '--check-notarization', '-R',
    '=anchor apple generic and identifier "node" and certificate leaf[subject.OU] = "HX7739G8FX"', $file);
  command('/usr/sbin/spctl', '-a', '-t', 'install', '--ignore-cache', '--no-cache', $file);
}

for my $dir ('/', '/Library', '/Library/Application Support', $root) {
  my @s = lstat($dir);
  @s && -d _ && $s[4] == 0 && ($s[2] & 07022) == 0 or refuse();
  my (undef, @acl) = split /\n/, capture(8192, '/bin/ls', '-lde', $dir);
  !grep { $_ !~ /\A\s*\d+: group:everyone deny delete\z/ } @acl or refuse();
}
info($root, 0755, 1);
info($0, 0644, 0);
my $lease = "$root/.bootstrap.lock";
sysopen(my $lock, $lease, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0600) or refuse();
info($lease, 0600, 0);
flock($lock, LOCK_EX | LOCK_NB) or refuse();

sub previous_base {
  my $admin = "$root/.install";
  if (!lstat($admin)) { $!{ENOENT} or refuse(); return; }
  info($admin, 0700, 1);
  my $writer = "$admin/install.lease.sqlite";
  if (lstat($writer)) {
    info($writer, 0600, 0);
    command('/usr/bin/sqlite3', '-batch', '-init', '/dev/null', $writer, 'BEGIN EXCLUSIVE; ROLLBACK;');
  } else { $!{ENOENT} or refuse(); }
  my $record = "$admin/pending.json";
  my @s = lstat($record);
  if (!@s) { $!{ENOENT} or refuse(); return; }
  info($record, 0600, 0);
  $s[7] <= 1048576 or refuse();
  open(my $reader, '<', $record) or refuse();
  local $/;
  my $journal = decode_json(<$reader>);
  close($reader) or refuse();
  ref($journal->{operations}) eq 'ARRAY' && JSON::PP::is_bool($journal->{committed}) or refuse();
  my @swaps = grep { $_->{target} eq $base } @{$journal->{operations}};
  return unless @swaps;
  @swaps == 1 or refuse();
  my ($operation) = @swaps;
  $operation->{tree} && $operation->{directory} && $operation->{token} =~ /\A[a-f0-9]{32}\z/ or refuse();
  my $prefix = "$root/.foliome-install-$operation->{token}";
  my ($backup, $staged) = ("$prefix.old", "$prefix.new");
  my $matches = sub {
    my ($dir, $expected) = @_;
    info($dir, 0755, 1);
    my @state = lstat($dir);
    ref($expected) eq 'ARRAY' && @$expected == 2 &&
      $state[0] == $expected->[0] && $state[1] == $expected->[1] or refuse();
  };
  if ($journal->{committed}) { $matches->($base, $operation->{after}); return; }
  if (!lstat($backup)) {
    $!{ENOENT} or refuse();
    $matches->($base, $operation->{before});
    return;
  }
  $matches->($backup, $operation->{before});
  if (lstat($base)) {
    $matches->($base, $operation->{after});
    !lstat($staged) && $!{ENOENT} or refuse();
    rename($base, $staged) or refuse();
  } else { $!{ENOENT} or refuse(); }
  rename($backup, $base) or refuse();
  sync_directory($root);
}

my @modules = qw(
  activation-state.js install-owner.js install-platform.js install-production.js
  install-root.js install-transaction.js launch launcher.js publisher-verification.js
  read-release-file.pl release-materialization.js release-observation.js release-origin.js
  release-pipeline.js system-install-layout.js
);

sub boot {
  # This bare object store is new, root-private, has no refs supplied by the
  # caller, and is never populated by an owner's Git repository.
  my $scratch = tempdir('.bootstrap-XXXXXXXX', DIR => $root, CLEANUP => 1);
  info($scratch, 0700, 1);
  my $repo = "$scratch/git";
  mkdir($repo, 0700) or refuse();
  my @git = ('/usr/bin/git', '--no-optional-locks', '--no-replace-objects', '-C', $repo,
    '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always', '-c', 'credential.helper=',
    '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true', '-c', 'http.proxy=',
    '-c', 'http.lowSpeedLimit=1024', '-c', 'http.lowSpeedTime=15', '-c', 'fetch.fsckObjects=true');
  my $new = "$scratch/base";
  mkdir($new, 0700) or refuse();
  {
    local %ENV = (PATH => '/usr/bin:/bin', HOME => '/dev/null', LC_ALL => 'C',
      GIT_CONFIG_NOSYSTEM => '1', GIT_CONFIG_GLOBAL => '/dev/null',
      GIT_TERMINAL_PROMPT => '0', GIT_ALLOW_PROTOCOL => 'https');
    command(@git, 'init', '--bare', '--template=', '--object-format=sha1');
    command(@git, 'fetch', '--no-tags', '--depth=1', '--no-recurse-submodules',
      '--no-auto-maintenance', '--no-write-fetch-head', '--',
      'https://github.com/daniilmann/foliome.git', $sha);
    my $commit = capture(1048576, @git, 'cat-file', 'commit', $sha);
    sha1_hex('commit ' . length($commit) . "\0" . $commit) eq $sha or refuse();
    command(@git, 'fsck', '--strict', '--no-reflogs', '--no-dangling', $sha);

    my $blob = sub {
      my ($name) = @_;
      my $record = capture(4096, @git, 'ls-tree', '--full-tree', '-r', '-z', $sha, '--', $name);
      $record =~ /\A100644 blob ([a-f0-9]{40})\t\Q$name\E\0\z/ or refuse();
      my $hash = $1;
      my $bytes = capture(8 * 1024 * 1024, @git, 'cat-file', 'blob', $hash);
      sha1_hex('blob ' . length($bytes) . "\0" . $bytes) eq $hash or refuse();
      return $bytes;
    };
    my $approvedBootstrap = $blob->('base/bootstrap-root.pl');
    open(my $self, '<', $0) or refuse();
    binmode($self);
    local $/;
    my $selfBytes = <$self>;
    close($self) or refuse();
    $selfBytes eq $approvedBootstrap or refuse();
    for my $module (@modules) {
      exclusive_write("$new/$module", $blob->("base/$module"));
      chmod($module eq 'launch' ? 0755 : 0644, "$new/$module") == 1 or refuse();
    }
    exclusive_write("$new/release-policy.ts", $blob->('core/domain/release.ts'));
    chmod(0644, "$new/release-policy.ts") == 1 or refuse();
    my $manifest = decode_json($blob->('release/manifest.json'));
    my $runtime = $manifest->{node};
    $manifest->{schema} eq 'foliome-release/1' && $runtime->{version} eq '26.13.1' &&
      $runtime->{sha256} =~ /\A[a-f0-9]{64}\z/ or refuse();
    my $version = $runtime->{version};
    my $archive = "$scratch/node.tar.gz";
    command('/usr/bin/curl', '-q', '--proto', '=https', '--max-time', '120',
      '--connect-timeout', '15', '--max-filesize', '134217728', '--fail', '--silent',
      '--output', $archive, "https://nodejs.org/dist/v$version/node-v$version-darwin-arm64.tar.gz");
    sha256_file($archive, 134217728) eq $runtime->{sha256} or refuse();
    my $member = "node-v$version-darwin-arm64/bin/node";
    my $contents = capture(4096, '/usr/bin/tar', '-tvzf', $archive, '--', $member);
    $contents =~ /\A-[rwxstST-]{9}\s[^\r\n]* \Q$member\E\n\z/ &&
      $contents !~ / link to / or refuse();
    exclusive_write("$new/node", capture(268435456, '/usr/bin/tar', '-xOzf', $archive, '--', $member));
    signed_node("$new/node");
    exclusive_write("$new/node.sha256", sha256_file("$new/node", 268435456) . "\n");
    chmod(0755, "$new/node", $new) == 2 or refuse();
  }
  sync_directory($new);
  rename($new, $base) or refuse();
  sync_directory($root);
  remove_tree($scratch, { safe => 1 });
}

opendir(my $dir, $root) or refuse();
my @stale = grep { /\A\.bootstrap-[A-Za-z0-9]{8}\z/ } readdir($dir);
closedir($dir) or refuse();
for my $stale (@stale) {
  info("$root/$stale", 0700, 1);
  remove_tree("$root/$stale", { safe => 1 });
}
previous_base();
if (!lstat($base)) {
  $!{ENOENT} or refuse();
  boot();
}
info($base, 0755, 1);
for my $module (@modules, 'release-policy.ts') {
  info("$base/$module", $module eq 'launch' ? 0755 : 0644, 0);
}
info($node, 0755, 0);
my $digestFile = "$base/node.sha256";
info($digestFile, 0600, 0);
open(my $digest, '<', $digestFile) or refuse();
my $expected = <$digest>;
$expected =~ /\A([a-f0-9]{64})\n\z/ && $1 eq sha256_file($node, 268435456) or refuse();
close($digest) or refuse();
signed_node($node);
my $pid = fork();
defined($pid) or refuse();
if (!$pid) {
  my $session = POSIX::setsid();
  defined($session) && $session > 0 or refuse();
  open(STDERR, '>&', $report) or refuse();
  close($report) or refuse();
  close($lock) or refuse();
  exec('/usr/bin/env', '-i', $node, '--disable-sigusr1', $entry, $sha) or refuse();
}
close($report) or refuse();
waitpid($pid, 0) == $pid or refuse();
my $status = $?;
kill('KILL', -$pid) if $status != 0;
close($lock) or refuse();
exit($status == 0 ? 0 : 1);
