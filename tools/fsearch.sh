#!/usr/bin/env bash
# Search freesound.org (CC0 only) and list id | duration | title | hq preview url.
# usage: tools/fsearch.sh "query one" "query two" ...
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
for q in "$@"; do
  echo "=== $q"
  enc=$(printf '%s' "$q" | sed 's/ /+/g')
  html=$(curl -sL -A "$UA" "https://freesound.org/search/?q=${enc}&f=license%3A%22Creative+Commons+0%22&s=Downloads+%28most+first%29")
  printf '%s' "$html" | grep -oE 'data-(mp3|title|duration)="[^"]*"' | paste - - - | head -${N:-12} | \
    sed -E 's/data-mp3="([^"]*)-lq\.mp3"\s*data-title="([^"]*)"\s*data-duration="([^"]*)"/\3s | \2 | \1-hq.mp3/'
  sleep 7
done
