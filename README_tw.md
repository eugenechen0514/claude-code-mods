# claude-code-mods

[English](README.md) | 繁體中文

Claude Code 的 mod（plugin）marketplace。每個 mod 放在 `mods/` 底下各自的資料夾，說明寫在該資料夾的 README。

## 收錄的 mod

| Mod | 說明 |
| --- | --- |
| [`saymend-voice`](./mods/saymend-voice/README_tw.md) | 用 Saymend 本機語音輸入，並以系統語音朗讀 Claude 的回覆 |

## 安裝

在終端機的 Claude Code session 輸入（`<mod>` 換成上表的名稱）：

```
/plugin install <mod> --marketplace eugenechen0514/claude-code-mods
```

接著按 `y` 加入這個 marketplace，再選擇安裝範圍（user scope 會套用到之後的每個 session）。

也可以從 shell 安裝：

```
claude plugin install <mod> --marketplace eugenechen0514/claude-code-mods
```

在桌面版 app（`/plugin` 無法使用時）：點輸入框旁的 +，選 Plugins，用 `eugenechen0514/claude-code-mods` 新增 marketplace，再新增 plugin。

## 新增 mod

1. 在 `mods/<mod>/` 放入 mod 的檔案與 README（英文 `README.md`、中文 `README_tw.md`）。
2. 在 `.claude-plugin/marketplace.json` 的 `plugins` 加一筆，`source` 指向 `./mods/<mod>`。
3. 在上面的表格加一列。
4. 在 repository 根目錄執行 `claude plugin validate .` 檢查。
