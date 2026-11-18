use strict;
use warnings;
use Fcntl qw(O_RDONLY O_NOFOLLOW O_DIRECTORY);

# This reader is only a descriptor-relative source reader. It is not a privileged CLI.
@ARGV == 3 or exit 1;
my ($root, $relative, $owner) = @ARGV;
$^O eq 'darwin' or exit 1;
$owner =~ /^\d+$/ or exit 1;
my @parts = split m{/}, $relative, -1;
@parts && !grep { !/\A[A-Za-z0-9._-]+\z/ || $_ eq '.' || $_ eq '..' || lc($_) eq '.git' } @parts or exit 1;
sysopen(my $dir, $root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) or exit 1;
my @root_stat = stat($dir);
@root_stat && $root_stat[4] == $owner && -d $dir or exit 1;
for my $index (0 .. $#parts) {
  my $flags = O_RDONLY | O_NOFOLLOW;
  $flags |= O_DIRECTORY if $index < $#parts;
  my $fd = syscall(463, fileno($dir), $parts[$index], $flags, 0);
  $fd >= 0 or exit 1;
  open(my $next, '<&=', $fd) or exit 1;
  my @s = stat($next);
  @s && $s[4] == $owner or exit 1;
  if ($index == $#parts) {
    -f $next && $s[3] == 1 && $s[7] <= 10485760 or exit 1;
    binmode($next); binmode(STDOUT);
    my $total = 0;
    while (1) {
      my $n = sysread($next, my $chunk, 65536);
      defined($n) or exit 1;
      last unless $n;
      $total += $n;
      $total <= 10485760 or exit 1;
      print STDOUT $chunk or exit 1;
    }
  }
  $dir = $next;
}
