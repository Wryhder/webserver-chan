#!/usr/bin/env bash

nix-shell -p nodejs_22 nodePackages_latest.ts-node --command "
  filename=$1
  ts-node \$filename
"

