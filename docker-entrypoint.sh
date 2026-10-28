#!/bin/sh
set -e

mkdir -p /app/data
chown -R node:node /app/data
chmod 700 /app/data

exec su-exec node "$@"
