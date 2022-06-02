#/usr/bin/env sh

deno test --coverage=cov_profile --ignore=./temp
rm -rf cov_profile/
deno coverage cov_profile --lcov > lcov.info