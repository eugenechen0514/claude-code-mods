// 純函式：朗讀文字整理、saymend CLI 的 NDJSON 解析、口頭停止指令判斷。
// 不碰 `$`，方便單獨測試。

/** 朗讀長度上限（字元）。超過就在句尾截斷，並提示其餘看畫面。 */
export const DEFAULT_MAX_CHARS = 600

const SENTENCE_END = /[。！？!?\n]/

/**
 * 把 Claude 的 markdown 回覆轉成適合 `say` 朗讀的純文字：
 * 拿掉 code block、表格、連結網址與各種標記符號。
 */
export function toSpeech(answer: string, maxChars = DEFAULT_MAX_CHARS): string {
  const text = answer
    // fenced code block（含沒收尾的）
    .replace(/```[\s\S]*?(```|$)/g, '（程式碼略）')
    // 連續的表格列收成一句
    .replace(/(^[ \t]*\|.*\|[ \t]*$\n?)+/gm, '（表格略）\n')
    // 圖片與連結只留文字
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '連結')
    // inline code 留內容
    .replace(/`([^`]*)`/g, '$1')
    // 標題、清單、引用的前綴
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/^[ \t]*\d+\.[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    // 粗體、斜體、刪除線（不動底線，避免破壞 snake_case）
    .replace(/\*\*|~~|\*/g, '')
    .replace(/^[ \t]*-{3,}[ \t]*$/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()

  if (text.length <= maxChars) {
    return text
  }

  // 找上限內最後一個句尾；太前面就直接硬切
  const head = text.slice(0, maxChars)
  let cut = -1
  for (let i = head.length - 1; i >= Math.floor(maxChars / 2); i -= 1) {
    if (SENTENCE_END.test(head[i] ?? '')) {
      cut = i + 1
      break
    }
  }

  return `${head.slice(0, cut === -1 ? maxChars : cut).trim()}\n後面的內容請看畫面。`
}

/** saymend CLI `--json` 輸出的一行（契約 v1）。 */
export type SaymendEvent = {
  v?: number
  type: string
  text?: string
  raw?: string
  state?: string
  source?: string | null
  code?: string
  message?: string
  /** 各 presence tag 目前有幾條 events 連線宣告（較新的 Saymend 才有） */
  presence?: Record<string, number>
}

/**
 * 把 spawn 一塊一塊送來的文字切成完整的行。
 * 一塊可能含多行，一行也可能跨兩塊，所以要留尾巴。
 */
export function createLineReader(): (chunk: string) => string[] {
  let rest = ''

  return chunk => {
    const lines = (rest + chunk).split('\n')
    rest = lines.pop() ?? ''

    return lines.filter(line => line.trim() !== '')
  }
}

/** 解析一行 NDJSON；不是帶 `type` 的物件就回 undefined。 */
export function parseEvent(line: string): SaymendEvent | undefined {
  try {
    const value: unknown = JSON.parse(line)
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { type?: unknown }).type === 'string'
    ) {
      return value as SaymendEvent
    }
  } catch {
    // 不是 JSON 的行（例如 CLI 的雜訊）直接略過
  }

  return undefined
}

/** 免手動迴圈中，用說的關掉迴圈：「停止語音」「結束對話」等。 */
export function isStopPhrase(text: string): boolean {
  const bare = text.replace(/[\s，。！？、,.!?]/g, '')

  return /^(請)?(停止|結束|關閉|關掉)(語音|對話|聆聽|迴圈)(模式)?$/.test(bare)
}
