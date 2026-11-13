# IPick

说明：**一个跑在你自己电脑 / 路由器里的「IP 优选器」。**  
你把网上现成的可用 IP 集合丢给它，它在本地逐个测速、按你定的条件筛掉差的，挑出最好用的一批，再交给你在  
Cloudflare 上部署的代理项目当订阅源用。

- 镜像：`ghcr.io/samxxmatrix/ipick-public:latest`
- 源码许可：见 [LICENSE](./LICENSE)（专有闭源，保留一切权利）

---

## 项目作用

你在 Cloudflare 上部署了代理（edgetunnel / CFNext / CFnew 之类），它们需要一个  
「IP 列表」当订阅源才能连上节点。网上能找到各种现成的可用 IP 集合，但质量参差不齐，  
盲用体验很差。

IPick 的作用：

```
你提供 IP 集合（一个 URL，或粘贴一段文本）
        │
        ▼
IPick 在本地跑多级测速（TCP → HTTP → 下载），按条件筛选
        │
        ▼
（可选）节点验活：对通过测速的 IP 做 TLS SNI + WebSocket 握手，
          确认是真节点、不是只开放了测速端口的「假可用」IP
        │
        ▼
生成 {随机名}.txt（每行 `IP:端口#落地国家 | IP`，最优的排前面）
        │
        ├─► 代理项目直接拉这个列表当订阅源
        └─► 或推到 Cloudflare KV，再由中转 Worker 分发给跨账号的代理
```

- **测速全在本地、用你自己的网络**，不依赖任何外部测速服务，所以筛出来的 IP 对你  
  自己这条线路是真的快，而不是「对别人快」。
- **定时 / 手动**都能跑；同一时刻只跑一轮，避免并发抢带宽把结果测歪。
- 配好 Cloudflare 中转后，自动同步到云端并通过中转 Worker 分发给代理项目使用。

---

## 为什么要用 macvlan，以及怎么建

### 关键点：用 macvlan 是为了「测速不走你的代理」

很多人把代理跑在同一台机器 / 同一个路由上，电脑的出网流量其实是**经过代理节点**出去的。  
如果 IPick 也在这台机器上、跟着同样的外出路由走，那它测速连的就不是「直连」，而是  
「走代理的路径」——测出来全是代理的延迟和带宽，根本不是你要优选的那条直连线路。

**macvlan 的作用**：让容器在局域网里拿到一个**独立的 IP 和 MAC**，相当于局域网里  
多了一台真实设备。可通过设置使它**不走代理配置**，于是 IPick 测的就是干干净净的直连速度。

### macvlan 怎么建（一次性）

```bash
#在docker上创建一个 macvlan 网络。下面网段按你家路由器改！
docker network create -d macvlan \
  --subnet=192.168.0.0/24 \
  --gateway=192.168.0.1 \
  -o parent=eth0 \
  macnet
```

要点：

- `--subnet` 路由器使用的网段
- `--gateway` 路由器网关。按你家的实际网段填，**别照抄**。
- `parent=eth0` 换成你docker的**物理网卡名**（Linux 用 `ip link` 看，常见 `eth0` /  
  `enp3s0`；用 Wi-Fi 的话是 `wlan0`）。填错容器起不来。
- `macnet` 网络名称

---

## 部署命令

镜像地址：`ghcr.io/samxxmatrix/ipick-public:latest`，容器**内部固定用 7700 端口**。

### 方式一：docker run

**① 默认（只用本地输出，不配中转）：**

```bash
# 前提：宿主机已按上节建好 macnet 网络、并挑好了未被占用的IP（如 192.168.0.200），从同网段另一台设备访问 http://192.168.0.200:7700
docker run -d --name ipick --restart unless-stopped \
  --network macnet --ip 192.168.0.200 \
  -p 7700:7700 \
  -v "$PWD/data":/data \
  -e ADMIN_PASSWORD=你的管理口令 \
  -e TZ=Asia/Shanghai \
  ghcr.io/samxxmatrix/ipick-public:latest
```

**② 带「中转」环境变量（把结果推到 Cloudflare KV）：**

```bash
docker run -d --name ipick --restart unless-stopped \
  --network macnet --ip 192.168.0.200 \
  -p 7700:7700 \
  -v "$PWD/data":/data \
  -e ADMIN_PASSWORD=你的管理口令 \
  -e TZ=Asia/Shanghai \
  -e PUBLIC_BASE_URL=https://你的中转域名 \
  -e RELAY_TOKEN=你的推送密钥 \
  ghcr.io/samxxmatrix/ipick-public:latest
```

> 这两项怎么拿，见下面的「中转：怎么配」。  
> `PUBLIC_BASE_URL` 是**中转 Worker 绑定的域名**，  
> `RELAY_TOKEN` 是**你自己定的**一串随机密钥。

**升级（必须重建容器）：**

`docker run` 启动的容器在创建那一刻就固定了镜像 ID，所以没有 `pull && up -d` 那种平滑升级，  
只能「拉新镜像 → 删旧容器 → 用同样的参数重新 run」。数据在宿主目录里，删容器不影响它：

```bash
# 1) 先备份（整个 data 目录通常只有几 MB）
cp -a data "data.bak-$(date +%Y%m%d)"

# 2) 拉新镜像
docker pull ghcr.io/samxxmatrix/ipick-public:latest

# 3) 删旧容器（数据在 ./data，不在容器里）
docker rm -f ipick

# 4) 用和原来完全一样的参数重新起
docker run -d --name ipick --restart unless-stopped \
  --network macnet --ip 192.168.0.200 \
  -p 7700:7700 \
  -v "$PWD/data":/data \
  -e ADMIN_PASSWORD=你的管理口令 \
  -e TZ=Asia/Shanghai \
  -e PUBLIC_BASE_URL=https://你的中转域名 \
  -e RELAY_TOKEN=你的推送密钥 \
  ghcr.io/samxxmatrix/ipick-public:latest
```

不配中转就把最后两行 `-e` 删掉。

### 方式二：docker compose

把下面这段存成 `docker-compose.yml`（放在你打算放数据的目录里），改四处值即可：口令、  
容器 IP、中转域名、推送密钥。

```yaml
services:
  ipick:
    image: ghcr.io/samxxmatrix/ipick-public:latest
    container_name: ipick
    restart: unless-stopped
    ports:
      - "7700:7700"
    volumes:
      - ./data:/data
    environment:
      - ADMIN_PASSWORD=换成一个你自己的口令
      - TZ=Asia/Shanghai
      # 中转：不用就删掉下面两行
      - PUBLIC_BASE_URL=https://你的中转域名
      - RELAY_TOKEN=你的推送密钥
    networks:
      macnet:
        # 改成你网段里没被占用的 IP
        ipv4_address: 192.168.0.200

networks:
  # 引用上一节手工创建的 macvlan 网络，compose 不负责创建
  macnet:
    external: true
```

启动：

```bash
docker compose up -d
```

- `macnet` 必须是**已经存在**的 macvlan 网络（见上面「macvlan 怎么建」）。没有的话  
  `up` 会报 `network macnet declared as external, but could not be found`。
- `ipv4_address` 要在网段内且没被其它设备占用，否则容器起不来。

**不想用 macvlan？** 删掉 `networks:` 那两段（服务和顶层各一段）即可，走默认 bridge，  
`ports` 映射照常生效，从宿主机的 `http://局域网IP:7700` 访问。测速会走本机代理，只建议调试用。

**升级**：

```bash
docker compose pull && docker compose up -d
```

---

## 环境变量

| 变量                  | 必填  | 默认              | 说明                                                     |
| ------------------- | --- | --------------- | ------------------------------------------------------ |
| `ADMIN_PASSWORD`    | 是   | 随机临时            | 管理口令；留空时启动生成随机口令打到日志，重启即换                              |
| `PUBLIC_BASE_URL`   | 中转用 | —               | 中转 Worker 绑定的域名（结尾不带斜杠，如 `https://bestip.example.com`） |
| `RELAY_TOKEN`       | 中转用 | —               | 推送密钥，**自己随机生成**；必须与 Worker 上 `RELAY_TOKEN` 完全相同        |
| `LOG_LEVEL`         | 否   | `INFO`          | 设 `DEBUG` 调试时使用                                        |
| `IPICK_TRUST_PROXY` | 否   | 关闭              | 前面确实挂了 nginx / Cloudflare Tunnel 才设 `1`                |
| `TZ`                | 否   | `Asia/Shanghai` | 影响「每天定时」的触发时刻                                          |

`PUBLIC_BASE_URL` 与 `RELAY_TOKEN` **两项齐全**才启用公网上传；缺任一项会自动降级为  
「只写本地文件」，运行照常成功。

---

## 节点验活（可选）

> 默认**关闭**。在 IP 集详情页打开「节点验活」开关即可启用；开启后「节点域名 / SNI」为必填。

很多 IP 集合里的地址「能连、能下载」，但拿去当代理节点用却连不上——它们只是开放了
测速端口，**节点本身并不接受你的 SNI / WebSocket 握手**。测速通过 ≠ 节点可用。

节点验活用一次真实握手来确认：发一个带指定 `SNI` 的 TLS ClientHello，再发
`WebSocket Upgrade` 请求，拿到 `101 Switching Protocols` 才算这个节点真的能用。
握手失败（`403` / 超时 / 连接异常）的 IP 会被剔除，不参与后面的排名与复测，但仍保留在
明细里、运行页「验活」列给出原因。

### 配置项（详情页）

| 配置          | 控件 | 默认 | 说明                                                       |
| ----------- | -- | -- | -------------------------------------------------------- |
| 节点验活       | 开关 | 关  | 总开关；关闭时不校验，行为与原版完全一致                                   |
| 节点域名 / SNI | 输入 | 空  | **开启时必填**；节点证书的 SNI / 域名，保存时前后端双重校验                       |
| WS Host    | 输入 | 空  | 留空则同 SNI                                                 |
| WS path    | 输入 | `/` | 建议与节点配置一致（多数实现不校验）                                    |
| 验活超时       | 下拉 | 8秒 | `3 / 5 / 8 / 12 / 20` 秒                                    |
| 失败重试       | 下拉 | 1次 | `0 / 1 / 2 / 3`；**只对超时 / 连接异常重试，`403` 不重试**               |


---

## 落地（出口 IP 在哪）

结果表里有一列「落地」，输出行尾也会带 `#国家名`：

```
104.16.1.2:443#日本 | 104.16.1.2
```

这里说的「国家」是**这条 IP 把你送进哪个 Cloudflare 机房**，也就是你实际的出口位置。

- 表格「落地」列显示「城市 国家」（如 `东京 日本`），鼠标悬停可看原始三字码
- 输出文件 / KV 里写 `ip:端口#国家名 | ip`；香港 / 澳门 / 台湾 / 巴勒斯坦按中文地区名写
- 三字码是 IATA 机场码，永不变；表里缺的只会是 CF 新开的机房，此时直接显示原码，不报错
- 连不上 / 握手被重置会自动补探一次；拿到 `403` 之类应答的不重试（链路本身就是通的）

映射表是 `data/colo_map.json`（344 条中英对照，首次启动自动生成）。CF 新开机房后刷新它：

```bash
docker exec ipick python /app/server/gen_colo_map.py
```

不用重建镜像，服务在跑也能直接刷；也可以自己改这个文件，服务端按修改时间自动重载。

---

## 中转：怎么配

「中转」指的是：IPick 跑完一轮，把筛好的 IP 列表推给中转 Worker，Worker 用 KV binding  
写进 Cloudflare KV；同一个 Worker 再把内容以纯文本公开出来，供其它账号下的代理项目  
当订阅源拉取。

```
IPick 容器 ──PUT /_push/ips/{slug}──> 中转 Worker ──> Cloudflare KV
          Bearer RELAY_TOKEN                 │              │
                                             │              │
代理项目（edgetunnel / CFNext / CFnew）<──── GET /ips/{slug} ┘
```

容器侧只需要两项（KV 由 Worker 绑定，容器不碰）：

1. **`PUBLIC_BASE_URL`**：中转 Worker 绑定的域名（结尾不带斜杠）。
2. **`RELAY_TOKEN`**：你自己生成的一串随机值（如 `openssl rand -base64 32` 的输出），  
   **同一个值也要填到 Worker 上**，两边必须完全一致。

### 中转 Worker（relay-worker）怎么部署

1. **目前建 KV namespace**：**Storage & databases → Workers KV → Create a KV namespace**，  
   名称随意（如 `ipick`）。所有 IP 集共用这一个，靠 key（slug）区分。
2. **建 Worker**：**Workers & Pages → Create → Worker**，把 `relay-worker/worker.mjs`  
   全文贴进编辑器，点 Deploy。
3. **绑定 KV**：Worker 页 → **Settings → Bindings → Add → KV Namespace**，  
   变量名必须填 `IP_KV`，namespace 选第 1 步建的那个。
4. **加推送密钥**：Worker 页 → **Settings → Variables and Secrets → Add**，  
   类型选 **Text**，变量名 `RELAY_TOKEN`，值填与容器完全相同的那串。
5. **绑自定义域名**：Worker 页 → **Settings → Domains & Routes → Add → Custom Domain**。  
   `*.workers.dev` 在部分网络下不稳定，建议绑自己的域名。
6. **回 IPick 页面验证**：左侧选中任意一个 IP 集进详情页，在「公网链接」那一行下面点  
   **测试连接**（未配置中转时按钮是灰的）。Worker 会写一个探针 key、读回、再删掉，  
   三步都通才算真的连上。

## data 目录里有什么

`/data`（你挂载的卷）里**只放三类东西**，其余不进这个目录、也不对外暴露：

| 路径             | 内容                           | 是否对外可读                         |
| -------------- | ---------------------------- | ------------------------------ |
| `data/db/`     | SQLite 数据库（配置、运行记录）          | 否                              |
| `data/output/` | 每轮筛出的 IP 列表（`{slug}.txt`）    | **是**（仅此目录，给代理 / 中转 Worker 拉取） |
| `data/logs/`   | 运行日志（`ipick.log`，按 5MB×3 轮转） | 否                              |
| `data/colo_map.json` | 落地机房 → 城市/国家 对照表（344 条，首次启动自动生成） | 否                        |

`colo_map.json` 决定结果表「落地」列和输出行尾 `#国家名` 的显示，刷新命令见上面
「落地（出口 IP 在哪）」一节——直接改这个文件也生效，不用重启。
