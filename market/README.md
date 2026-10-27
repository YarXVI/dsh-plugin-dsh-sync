# DSH 插件索引（format 1）

本文件由 GitHub Pages 托管：

```
https://yarxvi.github.io/dsh-plugin-dsh-sync/market/index.json
```

## 在 DSH 里添加

1. 打开 **插件** → **实验性插件** 旁的 **更多** → 打开 **自定义插件市场**
2. **发现** → **添加索引源** → 粘贴上面的 URL
3. 搜索「设备同步 / Device Sync」→ 安装 → 重启 DSH

> 索引条目用 `git+https#<commit>` 安装，版本固定在具体提交；没有 `git` 的机器请用仓库根目录的 `bootstrap.ps1` 或 Release zip。

## 生成方式

本索引按 [插件市场手册](https://deepseek-harness.github.io/deepseek-harness/guide/plugin-market) 的 format 1 手写，
并已用 `@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex()` 校验通过。
