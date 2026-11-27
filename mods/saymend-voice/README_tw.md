# saymend-voice

[English](README.md) | 繁體中文

把 [Saymend](https://github.com/eugenechen0514/saymend) 當成 Claude Code 的語音輸入，並把回覆唸出來，組成「說話 → 送進 Claude Code → 回覆唸出來」的迴圈。

## 兩種使用情境

mod 的程式跑在 Claude Code 所在的那台機器上；麥克風、喇叭和 Saymend 則一定在你面前的 Mac。兩者是不是同一台，決定你用哪一種情境。

| | 情境一：本機 | 情境二：遠端 |
| --- | --- | --- |
| Claude Code 在哪裡 | 你的 Mac | 用 SSH 連過去的主機（Linux 也可以） |
| 聽寫 | mod 直接執行 `saymend` CLI | mod 執行遠端的 client，經 SSH 轉回 Mac 執行 `saymend` CLI |
| 朗讀 | Claude Code 用系統語音發聲 | mod 執行遠端的 client，經 SSH 轉回 Mac 用 `say` 發聲 |
| 額外要裝的東西 | 無 | Mac 上執行 `saymend-remote`（見下方） |

```
本機   Claude Code（mod）──▶ saymend CLI ──▶ Saymend.app

遠端   Claude Code（mod）──▶ client ══ SSH ══▶ saymend-remote ──▶ saymend CLI、say
       └──── 遠端主機 ────┘                └──────────── 你的 Mac ────────────┘
```

兩種情境用的是同一個 mod、同一組指令，差別只在兩個設定：`/saymend bin` 和 `/saymend speaker`。

如果你只需要「用講的把字打進遠端的 terminal」，不需要這個 mod：Saymend 的熱鍵聽寫是在 Mac 上把字打進有焦點的視窗，SSH 的 terminal 也收得到。

## 安裝

在 Claude Code 的 session 輸入（遠端情境要在**遠端那台**的 Claude Code 安裝）：

```
/plugin install saymend-voice --marketplace eugenechen0514/claude-code-mods
```

其他安裝方式見 [marketplace 的 README](../../README_tw.md)。

## 情境一：本機

需求：

- macOS。
- Saymend.app 正在執行，而且是含本機控制介面的版本。
- `saymend` CLI 在 `PATH` 上（Saymend 的 `Scripts/make-app.sh` 會在 `~/.local/bin/saymend` 建立 symlink）。

裝好 mod 就能用，不需要其他設定。mod 只透過 `saymend` CLI 跟 Saymend 互動，契約見 Saymend repo 的 `docs/control-interface.md`。

## 情境二：遠端

> 這個情境是實驗性功能。

需求：

- Mac：符合情境一的需求，另外要有 `python3`，並且能用 `ssh` 連到遠端主機。
- 遠端主機：有 `python3`（3.8 以上），`sshd` 允許轉發（預設允許），Claude Code 已安裝這個 mod。

步驟：

1. 在 Mac 取得 `saymend-remote`（單一檔案，只用 Python 標準函式庫）：

   ```
   curl -fsSL https://raw.githubusercontent.com/eugenechen0514/claude-code-mods/main/mods/saymend-voice/remote/saymend_remote.py -o ~/.local/bin/saymend-remote
   chmod +x ~/.local/bin/saymend-remote
   ```

2. 在 Mac 開一個終端機視窗執行，並讓它一直開著：

   ```
   saymend-remote connect user@host
   ```

   主機的寫法和 `ssh` 一樣，可以一次寫多台。它會把 client 放到遠端的 `~/.saymend-remote/`，再建立 SSH 轉發；斷線會自動重連。

3. 連上後它會印出兩行指令，貼到遠端的 Claude Code 執行一次（設定會留著）：

   ```
   /saymend bin /home/user/.saymend-remote/bin/saymend
   /saymend speaker /home/user/.saymend-remote/bin/say
   ```

4. 在遠端的 Claude Code 輸入 `/saymend status`，最後一行顯示 Saymend 的狀態（例如 `idle`）就表示通了。

之後每次要用，只要在 Mac 上執行第 2 步。橋接沒開的時候，遠端的 `/saymend` 會提示「連不上 Mac」。

不用了就還原設定並移除遠端的檔案：

```
/saymend bin default
/saymend speaker default
```

```
saymend-remote uninstall user@host
```

### 安全性

`saymend-remote` 讓遠端主機能叫你的 Mac 開麥克風和發出聲音，請先了解它的界線：

- **只連你信任的主機，而且不要用多人共用的帳號。** 橋接開著的期間，遠端主機上以你的帳號執行的任何程式（以及那台主機的 root）都能請 Mac 聽寫一段話並拿到文字，也能讓 Mac 的喇叭說話。
- 聽寫一定看得見：Saymend 錄音時會顯示浮條，按 Esc 可以取消。
- 橋接只接受固定的請求：`saymend` 的 `status`、`dictate`、`stop`、`cancel`、`events`、`--version`（參數有白名單），以及用 `say` 朗讀文字。它不會替遠端執行其他指令。
- Mac 與遠端的 socket 都只有你的帳號能連（權限 0600，所在資料夾 0700）。遠端不開任何 TCP port。
- 橋接視窗的紀錄只有指令名稱、朗讀字數和結束碼，不含你說的話或朗讀的內容。
- 關掉橋接（Ctrl-C）或 SSH 斷線時，進行中的聽寫會被取消，麥克風隨即關閉。

### 已知限制

- 邊唸邊聽（`bargein`）的打斷反應會多出一趟 SSH 來回的延遲。
- `saymend-remote connect` 每次連線會開三條 SSH 連線。如果你的 SSH 每次都要輸入密碼或驗證碼，建議先設定金鑰或 `ControlMaster`。

## 指令

| 指令 | 作用 |
| --- | --- |
| `/listen` | 聽寫一段話，說完停頓後直接送出 |
| `/listen edit` | 聽寫後只填進輸入框，不送出 |
| `/saymend`、`/saymend listen [edit]` | 等同 `/listen [edit]`；`/saymend` 不帶參數就是聽寫並送出 |
| `/saymend off` | 關閉語音（預設） |
| `/saymend speak` | 每次回覆結束後朗讀 |
| `/saymend loop` | 朗讀後自動聆聽，說完自動送出；說「停止語音」可結束迴圈 |
| `/saymend stop` | 中斷目前的朗讀與聆聽 |
| `/saymend status` | 顯示目前的模式與設定 |
| `/saymend pause <秒>` | 停頓多久視為說完（0.5–10，預設 1.5） |
| `/saymend max <秒>` | 單段最長可以講多久（10–3600，預設 120） |
| `/saymend bargein <on\|off>` | 邊唸邊聽：朗讀時就開麥，開口即打斷（需戴耳機） |
| `/saymend polish <on\|off>` | 送出前先經 Saymend 設定的 LLM 潤飾 |
| `/saymend pin <on\|off>` | 待命時也把 Saymend 的狀態與語音模式留在狀態列（預設關：只在朗讀、聆聽或熱鍵聽寫時顯示） |
| `/saymend voice <名稱\|default>` | 指定朗讀用的系統語音（遠端情境下是 Mac 的語音） |
| `/saymend bin <路徑\|default>` | 指定 `saymend` CLI 的路徑；遠端情境指到 client |
| `/saymend speaker <指令\|default>` | 朗讀改交給這個指令；遠端情境指到 client。`default` 回到這台機器的系統語音 |

設定存在 mod 自己的 store，跨 session 保留。每台機器各存各的，所以本機和遠端的設定互不影響。

`speaker` 指令的介面和 macOS 的 `say` 相同：`<指令> [-v 語音]`，要唸的文字從 stdin 進來，朗讀被中斷時行程會被結束。

## 行為說明

- 朗讀前會去掉程式碼、表格、連結網址與 markdown 標記，超過 600 字在句尾截斷。
- 使用者一開始聽寫（Saymend 熱鍵或 CLI），朗讀就會中斷。
- 聆聽期間按 Esc 會被 Saymend 接走，用來取消這次聆聽，Claude Code 收不到；按 Saymend 熱鍵則是提早定稿送出。
- 聽寫預設不做 LLM 潤飾，只有本機 ASR 加上簡轉繁與詞彙表後處理；開啟 `polish` 才會走 Saymend 設定的 provider。
- 邊唸邊聽只適合戴耳機時使用，否則喇叭的聲音會被當成有人說話。
- `speak` 或 `loop` 開著時，每則 prompt 會附一段只有 model 看得到的說明，請它不要自己執行 `say` 或其他發聲指令。這樣你自己的指示（例如 `CLAUDE.md`）要求的語音完成通知，就不會和朗讀重複。

## 開發

在 repository 根目錄執行：

```
claude plugin validate mods/saymend-voice
claude plugin test mods/saymend-voice
python3 -m unittest discover -s mods/saymend-voice/remote -p 'test_*.py'
```

第三行測的是 `remote/saymend_remote.py`：用假的 `saymend` 與 `say` 代替真的程式，不經 SSH，也不會開麥或發聲。
