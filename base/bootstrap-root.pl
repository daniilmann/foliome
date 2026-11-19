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
my @modules = qw(
  activation-state.js first-install.js installation-release.js install-owner.js install-platform.js
  install-production.js install-root.js install-transaction.js launch launcher.js publisher-verification.js
  read-release-file.pl release-materialization.js release-observation.js release-origin.js
  release-pipeline.js system-install-layout.js
);
my %domain = ('release.ts' => 'release-policy.ts', 'installed-config.ts' => 'installed-config.ts');

sub refuse { die "install-bootstrap\n"; }

sub file_bytes {
  my ($file, $limit) = @_;
  sysopen(my $handle, $file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) or refuse();
  my @s = stat($handle);
  @s && -f $handle && $s[3] == 1 && $s[7] <= $limit or refuse();
  binmode($handle);
  my $bytes = '';
  while (1) {
    my $n = sysread($handle, my $chunk, 16384);
    defined($n) or refuse();
    last unless $n;
    $bytes .= $chunk;
    length($bytes) <= $limit or refuse();
  }
  length($bytes) == $s[7] && close($handle) or refuse();
  return $bytes;
}

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

sub assemble {
  my ($scratch, $sha, $self, $owner) = @_;
  my $new = "$scratch/base";
  my $repo = "$scratch/git";
  mkdir($repo, 0700) or refuse();
  my @git = ('/usr/bin/git', '--no-optional-locks', '--no-replace-objects', '-C', $repo,
    '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always', '-c', 'credential.helper=',
    '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true', '-c', 'http.proxy=',
    '-c', 'http.lowSpeedLimit=1024', '-c', 'http.lowSpeedTime=15', '-c', 'fetch.fsckObjects=true');
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
    $self eq $blob->('base/bootstrap-root.pl') or refuse();
    for my $module (@modules) {
      exclusive_write("$new/$module", $blob->("base/$module"));
      chmod($module eq 'launch' ? 0755 : 0644, "$new/$module") == 1 or refuse();
    }
    if ($owner) {
      mkdir("$scratch/core", 0700) && mkdir("$scratch/core/domain", 0700) or refuse();
    }
    for my $file (sort keys %domain) {
      my $to = $owner ? "$scratch/core/domain/$file" : "$new/$domain{$file}";
      exclusive_write($to, $blob->("core/domain/$file"));
      if (!$owner) { chmod(0644, $to) == 1 or refuse(); }
    }
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
  return $new;
}

sub boot {
  my ($sha, $installed) = @_;
  my $scratch = tempdir('.bootstrap-XXXXXXXX', DIR => $root, CLEANUP => 1);
  info($scratch, 0700, 1);
  my $new = assemble($scratch, $sha, file_bytes($0, 131072), 0);
  if ($installed) {
    info($base, 0755, 1);
    for my $name (@modules, values(%domain), 'node', 'node.sha256') {
      my $mode = ($name eq 'node' || $name eq 'launch') ? 0755 : $name eq 'node.sha256' ? 0600 : 0644;
      info("$base/$name", $mode, 0);
      sha256_file("$base/$name", 268435456) eq sha256_file("$new/$name", 268435456) or refuse();
    }
  } else {
    rename($new, $base) or refuse();
    sync_directory($root);
  }
  remove_tree($scratch, { safe => 1 });
}

sub root_main {
  my ($sha, $mode) = @ARGV;
  my $initial = @ARGV == 2 && $mode eq '--initial';
  my ($real_group) = split ' ', $(;
  my ($effective_group) = split ' ', $);
  $^O eq 'darwin' && $< == 0 && $> == 0 && $real_group == 0 && $effective_group == 0 &&
    $0 eq "$root/bootstrap-root.pl" && (@ARGV == 1 || $initial) &&
    $sha =~ /\A[a-f0-9]{40}\z/ && !keys(%ENV) or refuse();
  umask 0077;
  chdir '/' or refuse();
  opendir(my $fds, '/dev/fd') or exit 1;
  my @descriptors = grep { /\A[0-9]+\z/ && $_ > 2 } readdir($fds);
  closedir($fds) or exit 1;
  POSIX::close($_) for @descriptors;
  open(my $report, '>&', \*STDERR) or exit 1;
  open(STDIN, '<', '/dev/null') or exit 1;
  open(STDOUT, '>', '/dev/null') or exit 1;
  open(STDERR, '>', '/dev/null') or exit 1;

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

  if ($initial) {
    info("$root/.initial-approval", 0600, 0);
    file_bytes("$root/.initial-approval", 106) =~ /\A\Q$sha\E [a-f0-9]{64}\n\z/ or refuse();
    if (lstat("$root/installation-release.json")) {
      info("$root/installation-release.json", 0644, 0);
      my $state = decode_json(file_bytes("$root/installation-release.json", 131072));
      $state->{sha} eq $sha && $state->{initialSha} eq $sha or refuse();
    } else { $!{ENOENT} or refuse(); }
  }
  opendir(my $dir, $root) or refuse();
  my @stale = grep { /\A\.bootstrap-[A-Za-z0-9]{8}\z/ } readdir($dir);
  closedir($dir) or refuse();
  for my $stale (@stale) {
    info("$root/$stale", 0700, 1);
    remove_tree("$root/$stale", { safe => 1 });
  }
  previous_base();
  my $installed = lstat($base);
  $installed || $!{ENOENT} or refuse();
  if ($initial) {
    boot($sha, $installed);
  } else {
    $installed or refuse();
  }
  info($base, 0755, 1);
  for my $module (@modules, values(%domain)) {
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
    exec('/usr/bin/env', '-i', $node, '--disable-sigusr1', $entry, $sha, ($initial ? ('--initial') : ())) or refuse();
  }
  close($report) or refuse();
  waitpid($pid, 0) == $pid or refuse();
  my $status = $?;
  kill('KILL', -$pid) if $status != 0;
  close($lock) or refuse();
  exit($status == 0 ? 0 : 1);
}

# The privileged command is literal code from this approved blob. It treats
# stdin as bytes and verifies their digest before publishing or invoking them.
my $provision = <<'PROVISION';
use strict;
use warnings;
use Digest::SHA qw(sha256_hex);
use Fcntl qw(:flock O_CREAT O_DIRECTORY O_NOFOLLOW O_NONBLOCK O_RDONLY O_RDWR);
use File::Temp qw(tempfile);
use IO::Handle ();

sub refuse { die "install-provision: approved release, checks or keys differ\n"; }
my ($sha, $digest, $proof) = @ARGV;
$^O eq 'darwin' && $< == 0 && $> == 0 && @ARGV == 3 && !keys(%ENV) &&
  $sha =~ /\A[a-f0-9]{40}\z/ && $digest =~ /\A[a-f0-9]{64}\z/ &&
  $proof =~ /\A[a-f0-9]{64}\z/ or refuse();
chdir '/' or refuse();
umask 0077;
my $bytes = '';
while (1) {
  my $n = sysread(STDIN, my $chunk, 16384);
  defined($n) or refuse();
  last unless $n;
  $bytes .= $chunk;
  length($bytes) <= 131072 or refuse();
}
sha256_hex($bytes) eq $digest or refuse();

sub acl {
  my ($file, $stock) = @_;
  open(my $ls, '-|', '/bin/ls', '-lde', $file) or refuse();
  <$ls>;
  while (<$ls>) { $stock && /\A\s*\d+: group:everyone deny delete\n\z/ or refuse(); }
  close($ls) or refuse();
}

sub check {
  my ($file, $mode, $directory) = @_;
  my @s = lstat($file);
  @s && ($directory ? -d _ : (-f _ && $s[3] == 1)) &&
    $s[4] == 0 && $s[5] == 0 && ($s[2] & 07777) == $mode or refuse();
  acl($file, 0);
}

my $parent = '/Library/Application Support';
my $root = "$parent/Foliome";
my $entry = "$root/bootstrap-root.pl";
my $approval = "$root/.initial-approval";
for my $dir ('/', '/Library', $parent) {
  my @s = lstat($dir);
  @s && -d _ && $s[4] == 0 && ($s[2] & 07022) == 0 or refuse();
  acl($dir, 1);
}
if (!lstat($root)) {
  $!{ENOENT} or refuse();
  umask 0022;
  mkdir($root, 0755) || $!{EEXIST} or refuse();
  umask 0077;
}
# Darwin can inherit the parent's group on mkdir. Finish provisioning an
# empty root-owned directory after a crash between mkdir and chown.
my @parent_state = lstat($parent);
my @root_state = lstat($root);
if (@root_state && -d _ && $root_state[4] == 0 && $root_state[5] != 0 &&
    $root_state[5] == $parent_state[5] && ($root_state[2] & 07777) == 0755) {
  acl($root, 0);
  opendir(my $empty, $root) or refuse();
  my @entries = grep { $_ ne '.' && $_ ne '..' } readdir($empty);
  closedir($empty) && !@entries or refuse();
  chown(0, 0, $root) == 1 or refuse();
}
check($root, 0755, 1);
sysopen(my $parent_fd, $parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) or refuse();
$parent_fd->sync() && close($parent_fd) or refuse();
my $lockfile = "$root/.provision.lock";
sysopen(my $lock, $lockfile, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0600) or refuse();
check($lockfile, 0600, 0);
flock($lock, LOCK_EX | LOCK_NB) or refuse();

sub matches {
  my ($file, $mode, $expected) = @_;
  return 0 if !lstat($file) && $!{ENOENT};
  check($file, $mode, 0);
  sysopen(my $in, $file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) or refuse();
  my @s = stat($in);
  @s && $s[7] == length($expected) or refuse();
  binmode($in);
  local $/;
  my $actual = <$in>;
  close($in) && $actual eq $expected or refuse();
  return 1;
}

sub publish {
  my ($file, $mode, $contents) = @_;
  my ($out, $temp) = tempfile('.provision-XXXXXXXX', DIR => $root, UNLINK => 1);
  binmode($out);
  print $out $contents or refuse();
  chmod($mode, $temp) == 1 && $out->sync() && close($out) or refuse();
  rename($temp, $file) or refuse();
  sysopen(my $dir, $root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) or refuse();
  $dir->sync() && close($dir) or refuse();
}

opendir(my $dir, $root) or refuse();
my @stale = grep { /\A\.provision-[A-Za-z0-9]{8}\z/ } readdir($dir);
closedir($dir) or refuse();
for my $name (@stale) {
  my $file = "$root/$name";
  my @s = lstat($file);
  @s && -f _ && $s[3] == 1 && $s[4] == 0 && $s[5] == 0 &&
    (($s[2] & 07777) == 0600 || ($s[2] & 07777) == 0644) or refuse();
  unlink($file) or refuse();
}
my $exists = matches($entry, 0644, $bytes);
my $stamp = "$sha $proof\n";
if (!matches($approval, 0600, $stamp)) {
  for my $name ('base', '.install', 'installation-release.json', 'installation.json') {
    !lstat("$root/$name") && $!{ENOENT} or refuse();
  }
  publish($approval, 0600, $stamp);
}
publish($entry, 0644, $bytes) unless $exists;
close($lock) or refuse();
exec('/usr/bin/perl', $entry, $sha, '--initial') or refuse();
PROVISION

sub owner_main {
  my ($flag, $sha, $input, $work) = @ARGV;
  $^O eq 'darwin' && @ARGV == 4 && $flag eq '--owner' && $< >= 501 && $< == $> &&
    $sha =~ /\A[a-f0-9]{40}\z/ && $work =~ m{\A/private/tmp/foliome-first\.[A-Za-z0-9]{8}\z} &&
    $0 eq "$work/bootstrap-root.pl" or refuse();
  my @s = lstat($work);
  @s && -d _ && $s[4] == $< && ($s[2] & 07777) == 0700 or refuse();
  my @console = lstat('/dev/console');
  @console && -c _ && $console[4] == $< or refuse();
  umask 0077;
  chdir '/' or refuse();
  my $self = file_bytes($0, 131072);
  my $scratch = tempdir('loader-XXXXXXXX', DIR => $work, CLEANUP => 1);
  my $runtime = assemble($scratch, $sha, $self, 1);
  my @owner = ('/usr/bin/env', '-i', "$runtime/node", '--disable-sigusr1', "$runtime/first-install.js");
  my $proof = capture(65, @owner, 'stage', $sha, $input);
  $proof =~ /\A([a-f0-9]{64})\n\z/ or refuse();
  $proof = $1;
  my $digest = Digest::SHA::sha256_hex($self);
  open(my $admin, '|-', '/usr/bin/sudo', '--', '/usr/bin/env', '-i',
    '/usr/bin/perl', '-e', $provision, '--', $sha, $digest, $proof) or refuse();
  binmode($admin);
  print $admin $self or refuse();
  close($admin) or refuse();
  command(@owner, 'finish', $sha, $input);
  print "Foliome is ready.\n";
}

if ($< == 0) { root_main(); }
else { owner_main(); }
