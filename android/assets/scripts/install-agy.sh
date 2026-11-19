#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
#  install-agy.sh —— 下载 Google 官方的 Antigravity CLI（agy，原版二进制，不做任何修改）
#
#  逻辑在旁边的 install-agy.mjs：读官方 manifest（version / url / sha512），
#  按 manifest 的 url 下 tar.gz、核 sha512、解出 antigravity 成员落地为 agy，见那边的说明。
#  这里只是给 Java 留的入口。
#
#  用法:  install-agy.sh [latest|<版本号>]
# ─────────────────────────────────────────────────────────────────────
exec "$PREFIX/bin/node" "$(dirname "$0")/install-agy.mjs" "$@"
