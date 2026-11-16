#!/usr/bin/env bash
# Encode rendered frames + soundtrack into the final film.
# usage: bash tools/mux.sh [frames_dir=out/frames] [audio=out/audio.wav] [out=out/walking_block_1080p30.mp4]
set -e
cd "$(dirname "$0")/.."
FR=${1:-out/frames}; AU=${2:-out/audio.wav}; OUT=${3:-out/walking_block_1080p30.mp4}
ffmpeg -hide_banner -loglevel warning -y -threads 6 \
  -framerate 30 -start_number 0 -i "$FR/f_%06d.png" -i "$AU" \
  -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -profile:v high -level 4.2 \
  -vf "scale=in_range=full:out_range=tv:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p" -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv \
  -x264-params "keyint=60:min-keyint=30:aq-mode=3:deblock=-1,-1" -tune film \
  -c:a aac -b:a 256k -ar 48000 -movflags +faststart -shortest "$OUT"
ffprobe -v error -show_entries format=duration,size,bit_rate:stream=codec_name,width,height,r_frame_rate,nb_frames -of default=nw=1 "$OUT"
