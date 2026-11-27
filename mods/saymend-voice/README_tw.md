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
| 額外的設定 | 無 | 在 Saymend 的「設定 › 遠端」新增主機並連線（見下方） |

```
本機   Claude Code（mod）──▶ saymend CLI ──▶ Saymend.app

遠端   Claude Code（mod）──▶ client ══ SSH ══▶ Saymend.app ──▶ 麥克風、喇叭
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

連線、安裝遠端的 client 和斷線重連都由 Saymend.app 管理，不用開終端機，Mac 也不需要另外裝東西。

需求：

- Mac：符合情境一的需求，而且 Saymend 是設定頁有「遠端」分頁的版本（0.2.0 以後）。`ssh` 要能不輸入密碼就登入那台主機（金鑰或 ssh-agent）；第一次連的主機，先在終端機 `ssh` 一次接受主機金鑰。
- 遠端主機：有 `python3`（3.8 以上），`sshd` 允許轉發（預設允許），Claude Code 已安裝這個 mod。

步驟：

1. 打開 Saymend 的「設定 › 遠端」，新增主機。可以從 `~/.ssh/config` 的主機挑，也可以手動填主機、port 和使用者。
2. 打開那台主機的連線開關，狀態會變成「已連上」。Saymend 會把 client 放到遠端的 `~/.saymend-remote/`，再建立 SSH 轉發；斷線會自動重連。
3. 連上後會顯示兩行指令，按「複製」貼到遠端的 Claude Code 執行一次（設定會留著）：

   ```
   /saymend bin /home/user/.saymend-remote/bin/saymend
   /saymend speaker /home/user/.saymend-remote/bin/say
   ```

4. 在遠端的 Claude Code 輸入 `/saymend status`，顯示 Saymend 的狀態（例如 `idle`）就表示通了。

之後要用時只要打開連線開關，也可以勾選「app 啟動時自動連線」。連線沒開的時候，遠端的 `/saymend` 會提示「連不上 Mac」。

不用了就在遠端還原設定，再到「設定 › 遠端」按「移除遠端的 client」：

```
/saymend bin default
/saymend speaker default
```

設定頁的每個選項、SSH 的細節和線上格式，見 Saymend repo 的 [docs/remote_tw.md](https://github.com/eugenechen0514/saymend/blob/main/docs/remote_tw.md)。

### 安全性

遠端連線讓遠端主機能叫你的 Mac 開麥克風和發出聲音，請先了解它的界線：

- **只連你信任的主機，而且不要用多人共用的帳號。** 連線開著的期間，遠端主機上以你的帳號執行的任何程式（以及那台主機的 root）都能請 Mac 聽寫一段話並拿到文字，也能讓 Mac 的喇叭說話。
- 聽寫一定看得見，而且看得出來源：遠端發起的聽寫，Saymend 的浮條會顯示「遠端 <主機> 聽寫中」，按 Esc 可以取消。
- Saymend 不存密碼也不存金鑰，只呼叫系統的 `ssh`，用你自己的 ssh 設定與金鑰。
- 遠端只能送固定的請求：`saymend` 的 `status`、`dictate`、`stop`、`cancel`、`events`、`--version`（參數有白名單），以及用 `say` 朗讀文字。Saymend 不會替遠端執行其他指令。
- Mac 與遠端的 socket 都只有你的帳號能連。遠端不開任何 TCP port。
- 關掉連線開關、結束 Saymend 或 SSH 斷線時，進行中的聽寫會被取消，麥克風隨即關閉。

### 已知限制

- 邊唸邊聽（`bargein`）在遠端情境還沒有實測過。它靠即時的狀態通知判斷你開口了沒，多了一趟 SSH 來回，打斷的反應可能比本機慢。
- Saymend 不會詢問密碼。你的 SSH 如果每次都要輸入密碼或驗證碼，要先設定金鑰或 ssh-agent。

## 指令

| 指令 | 作用 |
| --- | --- |
| `/listen` | 聽寫一段話，說完停頓後直接送出 |
| `/listen draft` | 聽寫後只填進輸入框當草稿，不送出 |
| `/saymend`、`/saymend listen [draft]` | 等同 `/listen [draft]`；`/saymend` 不帶參數就是聽寫並送出 |
| `/saymend off` | 關閉這個 session 的語音（預設） |
| `/saymend read` | 這個 session 每次回覆結束後朗讀 |
| `/saymend loop` | 這個 session 朗讀後自動聆聽，說完自動送出；說「停止語音」可結束迴圈 |
| `/saymend autoread <on\|off>` | 每個 session 一開始就是 `read`（預設關：新 session 從 `off` 開始） |
| `/saymend cancel` | 中斷朗讀；聆聽中則丟棄這一段，不送出（用詞同 `saymend` CLI 的 `cancel`） |
| `/saymend status` | 顯示目前的模式與設定 |
| `/saymend silence <秒>` | 說完後靜音多久視為說完（0.5–10，預設 1.5） |
| `/saymend limit <秒>` | 單段最長可以講多久（10–3600，預設 120） |
| `/saymend bargein <on\|off>` | 邊唸邊聽：朗讀時就開麥，開口即打斷（需戴耳機） |
| `/saymend polish <on\|off>` | 送出前先經 Saymend 設定的 LLM 潤飾 |
| `/saymend pin <on\|off>` | 待命時也把狀態留在狀態列（預設開；關掉後只在朗讀、聆聽或熱鍵聽寫時顯示） |
| `/saymend voice <名稱\|default>` | 指定朗讀用的系統語音（遠端情境下是 Mac 的語音） |
| `/saymend bin <路徑\|default>` | 指定 `saymend` CLI 的路徑；遠端情境指到 client |
| `/saymend speaker <指令\|default>` | 朗讀改交給這個指令；遠端情境指到 client。`default` 回到這台機器的系統語音 |

語音模式（`off`、`read`、`loop`）只在下指令的那個 session 有效：你在一個 session 開了朗讀，同時開著的其他 session 和之後新開的 session 都不會跟著唸。mod 更新後 `/reload-plugins`，這個 session 的模式還在。

想讓每個 session 都朗讀，開啟 `/saymend autoread on`：之後新開的 session 會從 `read` 開始，已經開著的其他 session 要 `/reload-plugins` 才會跟上，個別 session 仍可用 `/saymend off` 關掉。`loop` 不能設成起始模式，因為同時開著的 session 會搶同一支麥克風。

其餘設定（`autoread`、`silence`、`limit`、`bargein`、`polish`、`pin`、`voice`、`bin`、`speaker`）存在 mod 自己的 store，整台機器上的 session 共用，跨 session 保留。每台機器各存各的，所以本機和遠端的設定互不影響。

`speaker` 指令的介面和 macOS 的 `say` 相同：`<指令> [-v 語音]`，要唸的文字從 stdin 進來，朗讀被中斷時行程會被結束。

## 狀態列

待命時狀態列會留一行，格式是「Saymend 的狀態｜這個 session 的語音模式」：

```
idle｜off
idle｜read
idle｜loop｜2 sessions in loop
idle｜read｜1 other session in loop
offline｜off
unreachable｜off
```

正在做事時，這一行會換成進行中的提示，做完再換回來：

```
listening… pause when done (/saymend cancel to discard)
transcribing… (/saymend cancel to discard)
polishing… (/saymend cancel to discard)
reading reply… (/saymend cancel to stop)
reading reply… talk to interrupt (/saymend cancel)
hotkey dictation…
```

依序是：聆聽中、辨識中、潤飾中、朗讀中、邊唸邊聽時的朗讀中、你正在用 Saymend 熱鍵聽寫。

- 第一段是 Saymend 的狀態：`idle` 是待命，`offline` 是這台 Mac 的 Saymend 沒有在執行，`unreachable` 是遠端情境下連不回 Mac（遠端連線沒開或 SSH 中斷）。
- 第二段是**眼前這個 session** 的語音模式：`off` 不朗讀，`read` 朗讀，`loop` 朗讀後自動聆聽。
- 有別的 session 也開著 `loop` 時，後面會多一段數量。Saymend 一次只收一段聽寫，同時開著兩個 `loop`，你說的話只會送進先開麥的那一個，所以 `loop` 建議一次只在一個 session 開。下 `/saymend loop` 時如果已經有別的 session 開著，也會當場提醒。
- 數量由 Saymend 統計，所以本機和遠端的 session 會算在一起。這需要 Saymend 0.2.0 以後的版本；較舊的版本不顯示數量，其他功能照常。
- 非互動的 session（例如 `claude -p`）不會為了這一行去連 Saymend。
- 不想常駐就 `/saymend pin off`。

## 行為說明

- 朗讀前會去掉程式碼、表格、連結網址與 markdown 標記，超過 600 字在句尾截斷。
- 使用者一開始聽寫（Saymend 熱鍵或 CLI），朗讀就會中斷。
- 聆聽期間按 Esc 會被 Saymend 接走，用來取消這次聆聽，Claude Code 收不到；按 Saymend 熱鍵則是提早定稿送出。
- 聽寫預設不做 LLM 潤飾，只有本機 ASR 加上簡轉繁與詞彙表後處理；開啟 `polish` 才會走 Saymend 設定的 provider。
- 邊唸邊聽只適合戴耳機時使用，否則喇叭的聲音會被當成有人說話。
- `read` 或 `loop` 開著時，每則 prompt 會附一段只有 model 看得到的說明，請它不要自己執行 `say` 或其他發聲指令。這樣你自己的指示（例如 `CLAUDE.md`）要求的語音完成通知，就不會和朗讀重複。

## 開發

在 repository 根目錄執行：

```
claude plugin validate mods/saymend-voice
claude plugin test mods/saymend-voice
```
