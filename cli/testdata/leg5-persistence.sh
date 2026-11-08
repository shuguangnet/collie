set -u
ROOT='/home/pat/.collie'
for _c in "$ROOT/current/bin/collie" "$ROOT/bin/collie"; do
  if [ -x "$_c" ]; then exec "$_c" doctor --only persistence --json; fi
done
exit 66
