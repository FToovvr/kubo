#/usr/bin/env sh

deno test --coverage=cov_profile --ignore=./temp
deno coverage cov_profile --lcov > lcov.info