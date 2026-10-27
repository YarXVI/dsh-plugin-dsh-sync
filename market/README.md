# DSH 插件索引（format 1）

在 DSH 里添加索引源，即可在「插件 → 发现」看到本插件：

1. 打开 DSH → **插件** → **发现** → 管理索引源（添加自定义索引）
2. 填入下面的 URL：

```
https://raw.githubusercontent.com/YarXVI/dsh-plugin-dsh-sync/main/market/index.json
```

3. 刷新后搜索「设备同步 / Device Sync」并安装。

> 索引条目通过 `git+https#<commit>` 安装，版本固定到具体提交，不会被上游改动影响。

## 手工安装（不经过索引）

- 下载 Release 里的 `dsh-plugin-dsh-sync-0.10.25.zip`，解压后运行 `install.cmd`；或
- 直接把本仓库 `link:` 进 `profiles/<profile>/plugins/`。
