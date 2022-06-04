#!/usr/bin/env bash

# workaround，不然树莓派的 deno 会表示存在错误，因而不执行
if [[ "$(uname -m)" == "aarch64" ]]; then
  CHECK_OR_NOT=--no-check
fi

deno run $CHECK_OR_NOT --allow-net --allow-read --allow-write --allow-env debug_main.ts