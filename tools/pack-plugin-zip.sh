#!/usr/bin/env bash
# 插件发布包打包（规矩固化自 14.6 批教训 #737 + 15.21 包逆向对账）：
#   ZIP 条目集 = `git ls-files` 追踪集全量（根级条目，无顶层目录前缀）。
# 不靠记忆挑文件——untracked 垃圾/半成品不进包，追踪集才是权威。
# 用法: bash tools/pack-plugin-zip.sh   （从仓根跑；版本读 plugin.json）
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json;print(json.load(open('plugin.json'))['version'])")
OUT="agentteams-qwenpaw-workbench-v${VERSION}.zip"

# 树必须是干净的（未提交改动 = 半成品，禁止打包）——与 git 纪律同源。
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: 工作区有未提交改动，先提交或还原再打包（git status --short）" >&2
  git status --short >&2
  exit 1
fi

python3 - "$OUT" <<'EOF'
import subprocess, sys, zipfile, os
out = sys.argv[1]
names = sorted(subprocess.check_output(["git", "ls-files"], text=True).splitlines())
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for n in names:
        z.write(n, n)
print(f"OK {out}: {len(names)} 条目")
EOF

# 自检：条目数与 sha256（发布回执用）。
python3 -c "import zipfile;print('条目校验:', len(zipfile.ZipFile('$OUT').namelist()))"
sha256sum "$OUT"
ls -l "$OUT" | awk '{print "字节:", $5}'
