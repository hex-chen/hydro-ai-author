# hydro-ai-author

Hydro OJ（v5）插件：填一个 OpenAI 兼容的大模型接口，就能在网页上让 AI 出题、建比赛。

- **AI 出题**：给定考点/主题、难度、数据组数，AI 生成题面（Markdown，含样例）、C++ 标程、测试输入；插件把标程放进 go-judge 沙箱跑出标准输出，连同 `config.yaml` 一起写入题库。标程保存在题目附加文件 `std.cpp`。生成的题默认隐藏，人工审核后再公开。
- **AI 建比赛**：填标题、赛制、开始时间、时长，每行一个考点让 AI 出题，也可以混入已有题号，自动创建比赛。
- 任务后台执行，页面实时显示进度日志。入口：导航栏「AI 出题」，或题库页「添加题目」下拉里的「AI 出题」。需要 `PERM_CREATE_PROBLEM` 权限。

## 安装

```bash
cd ~/.hydro/addons
git clone https://github.com/hex-chen/hydro-ai-author
hydrooj addon add ~/.hydro/addons/hydro-ai-author
pm2 restart hydrooj
```

然后到 **控制面板 → 配置管理 → hydro-ai-author** 填：

| 项 | 说明 |
|---|---|
| baseUrl | 接口地址，例如 `https://api.deepseek.com/v1`、`https://api.openai.com/v1`、本地 `http://127.0.0.1:8080/v1` |
| apiKey | 密钥；本地无鉴权接口留占位符即可 |
| model | 模型名，例如 `deepseek-chat`、`gpt-4.1`、`qwen3-32b` |
| sandboxUrl | go-judge 地址，默认 `http://127.0.0.1:5050`（Hydro 自带评测沙箱就是它） |
| maxTokens | 建议 ≥ 16384，题面+标程+数据一起输出 |

## 注意

- AI 出的题**必须人工审核**：题面是否自洽、数据是否覆盖边界、标程是否正确。插件保证的是"数据输出与标程一致"，不保证标程正确。
- 测试输入由 AI 直接书写，单组控制在 4000 字符内，因此不适合需要超大输入的题；可在「其他要求」里让 AI 通过参数化输入设计题目。
- 推荐用较强的模型（DeepSeek-V3/R1、GPT-4.1、Qwen3-32B 以上），小模型出的题错误率高。
