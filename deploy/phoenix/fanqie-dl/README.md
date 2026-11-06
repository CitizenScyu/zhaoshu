# 番茄下载渠道（phoenix）

用户的番茄下载器（POf-L Tauri 版）按需起容器，不常驻。B 线接入见 `runtime-download/fanqie-leg.ts`。

| 文件 | 装到 |
| --- | --- |
| `fanqie-dl` | `/usr/local/bin/fanqie-dl`（手工用法见 `fanqie-dl -h`，`--update` 换最新 release） |
| `fanqie-dl-sock` | `/usr/local/bin/fanqie-dl-sock` |
| `fq_run.py`、`Dockerfile` | `/opt/fanqie-dl/` |
| `fanqie-dl.socket`、`fanqie-dl@.service` | `/etc/systemd/system/`，`systemctl enable --now fanqie-dl.socket` |

worker 是 NoNewPrivileges，sudo/docker 都用不了，所以走 socket 激活：连 `/run/fanqie-dl.sock` 发书号。
平时只有 PID1 持 socket，请求来了才起 `fanqie-dl@` 实例和容器，下载完全部退出；客户端断开即删容器。
