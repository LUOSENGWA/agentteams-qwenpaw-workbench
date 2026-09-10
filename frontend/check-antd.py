#!/usr/bin/env python3
"""防线 #398：插件源码 antd.* / antdIcons 成员引用交叉校验。

背景（2026-08-29 再版 11 事故）：插件 qwenpaw-host.d.ts 里 `antd: any`，
tsc 对 antd 命名空间零检查——`<antd.Text>`（应为 antd.Typography.Text）
混过 tsc/build，真机渲染时 antd.Text=undefined → React #130 整 tab 崩溃。

用法：python3 check-antd.py（frontend/ 下跑，退出码 0=干净）。
发版流程必跑：tsc → check-antd.py → i18n 交叉 → vite build。
"""
import glob
import re
import sys

# antd 5 顶层导出（大写组件 + 常用小写 API），与宿主 antd 5.29.x 对齐。
# 新增引用时先在此登记（登记前先查 https://ant.design/components/overview 确认存在）。
VALID_ANTD = {
    "Affix", "Alert", "Anchor", "App", "AutoComplete", "Avatar", "BackTop",
    "Badge", "Breadcrumb", "Button", "Calendar", "Card", "Carousel",
    "Cascader", "CheckableTag", "Checkbox", "Col", "Collapse", "Comment",
    "ConfigProvider", "Descriptions", "Divider", "Drawer", "Dropdown",
    "Empty", "Flex", "FloatButton", "Form", "Grid", "Image", "ImagePreview",
    "Input", "InputNumber", "Layout", "List", "Mentions", "Menu",
    "Modal", "Notification", "Pagination", "Popconfirm", "Popover",
    "Progress", "Radio", "Rate", "Result", "Row", "Segmented", "Select",
    "Skeleton", "Slider", "Space", "Spin", "Statistic", "Steps", "Switch",
    "Table", "Tabs", "Tag", "TimePicker", "Timeline", "Tooltip", "Tour",
    "Tree", "TreeSelect", "Typography", "Upload", "Watermark",
    "message", "notification", "theme",
}

VALID_ICONS = {
    # 插件当前用到的（新增图标先在此登记）
    "ReloadOutlined", "SyncOutlined",
}


def main():
    bad = []
    used = {}
    for f in glob.glob("src/**/*.ts*", recursive=True):
        src = open(f, encoding="utf-8").read()
        for m in re.finditer(r"antd\.([A-Za-z_$][\w$]*)", src):
            name = m.group(1)
            if name in VALID_ANTD:
                used.setdefault(name, set()).add(f)
            else:
                line = src[: m.start()].count("\n") + 1
                bad.append(f"{f}:{line}  antd.{name}  ← 不是 antd 5 导出")
        for m in re.finditer(r'icons\[\s*"([A-Za-z]+)"\s*\]', src):
            name = m.group(1)
            if name not in VALID_ICONS:
                line = src[: m.start()].count("\n") + 1
                bad.append(f"{f}:{line}  icons[\"{name}\"]  ← 未登记的图标")
    if bad:
        print(f"✗ antd 引用交叉失败（{len(bad)} 处非法引用）：")
        for b in bad:
            print("  ", b)
        sys.exit(1)
    print(f"✓ antd 引用交叉通过：{len(used)} 个成员引用全部合法")


if __name__ == "__main__":
    main()
