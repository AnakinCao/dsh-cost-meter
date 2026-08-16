# dsh-cost-meter

> English: [README.md](README.md)

DSH Web GUI 底部状态栏显示 **DeepSeek 会话费用估算** 与 **账户余额** 的插件。

## 功能

在输入框下方的底部状态栏（`conversation.composer.dock` 槽位，与 live-stats 统计行同一行）显示：

```
统计行 · TPS | Flash 空闲 0.05/1.5/4.5 · 今日 ¥11.52 (5会话) · 会话 ¥0.08 · 余额 ¥365.36
```

- **当前模型实时价格**：通过 `session.models` RPC 读取当前会话选择的模型，直接显示该模型**实时单价**（顺序：命中/未命中/输出，元/百万 token，模型名加粗）；高峰/空闲时段自动切换；**在输入框切换模型后约 2.5 秒内更新**；
- **主题化 tooltip**：悬停/聚焦弹出与当前主题一致的气泡（`--dsw-alias-tooltip-bg`），内含每会话费用明细 + **Flash/Pro 价格对照表（列对齐、模型名加粗）** + 价格来源与抓取时间；
- **今日/会话费用**：价格**实时抓取自 DeepSeek 官方定价页**（`api-docs.deepseek.com/zh-cn/quick_start/pricing`，1 小时缓存，官方改价自动跟随），同时覆盖 **deepseek-v4-flash 与 deepseek-v4-pro** 两个模型；抓取失败时回退内置价格（与官方当前一致）；
- **峰谷计价**：自动按生效日期（2026-08-17 00:00 北京时间）与峰谷时段（北京 9-12、14-18 为高峰，其余空闲）选择单价；
- **按模型计费**：宿主从会话记录（`request/header` 事件）识别每个会话实际使用的模型，按各自单价计算；
- **按会话统计**：今日费用按会话分别聚合（宿主扫描 `~/.dsh/sessions` 下 zstd 分帧会话文件），鼠标悬停可查看**每个会话的费用明细**；
- **余额**：宿主侧每 60 秒查询一次官方 `GET https://api.deepseek.com/user/balance`（带缓存），优先显示 CNY；
- **余额告警**：CNY 余额低于 `BALANCE_WARN_CNY`（默认 50）时整行变红提醒；
- **悬停核查**：tooltip 显示每会话费用明细、Flash/Pro 完整价格对照表与价格来源（官方实时抓取时间 / 内置回退）。
## 安装

### 方式一：一条命令（推荐）

```bash
dsh plugin --profile web add https://github.com/AnakinCao/dsh-cost-meter.git
# 然后重启 dsh web
```

### 方式二：免重启手动挂载

1. 把 `lib` + `cordis.patch.yml` 放入 `~/.dsh/profiles/web/node_modules/dsh-cost-meter/`；
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-cost-meter
      name: 'dsh-cost-meter'
```

3. 刷新页面即可（profile 补丁层由 HMR 热重载，无需重启）。

> ⚠️ 两种方式二选一，不要重复挂载。

## API key 配置（余额必需）

解析顺序（任选其一，无需全部）：

1. 插件配置 `config.apiKey`（loader 条目 config）；
2. 环境变量 `DEEPSEEK_API_KEY`；
3. `~/.dsh/.credentials.yaml` 中的 `DEEPSEEK_API_KEY`（DSH 官方凭据文件，默认命中）。

未配置 key 时状态栏显示"余额 获取失败"，费用仍正常显示。

## 调整参数

编辑 `lib/client.js` 顶部常量（保存后 HMR 约 0.5 秒自动生效）：

| 常量 | 默认值 | 说明 |
| --- | --- | --- |
| `FALLBACK_PRICES` | flash/pro × 旧价/空闲/高峰 | 官方抓取失败时的内置回退价（与官方当前一致） |
| `BALANCE_WARN_CNY` | `50` | 余额告警阈值（CNY），低于则整行变红 |
| `MODEL_REFRESH_MS` | `2500` | 当前模型轮询间隔（本地 RPC，开销极小） |
| `REFRESH_MS` | `60000` | 余额/今日费用/价格刷新间隔 |

环境变量：`DSH_COST_METER_REFRESH_MS`（宿主缓存刷新，默认 60000ms）。

## 实现说明

- **不消耗 token**：费用只读本地会话日志，余额/价格走官方账户与文档接口，均不触发模型推理，也不产生任何计费；
- **性能开销可忽略**：今日扫描仅处理当天修改过的会话文件（zstd 解压毫秒级），60 秒缓存共享，多标签页不重复扫描；
- 余额与价格接口调用发生在**宿主进程**（API key 不出浏览器），路由 `/dsh-cost-meter/api/balance`、`/today`、`/pricing`；
- 费用为**估算**（官方单价 × 用量），实际账单以 DeepSeek 平台为准。

## 卸载

- 方式一安装：`dsh plugin --profile web remove dsh-cost-meter`，重启 dsh web；
- 方式二安装：删除 profile 补丁 insert + 删除 `node_modules/dsh-cost-meter` 目录，刷新页面。

## License

MIT
