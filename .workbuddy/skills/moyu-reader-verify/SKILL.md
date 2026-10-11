---
name: moyu-reader-verify
description: 验证墨语阅读器的改动。改完 js/、server.ps1、index.html 后跑端到端检查，并校验文件编码完整性。触发词：验证墨语、测试阅读器、moyu-reader 验证、跑一下测试、检查文件编码、改完验证一下。
---

# 墨语阅读器验证

改完代码后的标准验证流程。这个项目的坑大多在**编码**和**时序**上，
普通做法容易假失败或漏问题。

## 何时用

- 改了 `js/*.js`、`index.html`、`css/app.css`、`server.ps1`
- 改了 `lib/` 依赖版本
- 打包分发前
- 用户报「双击没反应」「导入失败」「数据丢失」

## 铁律：先查编码，再跑测试

**这一步不能省。** 编码坏了的症状是「双击启动器没反应」或
「PowerShell 报莫名其妙的语法错误」，且报错行号指向完全无关的位置。

```bash
cd <项目目录>

# server.ps1 应输出：PS_BOM=YES PS_CRLF=300
python -c "
d=open('server.ps1','rb').read()
print('PS_BOM=' + ('YES' if d[:3]==b'\xef\xbb\xbf' else 'NO'),
      'PS_CRLF=' + str(d.count(b'\r\n')))
"

# 启动器应输出：BAT_ASCII=True BAT_CRLF=29
python -c "
d=open('启动墨语.bat','rb').read()
print('BAT_ASCII=' + str(all(b<128 for b in d)),
      'BAT_CRLF=' + str(d.count(b'\r\n')))
"
```

不对就直接修，别往下走：

```bash
# 补 BOM + 转 CRLF
python -c "
d=open('server.ps1','rb').read()
if not d.startswith(b'\xef\xbb\xbf'): d=b'\xef\xbb\xbf'+d
open('server.ps1','wb').write(d.replace(b'\r\n',b'\n').replace(b'\n',b'\r\n'))
"
```

`.bat` 必须保持纯 ASCII —— 有中文就是错的，改成英文。

## 启动环境

```bash
# 后台启动服务器（不要用普通 shell 的 &，会被回收）
powershell -NoProfile -ExecutionPolicy Bypass -File server.ps1

# 调试端口启动浏览器（同样要后台保持）
msedge.exe --remote-debugging-port=9222 --user-data-dir=%TEMP%\moyu-edge http://127.0.0.1:8899/
```

确认两者都起来了：

```bash
curl -s --noproxy '*' http://127.0.0.1:8899/api/ping
curl -s --noproxy '*' http://127.0.0.1:9222/json/version | head -3
```

## 跑测试

```bash
# 本机 profile 里有 http_proxy，必须清掉，否则 Node 连不上 127.0.0.1
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY node verify.cjs
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY node verify-portable.cjs
```

环境变量：`CDP_PORT`（默认 9222）、`APP_PORT`（默认 8899）、`DATA_DIR`。

测非默认端口的实例时三个都要传：

```bash
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
  APP_PORT=8900 DATA_DIR=/path/to/instance/data node verify-portable.cjs
```

### 读懂结果

| 结果 | 含义 |
|---|---|
| 全绿 | 改动没问题 |
| 依赖库 undefined | `lib/` 缺文件 —— 依赖已本地化，不该再从 CDN 加载 |
| 书架为空但 DB 有数据 | 时序问题，`waitFor()` 等待条件可能不够 |
| `[EXCEPTION]` | 真实 bug，看堆栈第一行定位 |

**`data/` 里有旧数据**会让计数类断言失败。跑之前清空：

```bash
rm -f data/library.json && rm -rf data/books
```

## 打包分发前的额外检查

```bash
# 打包后必须解压回来对比字节，不能只看 zip 能解压
python -c "
import zipfile, hashlib, os
with zipfile.ZipFile(r'<包路径>') as z: z.extractall('<解包目录>')
for f in ['启动墨语.bat','server.ps1','js/db.js','lib/pdf.min.js']:
    a=hashlib.sha256(open(os.path.join('<项目>',f),'rb').read()).hexdigest()
    b=hashlib.sha256(open(os.path.join('<解包目录>',f),'rb').read()).hexdigest()
    print(f, '一致' if a==b else '不一致!')
"
```

然后**真的双击解压出来的启动器**，确认能起来。

## 本项目特有的坑

1. **`js/db.js` 有两套后端** —— `FILE` 与 `IDB`。改了共享逻辑要两边都改，
   否则 `file://` 打开时崩。
2. **Service Worker 会缓存旧代码** —— 测试脚本已先注销 SW 清缓存。
   手动排查时也要注意。
3. **`lib/` 是压缩产物** —— 别手工编辑，升级依赖时同步更新 `lib/LICENSE.md`。
4. **服务器不能缓存整库到内存** —— 改 `server.ps1` 的读写逻辑时注意，
   否则会出现「手动删了文件却又复活」。

## 跨平台提醒

如果是在 Mac / Linux 上开发，双击启动器不存在（那是 Windows 的 `.bat`），
且 `server.ps1` 需要 PowerShell。这类环境下只能起静态服务用 `file://`
兜底路径，此时数据走 IndexedDB。验证脚本也要相应调整。

## 排查问题的顺序

1. 先看浏览器控制台有没有 `[EXCEPTION]` —— 真实 bug 通常直接暴露
2. 再查 `/api/ping` 是否通 —— 不通说明服务器没起来或端口不对
3. 再查文件编码 —— 启动类问题九成出在这
4. 最后才怀疑逻辑