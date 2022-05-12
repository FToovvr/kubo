#/usr/bin/env sh

deno test --no-check --coverage=cov_profile
deno coverage cov_profile --lcov > lcov.info