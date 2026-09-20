#!/bin/bash
# Bounded worker pool over all missing (cond, case, rep) cells. Usage: run-queue.sh [workers=4]
W="${1:-4}"
D="$(cd "$(dirname "$0")" && pwd)"
OUT="$D/../case-out"
mkdir -p "$OUT"
LIST=$D/queue.txt
: > $LIST
for rep in 1 2; do
  for c in S1 S1b S2 S3 S4 S5 S5b S6 S7; do
    for cond in O N; do
      [ -f "$OUT/$cond-$c-r$rep.json" ] || echo "$cond $c $rep" >> $LIST
    done
  done
done
echo "queued $(wc -l < $LIST) cells, $W workers, started $(date +%H:%M:%S)"
xargs -P "$W" -L 1 $D/run-case.sh < $LIST
echo "QUEUE DONE at $(date +%H:%M:%S)"
