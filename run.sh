#!/bin/bash

set -a
source .env
set +a

while true; do
	node --unhandled-rejections=none app.js
done