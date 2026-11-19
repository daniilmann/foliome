use strict;
use warnings;
use Fcntl qw(O_RDONLY O_NOFOLLOW O_DIRECTORY O_NONBLOCK);

# This reader is only a descriptor-relative source reader. It is not a privileged CLI.
(@ARGV == 3 || @ARGV == 5) or exit 1;
my ($root, $relative, $owner, $mode, $limit) = @ARGV;
$^O eq 'darwin' or exit 1;
$owner =~ /^\d+$/ or exit 1;
if (defined($mode)) {
  $mode =~ /\A(?:600|700)\z/ && $limit =~ /\A[1-9][0-9]{0,8}\z/ && $limit <= 268435456 or exit 1;
  $mode = oct($mode);
} else {
  $limit = 10485760;
}
my @parts = split m{/}, $relative, -1;
@parts && !grep { !/\A[A-Za-z0-9._ -]+\z/ || $_ eq '.' || $_ eq '..' || lc($_) eq '.git' } @parts or exit 1;
sysopen(my $dir, $root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) or exit 1;
my @root_stat = stat($dir);
@root_stat && $root_stat[4] == $owner && -d $dir or exit 1;
if (defined($mode)) { ($root_stat[2] & 07777) == 0700 or exit 1; }
for my $index (0 .. $#parts) {
  my $flags = O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
  $flags |= O_DIRECTORY if $index < $#parts;
  my $fd = syscall(463, fileno($dir), $parts[$index], $flags, 0);
  $fd >= 0 or exit 1;
  open(my $next, '<&=', $fd) or exit 1;
  my @s = stat($next);
  @s && $s[4] == $owner or exit 1;
  if ($index == $#parts) {
    -f $next && $s[3] == 1 && $s[7] <= $limit or exit 1;
    if (defined($mode)) { ($s[2] & 07777) == $mode or exit 1; }
    binmode($next); binmode(STDOUT);
    my $total = 0;
    while (1) {
      my $n = sysread($next, my $chunk, 65536);
      defined($n) or exit 1;
      last unless $n;
      $total += $n;
      $total <= $limit or exit 1;
      print STDOUT $chunk or exit 1;
    }
    my @after = stat($next);
    @after && $total == $s[7] && $after[7] == $s[7] && $after[9] == $s[9] && $after[10] == $s[10] or exit 1;
  } elsif (defined($mode)) {
    # The home/Library and Application Support parents may be 0755. Everything
    # below the application directory is owner-private.
    my $permitted = $index < 2 && $parts[0] eq 'Library' ? 0755 : 0700;
    (($s[2] & 07777) == 0700 || ($s[2] & 07777) == $permitted) or exit 1;
  }
  $dir = $next;
}
