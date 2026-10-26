#!/usr/bin/env bash
# 一键源码构建 → 可安装插件 ZIP（README「源码构建 Build from Source」章的实现）。
# 流程: npm ci（失败回退 npm install，再回退「移开 lock 重解析」）→ npm run build（vite → 仓库根 dist/index.js）
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

# 1) 依赖: 优先 npm ci（lockfile 严格模式）；失败回退 npm install。
#    --include=dev: 部分环境全局 NODE_ENV=production 会让 npm 默认省略 devDependencies，
#    而 vite 是 devDependency，必须显式包含。
cd frontend
if ! npm ci --include=dev; then
  echo "WARN: npm ci 失败，回退 npm install ..." >&2
  if ! npm install --include=dev; then
    # 已知问题: package-lock.json 中 three-forcegraph 的 integrity 条目与 npm registry 官方值不符，
    # 带 lock 的安装（ci / install）都会 EINTEGRITY 必败 → 移开 lock 重解析（无 integrity 可违反），
    # 成功后还原 lock，保持工作树干净（pack 脚本有干净树硬门）。
    echo "WARN: npm install 失败（疑似 lockfile integrity 问题），移开 lock 重解析 ..." >&2
    mv package-lock.json package-lock.json.broken
    if ! npm install --include=dev; then
      mv -f package-lock.json.broken package-lock.json
      echo "ERROR: 依赖安装失败" >&2
      exit 1
    fi
    mv -f package-lock.json.broken package-lock.json
  fi
fi

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
