# claude-code-modes

Claude Code 的 mod（plugin）marketplace。目前收錄一個 mod：

| Mod | 說明 |
| --- | --- |
| [`saymend-voice`](./saymend-voice) | 用 Saymend 本機語音輸入，並以系統語音朗讀 Claude 的回覆 |

## 安裝

在終端機的 Claude Code session 輸入：

```
/plugin install saymend-voice --marketplace eugenechen0514/claude-code-modes
```

接著按 `y` 加入這個 marketplace，再選擇安裝範圍（user scope 會套用到之後的每個 session）。

也可以從 shell 安裝：

```
claude plugin install saymend-voice --marketplace eugenechen0514/claude-code-modes
```

在桌面版 app（`/plugin` 無法使用時）：點輸入框旁的 +，選 Plugins，用 `eugenechen0514/claude-code-modes` 新增 marketplace，再新增 plugin。

這是 private repository：只有在 GitHub 上讀得到它、而且機器上已經有 github.com git 憑證（SSH key，或 `gh auth login` 後執行 `gh auth setup-git`）的人才能安裝，安裝過程不會跳出登入提示。

## saymend-voice

把 [Saymend](https://github.com/eugenechen0514/saymend) 當成 Claude Code 的語音輸入，並用 macOS 的 `say` 朗讀回覆，組成「說話 → 送進 Claude Code → 回覆唸出來」的迴圈。

### 需求

- macOS（朗讀使用系統的 `say`）。
- Saymend.app 正在執行，而且是含本機控制介面的版本。
- `saymend` CLI 在 `PATH` 上（Saymend 的 `Scripts/make-app.sh` 會在 `~/.local/bin/saymend` 建立 symlink）。

mod 只透過 `saymend` CLI 跟 Saymend 互動，契約見 Saymend repo 的 `docs/control-interface.md`。

### 指令

| 指令 | 作用 |
| --- | --- |
| `/listen` | 聽寫一段話，說完停頓後直接送出 |
| `/listen edit` | 聽寫後只填進輸入框，不送出 |
| `/saymend off` | 關閉語音（預設） |
| `/saymend speak` | 每次回覆結束後朗讀 |
| `/saymend loop` | 朗讀後自動聆聽，說完自動送出；說「停止語音」可結束迴圈 |
| `/saymend stop` | 中斷目前的朗讀與聆聽 |
| `/saymend status` | 顯示目前的模式與設定 |
| `/saymend pause <秒>` | 停頓多久視為說完（0.5–10，預設 1.5） |
| `/saymend max <秒>` | 單段最長可以講多久（10–3600，預設 120） |
| `/saymend bargein <on\|off>` | 邊唸邊聽：朗讀時就開麥，開口即打斷（需戴耳機） |
| `/saymend polish <on\|off>` | 送出前先經 Saymend 設定的 LLM 潤飾 |
| `/saymend voice <名稱\|default>` | 指定朗讀用的系統語音 |
| `/saymend bin <路徑\|default>` | 指定 `saymend` CLI 的路徑 |

設定存在 mod 自己的 store，跨 session 保留。

### 行為說明

- 朗讀前會去掉程式碼、表格、連結網址與 markdown 標記，超過 600 字在句尾截斷。
- 使用者一開始聽寫（Saymend 熱鍵或 CLI），朗讀就會中斷。
- 聆聽期間按 Esc 會被 Saymend 接走，用來取消這次聆聽，Claude Code 收不到；按 Saymend 熱鍵則是提早定稿送出。
- 聽寫預設不做 LLM 潤飾，只有本機 ASR 加上簡轉繁與詞彙表後處理；開啟 `polish` 才會走 Saymend 設定的 provider。
- 邊唸邊聽只適合戴耳機時使用，否則喇叭的聲音會被當成有人說話。

### 開發

```
claude plugin validate saymend-voice
claude plugin test saymend-voice
```
