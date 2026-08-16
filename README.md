# dsh-cost-meter

DSH Web GUI 底部状态栏显示 **DeepSeek 会话费用估算** 与 **账户余额** 的插件。

## 功能

在输入框下方的底部状态栏（`conversation.composer.dock` 槽位，与 live-stats 统计行同一行）显示：

```
今日 ¥11.52 (5会话) · 会话 ¥0.08 · 余额 ¥365.36
```

- **今日/会话费用**：按 deepseek-v4-flash **官方人民币定价**（峰谷自动计价：北京时间 9-12/14-18 高峰，其余空闲）估算，费用 = 输入未命中×单价 + 缓存命中×单价 + 输出×单价；
- **按会话统计**：今日费用按会话分别聚合（宿主扫描 `~/.dsh/sessions` 下 zstd 分帧会话文件），鼠标悬停可查看**每个会话的费用明细**；
- **余额**：宿主侧每 60 秒查询一次官方 `GET https://api.deepseek.com/user/balance`（带缓存），优先显示 CNY；
- **余额告警**：CNY 余额低于 `BALANCE_WARN_CNY`（默认 50）时整行变红提醒。

## 安装

```bash
dsh plugin --profile web add https://github.com/AnakinCao/dsh-cost-meter.git
# 重启 dsh web
```

或免重启手动挂载：把 `lib` + `cordis.patch.yml` 放入 `~/.dsh/profiles/web/node_modules/dsh-cost-meter/`，
并在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-cost-meter
      name: 'dsh-cost-meter'
```

刷新页面即可。

## API key 配置（余额必需）

解析顺序（任选其一，无需全部）：

1. 插件配置 `config.apiKey`（loader 条目 config）；
2. 环境变量 `DEEPSEEK_API_KEY`；
3. `~/.dsh/.credentials.yaml` 中的 `DEEPSEEK_API_KEY`（DSH 官方凭据文件，默认命中）。

未配置 key 时状态栏显示"余额 获取失败"，费用仍正常显示。

## 调整

- 单价：改 `lib/client.js` 顶部 `PRICES`（USD / 每 100 万 token）；
- 刷新间隔：环境变量 `DSH_COST_METER_REFRESH_MS` 或宿主 `config.refreshMs`（默认 60000ms）。

## 说明

- 费用为**估算**（按公开单价），实际账单以 DeepSeek 官网为准；
- 余额接口调用发生在宿主进程（API key 不出浏览器），路由 `/dsh-cost-meter/api/balance`；
- 卸载：删除 profile 补丁 insert + 删除 `node_modules/dsh-cost-meter` 目录。

## License

MIT
