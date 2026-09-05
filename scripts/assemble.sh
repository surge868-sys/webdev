#!/bin/bash
# Assemble captured frames into a 30 fps MP4 with the music mixed in.
# usage: scripts/assemble.sh <framesdir> <out.mp4>
set -e
FF=/usr/local/lib/python3.11/dist-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v7.0.2
DIR=$1; OUT=$2
CRASH=$(python3 -c "import json;print(json.load(open('$DIR/log.json'))['crashedAt'])")
FRAMES=$(python3 -c "import json;print(json.load(open('$DIR/log.json'))['frames'])")
CRASH_MS=$(python3 -c "print(int($CRASH/${FPS:-20}*1000)+450)")
DUR=$(python3 -c "print($FRAMES/${FPS:-20})")
# audio: title loop for 2 s, then the gameplay bed, muted at the crash; sting 0.45 s after the crash
$FF -hide_banner -loglevel error -y -framerate ${FPS:-20} -i "$DIR/f%05d.png" \
  -i public/audio/prairie_dusk.mp3 -i public/audio/highway_tension.mp3 -i public/audio/news_sting.mp3 \
  -filter_complex "[1:a]atrim=0:2.6,afade=t=out:st=1.8:d=0.8,volume=0.8[t];[2:a]atrim=0:$(python3 -c "print($CRASH/${FPS:-20}-2+0.1)"),adelay=2000|2000,afade=t=in:st=2:d=0.6,afade=t=out:st=$(python3 -c "print($CRASH/${FPS:-20}-0.05)"):d=0.06,volume=0.7[r];[3:a]adelay=${CRASH_MS}|${CRASH_MS},volume=0.9[s];[t][r][s]amix=inputs=3:duration=longest:dropout_transition=0:normalize=0,apad[a]" \
  -map 0:v -map "[a]" -vf "fps=30,scale=1080:1920:flags=lanczos" -c:v libx264 -pix_fmt yuv420p -crf 21 -preset veryfast -vf scale=1080:1920:flags=lanczos -c:a aac -b:a 160k -t "$DUR" -movflags +faststart "$OUT"
ls -la "$OUT"
