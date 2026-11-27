// saymend-voice 放在 $.state 的值（只在當下的 session 有效，reload 後仍在）。

/** 語音模式：off 不做事、speak 朗讀回覆、loop 朗讀後自動聆聽並送出。 */
export type Mode = 'off' | 'speak' | 'loop'

declare module 'claude-code' {
  interface PluginState {
    'saymend-voice': {
      /** 這個 session 的語音模式；沒設過時由 `autoSpeak` 決定起始值 */
      mode: Mode
    }
  }
}
