#!/usr/bin/env bash
# 一键源码构建 → 可安装插件 ZIP（README「源码构建 Build from Source」章的实现）。
# 流程: 装依赖（npm ci 严格 lock；EINTEGRITY 时按 npm 报错自动修 lock integrity 后重试；
#       再失败回退 npm install / 移开 lock 重解析）→ npm run build（vite → 仓库根 dist/index.js）
#       → tools/pack-plugin-zip.sh（git ls-files 权威集 + 干净树门禁，以该脚本规矩为准）。
# 需网络（npm 下载依赖）；其余全程在仓库内完成。幂等，可重复执行。
set -euo pipefail
cd "$(dirname "$0")/.."

# 0) 工具链检查（node 缺失给安装指引）
for c in git node npm python3; do
  if ! command -v "$c" >/dev/null 2>&1; then
    echo "ERROR: 缺少 $c，请先安装后重试" >&2
    if [ "$c" = "node" ]; then
      echo "安装指引: Node.js >= 20 (LTS) — https://nodejs.org/ 或 nvm install 20" >&2
    fi
    exit 1
  fi
done
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERROR: 需要 Node.js >= 20（当前 $(node -v)），请升级后重试" >&2
  exit 1
fi

cd frontend
LOCK_BACKUP=$(mktemp)
trap 'rm -f "$LOCK_BACKUP"' EXIT
cp package-lock.json "$LOCK_BACKUP"

# npm ci + EINTEGRITY 自愈：lock 里个别 integrity 条目与 registry 官方值不符时
# （已知 three-forcegraph 条目脏），npm 报错会给出 "wanted <脏值> but got <真值>"——
# 把 lock 中等于脏值的 integrity 换成真值后重试 ci（最多 3 轮）。装到 lock 精确版本
# 才能保证构建产物与已发布 dist 逐字节一致（pack 有干净树门禁，漂移的树会过不了门）。
ci_with_integrity_repair() {
  local log fixed
  log=$(mktemp)
  if npm ci --include=dev >"$log" 2>&1; then
    rm -f "$log"
    return 0
  fi
  if ! grep -q 'EINTEGRITY' "$log"; then
    rm -f "$log"
    return 1
  fi
  for _ in 1 2 3; do
    if ! fixed=$(python3 - "$log" <<'PY'
import json, re, sys
log = open(sys.argv[1]).read()
lock = json.load(open('package-lock.json'))
fixed = 0
for m in re.finditer(r'wanted (sha[0-9a-z]+-[A-Za-z0-9+/=]+) but got (sha[0-9a-z]+-[A-Za-z0-9+/=]+)', log):
    wanted, got = m.group(1), m.group(2)
    for e in lock.get('packages', {}).values():
        if e.get('integrity') == wanted:
            e['integrity'] = got
            fixed += 1
if fixed:
    with open('package-lock.json', 'w') as f:
        f.write(json.dumps(lock, indent=2) + '\n')
print(fixed)
PY
    ); then
      break
    fi
    [ "$fixed" -gt 0 ] || break
    echo "WARN: lock integrity 条目已按 npm 报错修正（$fixed 处），重试 npm ci ..." >&2
    if npm ci --include=dev >"$log" 2>&1; then
      rm -f "$log"
      return 0
    fi
    grep -q 'EINTEGRITY' "$log" || break
  done
  rm -f "$log"
  return 1
}

# 1) 依赖: 优先 npm ci（lockfile 严格模式）；失败回退 npm install。
#    --include=dev: 部分环境全局 NODE_ENV=production 会让 npm 默认省略 devDependencies，
#    而 vite 是 devDependency，必须显式包含。
if ci_with_integrity_repair; then
  :
elif npm install --include=dev; then
  :
else
  # 最后手段: 移开 lock 重解析（无 integrity 可违反）。注意: 重解析可能选中比 lock
  # 更新的版本，若构建产物与已提交 dist 不一致，pack 的干净树门禁会拦住——
  # 届时 commit 新 dist 后重跑本脚本即可。
  echo "WARN: npm install 也失败（lockfile integrity 问题且自动修复未生效），移开 lock 重解析 ..." >&2
  mv package-lock.json package-lock.json.re-resolve
  if ! npm install --include=dev; then
    mv -f package-lock.json.re-resolve package-lock.json
    echo "ERROR: 依赖安装失败" >&2
    exit 1
  fi
  rm -f package-lock.json.re-resolve
fi

# 统一还原原始 lock（保持工作树干净——pack 脚本有干净树硬门）。
cp "$LOCK_BACKUP" package-lock.json

# 2) 构建: vite build 产出仓库根 dist/index.js（plugin.json entry.frontend）
npm run build
[ -f ../dist/index.js ] || { echo "ERROR: 构建产物 ../dist/index.js 不存在" >&2; exit 1; }

# 3) 打安装 ZIP（git ls-files 权威集 + 干净树门禁，详见 pack 脚本头注）
cd ..
bash tools/pack-plugin-zip.sh

# 4) 回执: ZIP 路径 / 版本 / 字节数 / sha256
VERSION=$(python3 -c "import json;print(json.load(open('plugin.json'))['version'])")
ZIP="agentteams-qwenpaw-workbench-v${VERSION}.zip"
echo "==================== build from source OK ===================="
echo "ZIP    : $(pwd)/$ZIP"
echo "版本   : v$VERSION"
echo "字节数 : $(wc -c < "$ZIP" | tr -d '[:space:]')"
echo "sha256 : $(sha256sum "$ZIP" | awk '{print $1}')"
