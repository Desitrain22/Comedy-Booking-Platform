#!/bin/sh
# Container entrypoint. Some hosts (Fly.io volumes, bind mounts) mount the data folder owned
# by root; make it writable for the unprivileged `node` user, then run the app as `node`.
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
