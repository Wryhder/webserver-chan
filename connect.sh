#!/usr/bin/env bash

nix-shell -p socat --run "socat tcp:127.0.0.1:1234 -"
