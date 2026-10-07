#!/bin/sh
set -eu

if [ "$#" -lt 3 ] || [ "$1" != "--root" ] || [ "$3" != "--paths-file" ]; then
  echo "ENCODER_ARGV_INVALID" >&2
  exit 64
fi

encoder_root=$2
paths_file=$4
case "$encoder_root" in
  /*) ;;
  *) echo "ENCODER_ROOT_MUST_BE_ABSOLUTE" >&2; exit 64 ;;
esac
case "$paths_file" in
  /*) ;;
  *) echo "ENCODER_PATHS_FILE_MUST_BE_ABSOLUTE" >&2; exit 64 ;;
esac

first=1
sorted_paths=$(LC_ALL=C /usr/bin/sort "$paths_file")
printf '['
while IFS= read -r member_path; do
  case "$member_path" in
    ""|*..*|*[!a-z0-9./_-]*) echo "ENCODER_PATH_INVALID:$member_path" >&2; exit 65 ;;
  esac
  member_file="$encoder_root/$member_path"
  if [ ! -f "$member_file" ] || [ -L "$member_file" ]; then
    echo "ENCODER_MEMBER_NOT_REGULAR:$member_path" >&2
    exit 66
  fi
  member_bytes=$(/usr/bin/wc -c < "$member_file" | /usr/bin/tr -d ' ')
  member_sha=$(/usr/bin/shasum -a 256 "$member_file" | /usr/bin/cut -d ' ' -f 1)
  if [ "$first" -eq 0 ]; then printf ','; fi
  first=0
  printf '{"path":"%s","bytes":%s,"sha256":"%s"}' "$member_path" "$member_bytes" "$member_sha"
done <<F3_SORTED_PATHS
$sorted_paths
F3_SORTED_PATHS
printf ']'
