# Private Cloud Drive

单用户私有云盘:FastAPI 后端 + 原生 JS 前端,无数据库(文件系统即状态),通过 Nginx 反代对外提供服务。

## 功能

- 文件/文件夹上传(支持拖拽、文件夹整体上传、MD5 校验、同名冲突处理)
- 下载(单文件一次性票据、文件夹自动打包 zip)
- 预览:图片(缩放/翻页)、视频/音频(Artplayer)、文本/代码/Markdown(渲染 + 原文切换)
- 回收站(还原/永久删除)、固定常用目录、移动/重命名/搜索、限流与审计日志

## 部署

### 1. 依赖

```bash
pip install -r requirements.txt   # fastapi / uvicorn / python-multipart,Python >= 3.9
```

### 2. 运行

```bash
python main.py                    # 默认监听 127.0.0.1:8000,由 Nginx 反代对外
HOST=0.0.0.0 python main.py       # 仅本机开发调试时才对外监听
```

systemd 方式见 `cloud_drive.service`(部署到 `/opt/cloud_drive`,数据写入 `/home/cloud_drive_data`)。

### 3. Nginx 反代(要点)

```nginx
# HTTPS 入口(示例端口 12443)
server {
    listen 12443 ssl;
    server_name drive.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;

    # 覆盖而非追加 X-Forwarded-For,防止客户端伪造
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;

    location / {
        proxy_pass http://127.0.0.1:8000;
        client_max_body_size 10G;   # 与 MAX_UPLOAD_SIZE 匹配
    }
}
```

注意:应用默认只监听 `127.0.0.1`。请确认防火墙/安全组**不对外放行 8000 端口**--应用本身不做认证,安全边界在 Nginx 层(如 Basic Auth)。

### 4. 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CLOUD_DRIVE_ROOT` | Windows: `D:\Drive`;Linux: `~/cloud-drive` | 存储根目录(所有路径的基准) |
| `USER_ROOT` | = `CLOUD_DRIVE_ROOT` | 用户文件根目录,必须位于 `CLOUD_DRIVE_ROOT` 内 |
| `DRIVE_DATA_DIR` | `<root>/.system_data` | 系统数据目录(回收站/临时文件/日志/固定列表) |
| `HOST` / `PORT` | `127.0.0.1` / `8000` | 监听地址。**保持 127.0.0.1**,仅本机调试才改 0.0.0.0 |
| `BASE_PATH` | 空 | 二级路径前缀(根路径部署留空),需与 Nginx `location` 前缀一致 |
| `PUBLIC_BASE_URL` | 空 | 分享链接的公开基础 URL(**完整地址**,已含二级路径前缀;设置后不再拼接 `BASE_PATH`) |
| `TRUST_PROXY` | `false` | 是否信任 `X-Forwarded-For` 取真实 IP。仅在确认有可信反代时设 `true` |
| `ALLOWED_ORIGINS` | 空(关闭) | CORS 白名单,逗号分隔;`*` 仅限开发 |
| `MAX_UPLOAD_SIZE` | 1GB | 单文件上传上限(字节) |
| `FOLDER_DOWNLOAD_LIMIT` | 200MB | 文件夹打包下载上限(字节) |
| `TEXT_PREVIEW_LIMIT` / `IMAGE_PREVIEW_LIMIT` / `MEDIA_PREVIEW_LIMIT` | 2MB / 50MB / 500MB | 各类预览上限(字节) |
| `COPY_LINK_TTL` / `DIRECT_DOWNLOAD_TTL` | 3600s / 60s | 分享链接 / 直接下载票据有效期(秒) |
| `RATE_LIMIT_*_PER_MIN` | 见 `main.py` | 各端点每 IP 每分钟限流阈值 |
| `UPLOAD_BLOCKED_EXTS` | 内置黑名单 | 追加上传黑名单扩展名;`-` 表示清空 |


## 目录结构

```
main.py              后端(FastAPI,单文件)
index.html           页面骨架
script.js            前端逻辑(单文件)
style.css            样式
icons/               文件类型图标(按需经 /api/icon/{name} 加载)
vendor/              前端第三方库(spark-md5 / marked / DOMPurify / artplayer,本地托管)
cloud_drive.service  systemd 部署单元
plan.md              代码审查报告与修改计划
```
