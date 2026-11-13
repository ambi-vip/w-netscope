# NetScope · 网络示波台

从**你本机所处的网络环境**出发,对任意 IP / 域名发起延迟与丢包测试——支持单次触发与连续监测,以示波器风格的界面实时呈现。

![stack](https://img.shields.io/badge/Node.js-%E9%9B%B6%E4%BE%9D%E8%B5%96-339933)
![license](https://img.shields.io/badge/License-MIT-ffb454)

**作者**:ambi · QQ 1277518148 · 邮箱 [ambi.vip@qq.com](mailto:ambi.vip@qq.com)

## 快速开始

**普通用户(推荐)**:安装 [Node.js](https://nodejs.org/zh-cn)(≥14,一次性,无需任何 npm 依赖)后:

- macOS 双击 `start.command`
- Windows 双击 `start.bat`(未装 Node 时启动器会用 winget 引导自动安装,失败则打开官网下载页;启动器界面为英文以防 cmd 中文乱码,网页界面仍为中文)

服务启动后**自动调用系统默认浏览器打开页面**,无需手动输入网址。完整步骤与常见问题见 **[《使用说明书》](./docs/使用说明书.md)**。

**命令行**:

```bash
cd netpulse
node server.js
```

浏览器打开 **http://127.0.0.1:8899**(端口被占用时自动向后寻找;`NETSCOPE_NO_OPEN=1` 可禁用自动开浏览器)。

## 功能

- **两种探测方式**
  - `ICMP 回显` —— 调用本机系统 `ping`,获得真实网络层往返延迟(RTT)与 TTL
  - `TCP 握手` —— 测量与目标端口的 TCP 连接建立耗时,适合禁 ping 但有开放端口(443/80 等)的服务器
- **单次测试 / 连续测试**,间隔 200ms–5s、超时 1–5s 可调;连续测试支持**定时终止**(1/5/10/30 分钟或不限时,默认 1 分钟,到时自动停止并给出摘要)
- **完整指标**:当前、平均、最小、最大、抖动(jitter)、P95、丢包率、样本数
- **距离感知的质量评估**:识别目标 IP 归属地并与本机出口计算物理距离,以"该距离的理论往返延迟"为基准评分——测美国 IP 时 200ms 会标注为"跨域线路正常水平",不会被误判为线路差;归属地识别可一键关闭(关闭后完全离线,采用通用基准)
- **链路质量评分**(0–100):综合延迟(相对距离基准)、丢包、抖动
- **带宽测速**:经 Cloudflare 边缘节点测下载/上传带宽(4 路并行下载 + 多路上传),SSE 实时曲线,含延迟探测,可中途停止;约 15 秒完成
- **本机网络环境面板**:当前网络 IP(自动识别默认路由网卡,代理/VPN 隧道如实标注)、出口 IP、运营商(ISP)、ASN/组织、归属位置、时区、反向解析、出口类型,以及本机系统与内网 IPv4 网卡一览,支持一键导出 JSON
- **可视化**
  - 示波器风格延迟波形(刻度网格、平均线、丢包 ✕ 标记、触发脉冲)
  - 延迟分布直方图(P50 / P95 标注)
  - Three.js 粒子"信号海"背景,色调随链路质量实时变化
- **包序列日志** 与 **CSV / JSON 导出**

## 为什么需要一个本地服务?

浏览器出于安全限制无法发送 ICMP、也无法对任意 IP 做精确计时。本项目的 Node 服务(零依赖)在**你的电脑上**执行真实探测,页面通过 `fetch` 调用它:

| 接口 | 说明 |
| --- | --- |
| `GET /api/ping?host=1.1.1.1&mode=icmp` | ICMP 单次探测 |
| `GET /api/ping?host=example.com&mode=tcp&port=443` | TCP 握手计时 |
| `GET /api/geo?host=8.8.8.8` | 目标 IP 归属地(域名会先解析,私网地址直接标记) |
| `GET /api/geo` | 本机出口 IP 归属地 |
| `GET /api/network` | 本机网络全貌:出口 IP 全属性 + 系统/网卡信息 |
| `GET /api/speedtest` | 带宽测速(SSE 流式推送进度与结果) |
| `GET /api/info` | 本机环境信息 |

参数:`timeout`(300–10000ms)。主机名经过严格校验,以参数数组方式传给系统 `ping`,无命令注入风险。

## 配置

```bash
PORT=9000 node server.js       # 指定起始端口(被占用时自动顺延 20 个)
HOST=0.0.0.0 node server.js    # 允许局域网访问(他人可借你本机发起探测,慎用)
node server.js stop            # 一键停止全部实例并释放端口
```

默认只监听 `127.0.0.1`,所有数据只存在内存与浏览器里,不上报。终端退出/Ctrl+C/关窗均自动释放端口。

## 平台兼容

macOS / Linux / Windows 均可(Win/Linux 的 `ping -W` 单位差异已处理)。TCP 模式跨平台行为一致。Windows 启动器为 ASCII 英文界面,彻底规避 cmd 中文乱码问题。

## 目录

```
netpulse/
├── server.js             # 零依赖 Node 服务:静态页面 + 探测/归属地/测速 API
├── public/
│   └── index.html        # 单文件前端(UI + 图表 + Three.js 背景 + 内置使用说明)
├── start.command         # macOS 双击启动器(启动后自动打开浏览器)
├── start.bat             # Windows 双击启动器(未装 Node 时引导自动安装)
├── stop.command          # macOS 一键停止全部实例并释放端口
├── stop.bat              # Windows 一键停止
├── docs/使用说明书.md     # 面向客户的完整使用说明
├── .gitignore
├── package.json
├── LICENSE               # MIT
└── README.md
```

端口随终端退出自动释放(SIGINT/SIGTERM/SIGHUP 均已处理);残留实例可用 `node server.js stop` 或双击 `stop.command` / `stop.bat` 一键清理。

## 许可

[MIT](./LICENSE) © 2026 ambi
