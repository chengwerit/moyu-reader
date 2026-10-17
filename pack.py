"""
打包墨语，生成两个 ZIP：

  1. 墨语-使用版.zip      给非技术用户
  2. 墨语-开发版.zip      完整仓库快照，供备份或二次开发

关键：打包必须保持字节原样。server.ps1 依赖 UTF-8 BOM、启动墨语.bat 依赖
纯 ASCII + CRLF，任何转换都会让它们在用户机器上打不开。所以用 ZIP_DEFLATED
逐字节写入，不做任何文本处理。
"""
import os
import zipfile
import shutil

ROOT = r"C:\Users\linlin\WorkBuddy\work Buddy 工作空间\moyu-reader"
DESKTOP = r"C:\Users\linlin\Desktop"
BUILD = os.path.join(ROOT, ".pack")

# 使用版：只含使用者与协作者需要的
USER_FILES = [
    "启动墨语.bat",
    "使用说明.md",
    "项目说明.md",          # 想知道怎么改、看结构的协作者会需要
    "index.html",
    "manifest.webmanifest",
    "server.ps1",
    "sw.js",
    "css/app.css",
    "js/ai.js",
    "js/app.js",
    "js/db.js",
    "js/updater.js",
    "js/daily.js",
    "js/engine.js",
    "js/parsers.js",
    "lib/LICENSE.md",
    "lib/jszip.min.js",
    "lib/marked.min.js",
    "lib/pdf.min.js",
    "lib/pdf.worker.min.js",
]

# 开发版：仓库里的全部内容（含 .git 历史与开发文档）
DEV_EXCLUDE_DIRS = {"data", "screenshots", "node_modules", ".vscode", ".idea", ".pack"}


def collect_dev():
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        rel = os.path.relpath(dirpath, ROOT)
        parts = [] if rel == "." else rel.split(os.sep)
        dirnames[:] = [
            d for d in dirnames
            if d not in DEV_EXCLUDE_DIRS
            and d != ".pack"
        ]
        for fn in filenames:
            r = os.path.normpath(os.path.join(rel, fn)) if rel != "." else fn
            # 跳过推送脚本与桌面系统文件，不属于项目内容
            # 注意：使用说明.md 是已提交的项目文档，开发版必须带上
            if fn in {"push-via-api.sh", "Thumbs.db", "desktop.ini"}:
                continue
            if fn.endswith((".tmp", ".log")):
                continue
            out.append(r.replace(os.sep, "/"))
    return sorted(out)


def make_zip(target, prefix, files, extra_dirs=()):
    if os.path.exists(target):
        os.remove(target)
    count = 0
    total = 0
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in files:
            src = os.path.join(ROOT, rel.replace("/", os.sep))
            if not os.path.isfile(src):
                print(f"  跳过（不存在）: {rel}")
                continue
            arc = f"{prefix}/{rel}" if prefix else rel
            with open(src, "rb") as f:
                data = f.read()
            z.writestr(arc, data)
            count += 1
            total += len(data)
        # 空目录占位，解压后 data/ 就存在
        for d in extra_dirs:
            z.writestr(f"{prefix}/{d}/" if prefix else f"{d}/", b"")
    size = os.path.getsize(target)
    print(f"  {os.path.basename(target)}")
    print(f"    文件 {count} 个，原始 {total/1024/1024:.2f} MB，压缩后 {size/1024/1024:.2f} MB")
    return target


def main():
    if os.path.exists(BUILD):
        shutil.rmtree(BUILD, ignore_errors=True)
    os.makedirs(BUILD, exist_ok=True)

    print("打使用版…")
    make_zip(os.path.join(DESKTOP, "墨语-使用版.zip"), "墨语", USER_FILES, extra_dirs=["data"])

    print("\n打开发版…")
    make_zip(os.path.join(DESKTOP, "墨语-开发版.zip"), "moyu-reader", collect_dev(), extra_dirs=["data"])

    print("\n完成。两个包都在桌面。")


if __name__ == "__main__":
    main()